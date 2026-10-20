import type { GuardDeps, GuardResult, Scope, Tier, ToolCall } from "./types.ts";
import { classify } from "./classifier.ts";
import { classifySql } from "./sql.ts";
import { matchRule } from "./policy.ts";
import { extractPath, resolveLexical } from "./paths.ts";
import { scopeKey } from "./approvals.ts";

const DESTRUCTIVE_FALLBACK =
  /(\brm\s+(-{1,2}[a-zA-Z-]+\s+)*[^-\s]|\bshred\b|\bmkfs\b|\bdd\b[^\n]*of=\/dev\/|\bfind\b[^\n]*-delete\b|\bDROP\s|\bTRUNCATE\s|\bALTER\s|\bcurl\b[^\n]*\|\s*(sh|bash)|\bwget\b[^\n]*\|\s*(sh|bash)|:\s*\(\s*\)\s*\{)/i;

const SEVERITY: Record<Tier, number> = { allow: 0, ask: 1, block: 2 };

function scopeFor(call: ToolCall, deps: GuardDeps, ruleId: string): Scope {
  const rawPath = extractPath(call.input);
  const scopePath =
    typeof rawPath === "string" && rawPath.length > 0
      ? resolveLexical(deps.workspace, rawPath)
      : deps.workspace;

  return {
    workspace: deps.workspace,
    sessionId: deps.sessionId,
    scopePath,
    ruleId,
  };
}

/**
 * Derive the approval identity from the verdict. A missing `ruleId` would
 * collapse every ask into one shared key, so fall back to the reason text —
 * still per-rule, never per-workspace.
 */
function ruleIdOf(result: GuardResult): string {
  return result.ruleId ?? `ask:${result.reason ?? "unknown"}`;
}

/**
 * Stable identity for a user-supplied policy rule. Used as the approval scope
 * discriminator so that approving one rule never approves another.
 */
function policyRuleId(rule: { match: Record<string, string | undefined>; tier: Tier }): string {
  const parts = [rule.match.tool, rule.match.command, rule.match.path].map((v) => v ?? "*");
  return `policy:${parts.join("\0")}:${rule.tier}`;
}

function applyNonBashPolicy(
  base: GuardResult,
  call: ToolCall,
  resolvedPath: string | undefined,
  deps: GuardDeps,
): GuardResult {
  if (!resolvedPath) return base;
  const pathMatch = matchRule(deps.policy.rules, {
    tool: call.toolName,
    path: resolvedPath,
  });
  if (!pathMatch) return base;

  const verdict =
    SEVERITY[pathMatch.tier] > SEVERITY[base.verdict] ? pathMatch.tier : base.verdict;
  const result: GuardResult = {
    verdict,
    reason: verdict === base.verdict ? base.reason : (pathMatch.reason ?? `policy tier ${pathMatch.tier}`),
    ruleId: verdict === base.verdict ? base.ruleId : policyRuleId(pathMatch),
  };
  if (base.replacement) result.replacement = base.replacement;
  return result;
}

function applyBashPolicy(
  base: GuardResult,
  command: string,
  resolvedPath: string | undefined,
  deps: GuardDeps,
): GuardResult {
  const policyMatch = matchRule(deps.policy.rules, {
    tool: "bash",
    command,
    path: resolvedPath,
  });
  const sql = classifySql(command);

  let verdict = base.verdict;
  let reason = base.reason;
  let ruleId = base.ruleId;

  if (policyMatch?.source === "global") {
    // Global policy may override builtin blocks (e.g. rm -rf /*), but never protected store blocks
    if (base.ruleId?.startsWith("block:protected") || base.ruleId === "block:cd-protected") {
      verdict = base.verdict;
      reason = base.reason;
      ruleId = base.ruleId;
    } else {
      verdict = policyMatch.tier;
      reason = policyMatch.reason ?? `policy tier ${policyMatch.tier} (global)`;
      ruleId = policyRuleId(policyMatch);
    }
  } else {
    if (policyMatch && SEVERITY[policyMatch.tier] > SEVERITY[verdict]) {
      verdict = policyMatch.tier;
      reason = policyMatch.reason ?? `policy tier ${policyMatch.tier}`;
      ruleId = policyRuleId(policyMatch);
    }
    if (sql && SEVERITY[sql.verdict] > SEVERITY[verdict]) {
      verdict = sql.verdict;
      reason = sql.reason ?? reason;
      ruleId = `sql:${sql.verdict}`;
    }
  }

  if (verdict === base.verdict && verdict === "allow" && base.replacement) {
    return base;
  }

  const result: GuardResult = { verdict, reason };
  if (ruleId !== undefined) result.ruleId = ruleId;
  if (base.replacement) result.replacement = base.replacement;
  return result;
}

function classifyWithPolicy(call: ToolCall, deps: GuardDeps): GuardResult {
  const base = classify({ call, workspace: deps.workspace });
  const rawPath = extractPath(call.input);
  const resolvedPath =
    typeof rawPath === "string" && rawPath.length > 0
      ? resolveLexical(deps.workspace, rawPath)
      : undefined;

  if (call.toolName !== "bash") {
    return applyNonBashPolicy(base, call, resolvedPath, deps);
  }

  const command = call.input.command;
  if (typeof command !== "string") return base;
  return applyBashPolicy(base, command, resolvedPath, deps);
}

function handleClassifierError(call: ToolCall, deps: GuardDeps, error: unknown): GuardResult {
  const command = typeof call.input?.command === "string" ? call.input.command : "";
  const destructive = DESTRUCTIVE_FALLBACK.test(command);
  const tier: Tier = destructive ? "block" : "allow";
  const reason = `classifier_error: ${(error as Error).message}`;

  deps.audit.append({
    ts: new Date(deps.now()).toISOString(),
    sessionId: deps.sessionId,
    tool: call.toolName,
    tier: "classifier_error",
    reason,
    command,
  });

  return {
    verdict: tier,
    reason: destructive ? `${reason} (fail-closed: pola destruktif)` : `${reason} (fail-open)`,
  };
}

function handleCachedApproval(
  call: ToolCall,
  deps: GuardDeps,
  result: GuardResult,
  scope: Scope,
  command: string | undefined,
  now: number,
): GuardResult {
  deps.audit.append({
    ts: new Date(now).toISOString(),
    sessionId: deps.sessionId,
    tool: call.toolName,
    tier: "ask",
    reason: `approval sudah ada untuk Scope ini: ${result.reason ?? "ask"}`,
    scopeKey: scopeKey(scope),
    command,
  });
  const cached: GuardResult = {
    verdict: "allow",
    reason: "approval sudah ada untuk Scope ini",
    ruleId: scope.ruleId,
  };
  if (result.replacement) cached.replacement = result.replacement;
  return cached;
}

async function promptAndRecordApproval(
  call: ToolCall,
  deps: GuardDeps,
  result: GuardResult,
  scope: Scope,
  command: string | undefined,
  now: number,
): Promise<GuardResult> {
  const reply = await deps.confirm(
    "guardian-angel",
    result.reason ?? "Tool call ini memerlukan persetujuan. Lanjutkan?",
  );

  // Accept both the legacy boolean and the richer object form so adapters can
  // report *why* they denied without every call site changing at once.
  const approved = typeof reply === "boolean" ? reply : reply.approved;
  const denialReason =
    typeof reply === "boolean" ? "ditolak oleh user" : (reply.denialReason ?? "ditolak oleh user");

  if (!approved) {
    const denied: GuardResult = { verdict: "block", reason: denialReason, ruleId: scope.ruleId };
    deps.audit.append({
      ts: new Date(now).toISOString(),
      sessionId: deps.sessionId,
      tool: call.toolName,
      tier: "block",
      reason: denialReason,
      scopeKey: scopeKey(scope),
      command,
    });
    return denied;
  }

  deps.approvals.grant(scope, now, result.reason);
  deps.audit.append({
    ts: new Date(now).toISOString(),
    sessionId: deps.sessionId,
    tool: call.toolName,
    tier: "ask",
    reason: result.reason,
    scopeKey: scopeKey(scope),
    command,
  });
  const granted: GuardResult = {
    verdict: "allow",
    reason: "disetujui user",
    ruleId: scope.ruleId,
  };
  if (result.replacement) granted.replacement = result.replacement;
  return granted;
}

async function handleAskVerdict(
  call: ToolCall,
  deps: GuardDeps,
  result: GuardResult,
  now: number,
): Promise<GuardResult> {
  const scope = scopeFor(call, deps, ruleIdOf(result));
  const command = typeof call.input.command === "string" ? call.input.command : undefined;

  if (deps.approvals.check(scope, now)) {
    return handleCachedApproval(call, deps, result, scope, command, now);
  }

  return promptAndRecordApproval(call, deps, result, scope, command, now);
}

/**
 * Main guard dispatcher: evaluates policy, prompts for approval if needed,
 * records audit entries, and manages cached 24h approvals.
 *
 * @param call - The tool call to guard
 * @param deps - Runtime dependencies (policy, approvals, audit, confirm UI)
 * @returns GuardResult with final verdict and optional rewrite replacement
 */
export async function guard(
  call: ToolCall,
  deps: GuardDeps,
): Promise<GuardResult> {
  let result: GuardResult;

  try {
    result = classifyWithPolicy(call, deps);
  } catch (error) {
    return handleClassifierError(call, deps, error);
  }

  const now = deps.now();

  if (result.verdict === "block") {
    deps.audit.append({
      ts: new Date(now).toISOString(),
      sessionId: deps.sessionId,
      tool: call.toolName,
      tier: "block",
      reason: result.reason,
      command: typeof call.input.command === "string" ? call.input.command : undefined,
    });
    return result;
  }

  if (result.verdict === "ask") {
    return handleAskVerdict(call, deps, result, now);
  }

  if (result.replacement) {
    deps.audit.append({
      ts: new Date(now).toISOString(),
      sessionId: deps.sessionId,
      tool: call.toolName,
      tier: "rewrite",
      reason: result.reason,
      command: typeof call.input.command === "string" ? call.input.command : undefined,
    });
  }

  return result;
}
