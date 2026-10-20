import type { TuiPlugin, TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import type { PluginOptions } from "@opencode-ai/plugin";
import {
  cleanupCall,
  getDefaultIpcDir,
  listPendingRequests,
  removeHeartbeat,
  writeHeartbeat,
  writeResponse,
} from "./ipc.ts";
import type { IpcRequest } from "./types.ts";

export const GuardianAngelTui: TuiPlugin = async (
  api: TuiPluginApi,
  options: PluginOptions | undefined,
  _meta: TuiPluginMeta,
): Promise<void> => {
  const ipcDir = (options?.ipcDir as string) ?? getDefaultIpcDir();

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
      const details = req.command ?? req.path ?? "(tidak ada teks tambahan)";
      api.ui.dialog.replace(
        () => {
          return api.ui.DialogConfirm({
            title: `guardian-angel: ${req.ruleId}`,
            message: `${req.reason}\n\n[${req.tool}]: ${details}`,
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
    const pending = listPendingRequests(ipcDir);
    for (const req of pending) {
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
