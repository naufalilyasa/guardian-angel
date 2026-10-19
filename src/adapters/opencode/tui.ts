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

    try {
      const details = req.command ?? req.path ?? "(tidak ada teks tambahan)";
      api.ui.dialog.replace(() => {
        return api.ui.DialogConfirm({
          title: `guardian-angel: ${req.ruleId}`,
          message: `${req.reason}\n\n[${req.tool}]: ${details}`,
          onConfirm: () => {
            writeResponse(req.callID, "allow", ipcDir, req.nonce);
            api.ui.dialog.clear();
            showingDialog = false;
            processNext();
          },
          onCancel: () => {
            writeResponse(req.callID, "deny", ipcDir, req.nonce);
            api.ui.dialog.clear();
            showingDialog = false;
            processNext();
          },
        });
      });
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

export default { tui: GuardianAngelTui };
