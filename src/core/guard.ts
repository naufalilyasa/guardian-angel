import type { GuardDeps, GuardResult, Scope, Tier, ToolCall } from "./types.ts";
import { classify } from "./classifier.ts";
import { classifySql } from "./sql.ts";
import { matchRule } from "./policy.ts";
import { resolveLexical } from "./paths.ts";
import { scopeKey } from "./approvals.ts";

const DESTRUCTIVE_FALLBACK =
  /(\brm\s+(-{1,2}[a-zA-Z-]+\s+)*[^-\s]|\bshred\b|\bmkfs\b|\bdd\b[^\n]*of=\/dev\/|\bfind\b[^\n]*-delete\b|\bDROP\s|\bTRUNCATE\s|\bALTER\s|\bcurl\b[^\n]*\|\s*(sh|bash)|\bwget\b[^\n]*\|\s*(sh|bash)|:\s*\(\s*\)\s*\{)/i;

const SEVERITY: Record<Tier, number> = { allow: 0, ask: 1, block: 2 };

function worst(a: Tier, b: Tier): Tier {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function scopeFor(call: ToolCall, deps: GuardDeps): Scope {
  const rawPath = call.input.path;
  const scopePath =
    typeof rawPath === "string" && rawPath.length > 0
      ? resolveLexical(deps.workspace, rawPath)
      : deps.workspace;

  return {
    workspace: deps.workspace,
    sessionId: deps.sessionId,
    scopePath,
  };
}

function classifyWithPolicy(call: ToolCall, deps: GuardDeps): GuardResult {
  const base = classify({ call, workspace: deps.workspace, policy: deps.policy });

  if (call.toolName !== "bash") return base;
  const command = call.input.command;
  if (typeof command !== "string") return base;

  const policyMatch = matchRule(deps.policy.rules, { tool: "bash", command });
  const sql = classifySql(command);

  let verdict = base.verdict;
  let reason = base.reason;

  if (policyMatch?.source === "global") {
    verdict = policyMatch.tier;
    reason = policyMatch.reason ?? `policy tier ${policyMatch.tier} (global)`;
  } else {
    if (policyMatch) {
      if (SEVERITY[policyMatch.tier] > SEVERITY[verdict]) {
        verdict = policyMatch.tier;
        reason = policyMatch.reason ?? `policy tier ${policyMatch.tier}`;
      }
    }

    if (sql) {
      if (SEVERITY[sql.verdict] > SEVERITY[verdict]) {
        verdict = sql.verdict;
        reason = sql.reason ?? reason;
      }
    }
  }

  if (verdict === base.verdict && verdict === "allow" && base.replacement) {
    return base;
  }

  const result: GuardResult = { verdict, reason };
  if (base.replacement) result.replacement = base.replacement;
  return result;
}

export async function guard(
  call: ToolCall,
  deps: GuardDeps,
): Promise<GuardResult> {
  let result: GuardResult;

  try {
    result = classifyWithPolicy(call, deps);
  } catch (error) {
    const command = typeof call.input.command === "string" ? call.input.command : "";
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
    const scope = scopeFor(call, deps);
    if (deps.approvals.check(scope, now)) {
      return result.replacement
        ? { verdict: "allow", reason: "approval sudah ada untuk Scope ini", replacement: result.replacement }
        : { verdict: "allow", reason: "approval sudah ada untuk Scope ini" };
    }

    const approved = await deps.confirm(
      "guardian-angel",
      result.reason ?? "Tool call ini memerlukan persetujuan. Lanjutkan?",
    );

    if (!approved) {
      const denied = { verdict: "block" as Tier, reason: "ditolak oleh user" };
      deps.audit.append({
        ts: new Date(now).toISOString(),
        sessionId: deps.sessionId,
        tool: call.toolName,
        tier: "block",
        reason: denied.reason,
        scopeKey: scopeKey(scope),
        command: typeof call.input.command === "string" ? call.input.command : undefined,
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
      command: typeof call.input.command === "string" ? call.input.command : undefined,
    });
    return result.replacement
      ? { verdict: "allow", reason: "disetujui user", replacement: result.replacement }
      : { verdict: "allow", reason: "disetujui user" };
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
