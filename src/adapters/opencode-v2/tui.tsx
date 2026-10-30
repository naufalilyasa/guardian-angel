/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, Show } from "solid-js";
import {
  cleanupCall,
  getWorkspaceIpcDir,
  listPendingRequests,
  removeHeartbeat,
  writeHeartbeat,
  writeResponse,
} from "../opencode/ipc.ts";
import type { IpcRequest } from "../opencode/types.ts";
import { describeGuardRequest, guardChoices, renderGuardBody } from "../opencode/permission-view.ts";
import { notifyDesktop } from "../opencode/notification.ts";
import { QuestionDialog, type PromptSlotItem } from "../opencode/question-dialog.tsx";
import { shouldHandleRequest } from "../opencode/session-routing.ts";

export type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

/**
 * Extract active session ID from the current v2 TUI route.
 */
export function getActiveSessionIdV2(context: TuiContext): string | undefined {
  try {
    const current = context.ui?.router?.current?.();
    if (current && (current as any).type === "session" && typeof (current as any).sessionID === "string") {
      return (current as any).sessionID;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Check whether a pending IPC request belongs to the currently active session (or its children) in v2.
 */
export function shouldHandleRequestV2(
  req: { sessionID: string },
  activeSessionId: string | undefined,
  context?: TuiContext,
): boolean {
  return shouldHandleRequest(
    req,
    activeSessionId,
    undefined,
    context?.data?.session?.get,
  );
}

export function createApiShim(context: TuiContext) {
  return {
    mode: {
      push: (mode: string) => {
        if (typeof context.keymap?.mode?.push === "function") {
          return context.keymap.mode.push(mode);
        }
        return () => {};
      },
    },
    keymap: {
      registerLayer: (opts: any) => {
        if (typeof context.keymap?.layer === "function") {
          const commandMap = new Map<string, any>();
          for (const c of opts.commands ?? []) {
            commandMap.set(c.name, {
              id: c.name,
              title: c.title,
              group: c.category,
              run: c.run,
            });
          }
          for (const b of opts.bindings ?? []) {
            const existing = commandMap.get(b.cmd);
            if (existing) {
              existing.bind = existing.bind ? `${existing.bind},${b.key}` : b.key;
            }
          }
          context.keymap.layer(() => ({
            mode: opts.mode,
            priority: opts.priority,
            commands: Array.from(commandMap.values()),
          }));
        }
        return () => {};
      },
    },
    renderer: context.renderer,
    theme: {
      get current() {
        return {
          warning: (context.theme as any)?.feedback?.warning?.base ?? "#f5a742",
          accent: (context.theme as any)?.syntax?.keyword ?? "#9d7cd8",
          success: (context.theme as any)?.feedback?.success?.base ?? "#7fd88f",
          error: (context.theme as any)?.feedback?.error?.base ?? "#e06c75",
          text: (context.theme as any)?.text?.base ?? "#eeeeee",
          textMuted: (context.theme as any)?.text?.muted ?? "#808080",
          backgroundPanel: (context.theme as any)?.background?.raised?.base ?? "#141414",
          backgroundElement: (context.theme as any)?.background?.raised?.high ?? "#1e1e1e",
          border: (context.theme as any)?.border?.base ?? "#484848",
        };
      },
    },
    client: context.client,
    ui: context.ui,
  };
}

export const GuardianAngelTuiV2 = Plugin.define({
  id: "guardian-angel",
  setup(context: TuiContext) {
    const opts = (context as any).options ?? {};
    const workspace =
      (opts.workspace as string | undefined) ??
      (context.location as any)?.directory ??
      context.data?.location?.default?.()?.directory ??
      process.env.GA_WORKSPACE ??
      process.cwd();
    const ipcDir = (opts.ipcDir as string) ?? getWorkspaceIpcDir(workspace);

    // R3: mirror the daemon-side startup log so hash mismatches are visible
    try {
      console.log(`[guardian-angel] tui setup workspace=${workspace} ipcDir=${ipcDir}`);
    } catch {}

    // 1. Initial heartbeat and renewal loop
    try {
      writeHeartbeat(ipcDir);
    } catch {}
    const heartbeatTimer = setInterval(() => {
      try {
        writeHeartbeat(ipcDir);
      } catch {}
    }, 2000);

    // 2. Queue, dialog state, and slot registration
    const queue: IpcRequest[] = [];
    const processedCallIds = new Set<string>();
    let showingDialog = false;

    const [activeRequest, setActiveRequest] = createSignal<PromptSlotItem | null>(null);
    const apiShim = createApiShim(context);

    if (typeof context.ui?.slot === "function") {
      context.ui.slot({
        append: "session.composer.top",
        render: ({ sessionID }: { sessionID?: string }) => {
          return (
            <Show when={activeRequest()}>
              {(item) => {
                if (
                  item().req.sessionID &&
                  sessionID &&
                  !shouldHandleRequestV2(item().req as { sessionID: string }, sessionID, context)
                ) {
                  return null;
                }
                return (
                  <QuestionDialog
                    api={apiShim as any}
                    view={item().view}
                    choices={item().choices}
                    onSettle={item().settle}
                    advisor={item().advisor}
                  />
                );
              }}
            </Show>
          );
        },
      });
    }

    const processNext = (): void => {
      if (showingDialog || queue.length === 0) return;

      const req = queue.shift();
      if (!req) return;

      const now = Date.now();
      if (req.deadline > 0 && now >= req.deadline) {
        cleanupCall(req.callID, ipcDir);
        processNext();
        return;
      }

      showingDialog = true;
      let settled = false;

      const settle = (decision: "allow" | "deny"): void => {
        if (settled) return;
        settled = true;
        writeResponse(req.callID, decision, ipcDir, req.nonce);
        showingDialog = false;
        setActiveRequest(null);
        try {
          context.ui?.dialog?.clear();
        } catch {}
        processNext();
      };

      try {
        const subagent = context.data?.session?.get?.(req.sessionID) as
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

        if (context.attention?.notify) {
          context.attention
            .notify({
              title: view.header,
              message: `${view.toolLabel}: ${view.detail}`,
              sound: { name: "question" },
            } as any)
            .catch(() => {});
        }

        // Inline slot rendering via session.composer.top
        if (typeof context.ui?.slot === "function" && context.renderer) {
          setActiveRequest({
            req,
            view,
            choices,
            settle,
            advisor: {
              callID: req.callID,
              ipcDir,
              client: context.client as never,
              command: req.command ?? `${req.tool} ${req.path ?? ""}`.trim(),
              filePath: req.path,
            },
          });
          return;
        }

        // Fallback dialog when slot or renderer is absent
        if (typeof context.ui?.dialog?.show === "function") {
          try {
            context.ui.dialog.set({ size: "large" } as any);
          } catch {}

          context.ui.dialog.show(
            () => (
              <QuestionDialog
                api={apiShim as any}
                view={view}
                choices={choices}
                onSettle={settle}
              />
            ),
            () => settle("deny"),
          );
        } else if (typeof (context.ui?.dialog as any)?.confirm === "function") {
          void (context.ui.dialog as any)
            .confirm({
              title: view.header,
              message: body,
            })
            .then((res: boolean | undefined) => settle(res ? "allow" : "deny"))
            .catch(() => settle("deny"));
        } else {
          settle("deny");
        }
      } catch {
        settle("deny");
      }
    };

    // 3. Polling for incoming requests
    const pollTimer = setInterval(() => {
      const activeSessionId = getActiveSessionIdV2(context);
      const pending = listPendingRequests(ipcDir);
      for (const req of pending) {
        if (!shouldHandleRequestV2(req, activeSessionId, context)) continue;
        if (!processedCallIds.has(req.callID)) {
          if (processedCallIds.size > 1000) {
            const oldestKey = processedCallIds.values().next().value;
            if (oldestKey) processedCallIds.delete(oldestKey);
          }
          processedCallIds.add(req.callID);
          queue.push(req);
        }
      }
      processNext();
    }, 200);

    return () => {
      clearInterval(heartbeatTimer);
      clearInterval(pollTimer);
      try {
        removeHeartbeat(ipcDir);
      } catch {}
    };
  },
});

export default GuardianAngelTuiV2;
