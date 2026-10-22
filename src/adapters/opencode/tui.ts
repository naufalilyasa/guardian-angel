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
import { notifyDesktop } from "./notification.ts";
import {
  QuestionDialog,
  PromptSlotWrapper,
  type PromptSlotItem,
} from "./question-dialog.tsx";
import { createSignal } from "solid-js";

export { getActiveSessionId, shouldHandleRequest } from "./session-routing.ts";
import { getActiveSessionId, shouldHandleRequest } from "./session-routing.ts";

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

  // 2. Request queue, slot registration, and dialog management
  const queue: IpcRequest[] = [];
  const processedCallIds = new Set<string>();
  let showingDialog = false;

  const [activeRequest, setActiveRequest] = createSignal<PromptSlotItem | null>(null);

  if (typeof api.slots?.register === "function") {
    api.slots.register({
      order: 10,
      slots: {
        session_prompt(_ctx: any, slotProps: any) {
          return PromptSlotWrapper({
            api,
            activeRequest,
            slotProps,
          });
        },
      },
    });
  }

  const processNext = (): void => {
    if (showingDialog || queue.length === 0) return;

    const req = queue.shift();
    if (!req) return;

    const now = Date.now();
    if (req.deadline > 0 && now >= req.deadline) {
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
      setActiveRequest(null);
      try {
        api.ui?.dialog?.clear();
      } catch {
        // ignore
      }
      processNext();
    };

    try {
      const subagent = api.state?.session?.get?.(req.sessionID) as
        | { title?: string; parentID?: string }
        | undefined;
      const subagentTitle = subagent?.parentID && subagent.title ? subagent.title : undefined;
      const view = describeGuardRequest(
        subagentTitle ? { ...req, reason: `${req.reason} [${subagentTitle}]` } : req,
      );
      const choices = guardChoices();
      const body = renderGuardBody(view);

      notifyDesktop({
        title: view.header,
        message: `${view.toolLabel}: ${view.detail}`,
      });

      if (api.attention?.notify) {
        api.attention
          .notify({
            title: view.header,
            message: `${view.toolLabel}: ${view.detail}`,
            sound: { name: "question" },
          })
          .catch(() => {});
      }

      // If plugin slots are available and renderer is active, render inline
      // directly above the prompt chip/field with NO modal overlay and full content width.
      if (typeof api.slots?.register === "function" && api.renderer) {
        setActiveRequest({
          req,
          view,
          choices,
          settle,
        });
        return;
      }

      try {
        api.ui?.dialog?.setSize("large");
      } catch {
        // ignore
      }

      api.ui.dialog.replace(
        () => {
          // In full OpenCode TUI, render the native question-style dialog
          // using OpenTUI Solid with no search box and direct keyboard navigation.
          if (api.renderer) {
            return QuestionDialog({
              api,
              view,
              choices,
              onSettle: settle,
            });
          }
          if (typeof api.ui?.DialogSelect === "function") {
            return api.ui.DialogSelect({
              title: `${view.header}\n\n${body}`,
              renderFilter: false,
              skipFilter: true,
              options: choices.map((choice) => ({
                title: choice.label,
                value: choice.value,
                description: choice.description,
                onSelect: () => settle(choice.value),
              })),
              onSelect: (opt: unknown) => {
                const val = (opt as { value?: string })?.value;
                settle(val === "allow" ? "allow" : "deny");
              },
            } as any);
          }
          return api.ui.DialogConfirm({
            title: view.header,
            message: body,
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
      setActiveRequest(null);
      cleanupCall(req.callID, ipcDir);
      processNext();
    }
  };

  // 3. Polling for incoming requests
  const pollTimer = setInterval(() => {
    const activeSessionId = getActiveSessionId(api);
    const pending = listPendingRequests(ipcDir);
    for (const req of pending) {
      if (!shouldHandleRequest(req, activeSessionId, api)) continue;
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
