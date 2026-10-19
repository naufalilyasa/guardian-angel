import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@code-yeongyu/senpi";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { guard } from "../core/guard.ts";
import { BUILTIN_RULES, loadPolicyFromFiles } from "../core/policy.ts";
import { createApprovalStore } from "../core/approvals.ts";
import { createAuditSink } from "../core/audit.ts";
import { ensureStore } from "../core/store.ts";
import type { GuardResult, ToolCall } from "../core/types.ts";

const GUARDED_TOOLS = new Set(["bash", "write", "edit"]);

/**
 * Per-process fallback when the harness cannot provide a session id. A shared
 * constant would make every session reuse the same approvals.
 */
const FALLBACK_SESSION_ID = `ga-${randomUUID()}`;

/** `ensureStore` only needs to run once per workspace per process. */
const preparedWorkspaces = new Set<string>();

export function toToolCall(event: ToolCallEvent): ToolCall | null {
  if (!GUARDED_TOOLS.has(event.toolName)) return null;
  return {
    toolName: event.toolName as ToolCall["toolName"],
    input: event.input as Record<string, unknown>,
  };
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderReplacement(replacement: { path: string }, pkgRoot: string): string {
  return `bun run ${shellQuote(resolve(pkgRoot, "src/cli/ga.ts"))} trash ${shellQuote(replacement.path)}`;
}

export type AdapterDeps = {
  pkgRoot: string;
  guardFn?: typeof guard;
  loadPolicy?: typeof loadPolicyFromFiles;
};

function resolveSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId() || FALLBACK_SESSION_ID;
  } catch {
    return FALLBACK_SESSION_ID;
  }
}

function resolvePolicy(loadPolicy: typeof loadPolicyFromFiles, workspace: string) {
  try {
    return loadPolicy({ workspace });
  } catch {
    return {
      rules: [...BUILTIN_RULES],
      warnings: ["policy load failed; falling back to builtin rules"],
    };
  }
}

function initSenpiWorkspace(workspace: string): void {
  if (preparedWorkspaces.has(workspace)) return;
  try {
    ensureStore(workspace);
    preparedWorkspaces.add(workspace);
  } catch {
    // A store we cannot prepare must not break the tool call; the audit
    // sink still fails loudly on its own if the store is unusable.
  }
}

export function createHandler(deps: AdapterDeps) {
  const guardFn = deps.guardFn ?? guard;
  const loadPolicy = deps.loadPolicy ?? loadPolicyFromFiles;

  return async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> => {
    const call = toToolCall(event);
    if (!call) return undefined;

    const workspace = ctx.cwd;
    const sessionId = resolveSessionId(ctx);
    const policy = resolvePolicy(loadPolicy, workspace);
    initSenpiWorkspace(workspace);

    const result: GuardResult = await guardFn(call, {
      workspace,
      sessionId,
      policy,
      approvals: createApprovalStore({ workspace }),
      audit: createAuditSink(workspace),
      now: () => Date.now(),
      confirm: async (title: string, message: string): Promise<boolean> => {
        if (!ctx.hasUI) return false;
        return ctx.ui.confirm(title, message);
      },
    });

    if (result.verdict === "block") {
      return { block: true, reason: result.reason ?? "diblokir oleh guardian-angel" };
    }

    if (result.replacement && event.toolName === "bash") {
      // In-place rewrite of command payload per Senpi extension contract (ADR 0006).
      // The mutated event.input is executed by the Senpi tool runner.
      event.input.command = renderReplacement(result.replacement, deps.pkgRoot);
    }

    return undefined;
  };
}

export default function activate(pi: ExtensionAPI): void {
  const handler = createHandler({ pkgRoot: resolve(import.meta.dir, "../..") });
  pi.on("tool_call", handler);
}
