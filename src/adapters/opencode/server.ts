import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { resolve } from "node:path";
import { guard } from "../../core/guard.ts";
import { BUILTIN_RULES, loadPolicyFromFiles } from "../../core/policy.ts";
import { createApprovalStore } from "../../core/approvals.ts";
import { createAuditSink } from "../../core/audit.ts";
import { ensureStore } from "../../core/store.ts";
import type {
  ConfirmDenialReason,
  ConfirmResult,
  GuardDeps,
  GuardResult,
  ToolCall,
} from "../../core/types.ts";
import {
  cleanupCall,
  cleanupStale,
  getWorkspaceIpcDir,
  isTuiActive,
  waitForResponse,
  writeRequest,
} from "./ipc.ts";
import type { IpcRequest } from "./types.ts";

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderReplacement(replacement: { path: string }, pkgRoot: string): string {
  return `bun run ${shellQuote(resolve(pkgRoot, "src/cli/ga.ts"))} trash ${shellQuote(replacement.path)}`;
}

export function toToolCall(tool: string, args: Record<string, unknown>): ToolCall | null {
  if (tool === "bash") {
    if (typeof args?.command !== "string") return null;
    return {
      toolName: "bash",
      input: { command: args.command },
    };
  }

  if (tool === "write") {
    return {
      toolName: "write",
      input: {
        filePath: typeof args?.filePath === "string" ? args.filePath : undefined,
        content: typeof args?.content === "string" ? args.content : "",
      },
    };
  }

  if (tool === "edit") {
    return {
      toolName: "edit",
      input: {
        filePath: typeof args?.filePath === "string" ? args.filePath : undefined,
        oldString: typeof args?.oldString === "string" ? args.oldString : "",
        newString: typeof args?.newString === "string" ? args.newString : "",
      },
    };
  }

  if (tool === "patch") {
    return {
      toolName: "patch",
      input: {
        filePath: typeof args?.filePath === "string" ? args.filePath : undefined,
        patch: typeof args?.patch === "string" ? args.patch : "",
      },
    };
  }

  return null;
}

const preparedWorkspaces = new Set<string>();

/**
 * Cache recent denials (command or file) to prevent repeated popups when an agent
 * automatically retries a failed tool call. TTL is 30 seconds by default.
 */
const recentDenials = new Map<string, number>();

export function getDenialKey(sessionId: string, tool: string, args: Record<string, unknown>): string {
  const target = String(args?.command ?? args?.filePath ?? "");
  return `${sessionId}:${tool}:${target}`;
}

export function isRecentlyDenied(key: string, now = Date.now()): boolean {
  const expiresAt = recentDenials.get(key);
  if (!expiresAt) return false;
  if (now > expiresAt) {
    recentDenials.delete(key);
    return false;
  }
  return true;
}

export function recordDenial(key: string, ttlMs = 30_000, now = Date.now()): void {
  recentDenials.set(key, now + ttlMs);
}

export function clearDenialCache(): void {
  recentDenials.clear();
}

export type ServerHandlerDeps = {
  workspace: string;
  pkgRoot: string;
  ipcDir?: string;
  confirmTimeoutMs?: number;
  guardFn?: typeof guard;
  loadPolicy?: typeof loadPolicyFromFiles;
  now?: () => number;
};

function loadEffectivePolicy(loadPolicy: typeof loadPolicyFromFiles, workspace: string) {
  try {
    return loadPolicy({ workspace });
  } catch {
    return {
      rules: [...BUILTIN_RULES],
      warnings: ["policy load failed; falling back to builtin rules"],
    };
  }
}

async function requestTuiApproval(
  ipcDir: string,
  input: { tool: string; sessionID: string; callID: string },
  args: Record<string, unknown> | undefined,
  title: string,
  message: string,
  cacheKey: string,
  timeoutMs: number,
  nowFn: () => number,
): Promise<{ approved: boolean; denialReason?: ConfirmDenialReason }> {
  const deadline = nowFn() + timeoutMs;
  const req: IpcRequest = {
    callID: input.callID,
    sessionID: input.sessionID,
    tool: input.tool,
    command: typeof args?.command === "string" ? args.command : undefined,
    path: typeof args?.filePath === "string" ? args.filePath : undefined,
    reason: message,
    ruleId: title,
    createdAt: nowFn(),
    deadline,
  };

  try {
    const nonce = writeRequest(req, ipcDir);
    const response = await waitForResponse(input.callID, deadline, ipcDir, 150, nonce);

    if (!response) {
      recordDenial(cacheKey, 30_000, nowFn());
      return { approved: false, denialReason: "approval timeout" };
    }
    if (response.decision !== "allow") {
      recordDenial(cacheKey, 30_000, nowFn());
      return { approved: false, denialReason: "denied by the user" };
    }
    return { approved: true };
  } finally {
    cleanupCall(input.callID, ipcDir);
  }
}

