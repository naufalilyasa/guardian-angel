import type { TuiPlugin, TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import type { PluginOptions } from "@opencode-ai/plugin";
import {
  cleanupCall,
  getWorkspaceIpcDir,
  listPendingRequests,
  removeHeartbeat,
  writeHeartbeat,
  writeResponse,
} from "./ipc.ts";
import type { IpcRequest } from "./types.ts";
import { describeGuardRequest, guardChoices, renderGuardBody } from "./permission-view.ts";

export function getActiveSessionId(api: Partial<TuiPluginApi>): string | undefined {
  const current = api.route?.current;
  if (
    current &&
    current.name === "session" &&
    typeof (current as { params?: { sessionID?: unknown } }).params?.sessionID === "string"
  ) {
    return (current as { params: { sessionID: string } }).params.sessionID;
  }
  return undefined;
}

export function shouldHandleRequest(
  req: { sessionID: string },
  activeSessionId: string | undefined,
): boolean {
  if (!activeSessionId) return true;
  return req.sessionID === activeSessionId;
}

export const GuardianAngelTui: TuiPlugin = async (
  api: TuiPluginApi,
  options: PluginOptions | undefined,
  _meta: TuiPluginMeta,
): Promise<void> => {
  const workspace =
    (options?.workspace as string | undefined) ??
    api.state?.path?.directory ??
    api.state?.path?.worktree ??
    process.env.GA_WORKSPACE;
  const ipcDir = (options?.ipcDir as string) ?? getWorkspaceIpcDir(workspace);

  // 1. Initial heartbeat and periodic renewal
  writeHeartbeat(ipcDir);
  const heartbeatTimer = setInterval(() => {
    writeHeartbeat(ipcDir);
  }, 2000);

  // 2. Request queue and dialog management
  const queue: IpcRequest[] = [];
  const processedCallIds = new Set<string>();
  let showingDialog = false;

  const processNext = (): void => {
    if (showingDialog || queue.length === 0) return;

    const req = queue.shift();
    if (!req) return;

    const now = Date.now();
    if (now >= req.deadline) {
      // Already timed out; discard
      cleanupCall(req.callID, ipcDir);
      processNext();
      return;
    }

    showingDialog = true;
    let settled = false;

    // Settle exactly once: the first of confirm/cancel/onClose wins. Later
    // signals (e.g. the onClose fired by our own dialog.clear()) are ignored,
    // so an allow response can never be overwritten by a late deny.
    const settle = (decision: "allow" | "deny"): void => {
      if (settled) return;
      settled = true;
      writeResponse(req.callID, decision, ipcDir, req.nonce);
      showingDialog = false;
      try {
        api.ui.dialog.clear();
      } catch {
        // ignore
      }
      processNext();
    };

    try {
      const view = describeGuardRequest(req);
      const choices = guardChoices();

      api.ui.dialog.replace(
        () => {
          // Mirror OpenCode's native `question` tool: a short header, the full
          // question as the prompt, and choices that each carry a description.
          // DialogSelect is the closest public primitive — it renders an option
          // list with per-choice descriptions, exactly like the question tool.
          if (typeof api.ui.DialogSelect === "function") {
            return api.ui.DialogSelect({
              title: view.header,
              placeholder: `${view.toolLabel}: ${view.detail}`,
              options: choices.map((choice) => ({
                title: choice.label,
                value: choice.value,
                description: choice.description,
                onSelect: () => settle(choice.value),
              })),
              onSelect: (opt) => {
                const val = (opt as { value?: string })?.value;
                settle(val === "allow" ? "allow" : "deny");
              },
            });
          }
          return api.ui.DialogConfirm({
            title: view.header,
            message: renderGuardBody(view),
            onConfirm: () => settle("allow"),
            onCancel: () => settle("deny"),
          });
        },
        // ESC, backdrop click, or any programmatic close means "no answer" —
        // fail closed with an explicit deny instead of letting the server time
        // out and mislabel it as a user denial.
        () => settle("deny"),
      );
    } catch {
      showingDialog = false;
      cleanupCall(req.callID, ipcDir);
      processNext();
    }
  };

  // 3. Polling for incoming requests
  const pollTimer = setInterval(() => {
    const activeSessionId = getActiveSessionId(api);
    const pending = listPendingRequests(ipcDir);
    for (const req of pending) {
      if (!shouldHandleRequest(req, activeSessionId)) continue;
      if (!processedCallIds.has(req.callID)) {
        if (processedCallIds.size > 1000) processedCallIds.clear();
        processedCallIds.add(req.callID);
        queue.push(req);
      }
    }
    if (!showingDialog && queue.length > 0) {
      processNext();
    }
  }, 200);

  // 4. Cleanup on plugin disposal
  api.lifecycle.onDispose(() => {
    clearInterval(heartbeatTimer);
    clearInterval(pollTimer);
    removeHeartbeat(ipcDir);
  });
};

export default {
  id: "guardian-angel",
  tui: GuardianAngelTui,
};
