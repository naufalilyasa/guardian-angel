import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@code-yeongyu/senpi";
import { resolve } from "node:path";
import { guard } from "../core/guard.ts";
import { loadPolicyFromFiles } from "../core/policy.ts";
import { createApprovalStore } from "../core/approvals.ts";
import { createAuditSink } from "../core/audit.ts";
import { ensureStore } from "../core/store.ts";
import type { GuardResult, ToolCall } from "../core/types.ts";

const GUARDED_TOOLS = new Set(["bash", "write", "edit"]);

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
    let sessionId = "unknown-session";
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch {
      sessionId = "unknown-session";
    }

    let policy;
    try {
      policy = loadPolicy({ workspace });
    } catch {
      policy = { rules: [], warnings: ["policy load failed"] };
    }

    ensureStore(workspace);

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
      event.input.command = renderReplacement(result.replacement, deps.pkgRoot);
    }

    return undefined;
  };
}

export default function activate(pi: ExtensionAPI): void {
  const handler = createHandler({ pkgRoot: resolve(import.meta.dir, "../..") });
  pi.on("tool_call", handler);
}