function initWorkspaceStore(workspace: string, ipcDir: string): void {
  if (!preparedWorkspaces.has(workspace)) {
    try {
      ensureStore(workspace);
      preparedWorkspaces.add(workspace);
    } catch {
      // non-fatal
    }
  }
  cleanupStale(ipcDir);
}

function handleGuardVerdict(
  result: GuardResult,
  isHeadlessNoTui: boolean,
  lastAskReason: string | undefined,
  input: { tool: string },
  output: { args: Record<string, unknown> },
  pkgRoot: string,
): void {
  if (result.verdict === "block") {
    if (isHeadlessNoTui) {
      throw new Error(
        `[guardian-angel] ${lastAskReason ?? result.reason} (requires approval, but the TUI is not running)`,
      );
    }
    throw new Error(`[guardian-angel] ${result.reason ?? "perintah is blocked"}`);
  }

  if (result.replacement && input.tool === "bash" && output?.args) {
    output.args.command = renderReplacement(result.replacement, pkgRoot);
  }
}

async function executeHookLogic(
  deps: ServerHandlerDeps,
  input: { tool: string; sessionID: string; callID: string },
  output: { args: Record<string, unknown> },
): Promise<void> {
  const call = toToolCall(input.tool, output?.args);
  if (!call) return;

  const nowFn = deps.now ?? Date.now;
  const timeoutMs = deps.confirmTimeoutMs ?? 60_000;
  const ipcDir = deps.ipcDir ?? getWorkspaceIpcDir(deps.workspace);
  const workspace = deps.workspace;
  const sessionId = input.sessionID || "unknown-session";
  const cacheKey = getDenialKey(sessionId, input.tool, output?.args);

  if (isRecentlyDenied(cacheKey, nowFn())) {
    throw new Error(
      `[guardian-angel] this command was just denied by the user (automatic retry suppressed)`,
    );
  }

  const policy = loadEffectivePolicy(deps.loadPolicy ?? loadPolicyFromFiles, workspace);
  initWorkspaceStore(workspace, ipcDir);

  let isHeadlessNoTui = false;
  let lastAskReason: string | undefined;

  const guardDeps: GuardDeps = {
    workspace,
    sessionId,
    policy,
    approvals: createApprovalStore({ workspace }),
    audit: createAuditSink(workspace),
    now: nowFn,
    confirm: async (title: string, message: string): Promise<ConfirmResult> => {
      lastAskReason = message;
      if (!isTuiActive(ipcDir)) {
        isHeadlessNoTui = true;
        return { approved: false, denialReason: "TUI is not running" };
      }
      return requestTuiApproval(
        ipcDir,
        input,
        output?.args,
        title,
        message,
        cacheKey,
        timeoutMs,
        nowFn,
      );
    },
  };

  const guardFn = deps.guardFn ?? guard;
  const result: GuardResult = await guardFn(call, guardDeps);
  handleGuardVerdict(result, isHeadlessNoTui, lastAskReason, input, output, deps.pkgRoot);
}

export function createHookHandler(deps: ServerHandlerDeps) {
  return (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: Record<string, unknown> },
  ): Promise<void> => executeHookLogic(deps, input, output);
}

export const GuardianAngelServer: Plugin = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<Hooks> => {
  const pkgRoot = (options?.pkgRoot as string) ?? resolve(import.meta.dir, "../../..");
  const workspace = input.directory || process.cwd();
  const handler = createHookHandler({
    workspace,
    pkgRoot,
    ipcDir: options?.ipcDir as string | undefined,
    confirmTimeoutMs: (options?.confirmTimeoutMs as number) ?? 60_000,
  });

  return {
    "tool.execute.before": handler,
  };
};

export default GuardianAngelServer;
