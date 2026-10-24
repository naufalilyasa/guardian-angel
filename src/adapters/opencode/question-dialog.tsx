import { createSignal, onCleanup, For, Show } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { GuardRequestView, GuardChoice } from "./permission-view.js";
import { shouldHandleRequest } from "./session-routing.ts";
import { readAdvisorStatus } from "./ipc.ts";
import { queryAdvisor, type AdvisorIpcEntry, type AdvisorSdkClient } from "./advisor-client.ts";

export interface AdvisorPanelProps {
  /** IPC callID of the pending approval request (advisor-<callID>.json). */
  callID: string;
  ipcDir: string;
  /** SDK client from `api.client`; enables the `r` retry key. */
  client?: AdvisorSdkClient;
  model?: string;
  command: string;
  filePath?: string;
}

export interface QuestionDialogProps {
  api: TuiPluginApi;
  view: GuardRequestView;
  choices: GuardChoice[];
  onSettle: (decision: "allow" | "deny") => void;
  advisor?: AdvisorPanelProps;
}

export interface PromptSlotItem {
  req: { sessionID?: string };
  view: GuardRequestView;
  choices: GuardChoice[];
  settle: (decision: "allow" | "deny") => void;
  advisor?: AdvisorPanelProps;
}

export interface PromptSlotWrapperProps {
  api: TuiPluginApi;
  activeRequest: () => PromptSlotItem | null;
  slotProps: {
    session_id?: string;
    visible?: boolean;
    disabled?: boolean;
    on_submit?: () => void;
    ref?: (ref: any) => void;
    children?: any;
  };
}

export function PromptSlotWrapper(props: PromptSlotWrapperProps) {
  const current = () => {
    const item = props.activeRequest();
    if (!item) return null;
    const activeSessionId = props.slotProps.session_id;
    if (
      item.req.sessionID &&
      activeSessionId &&
      !shouldHandleRequest(item.req as { sessionID: string }, activeSessionId, props.api)
    ) {
      return null;
    }
    return item;
  };

  const renderPrompt = () => {
    if (typeof props.api.ui?.Prompt === "function") {
      return props.api.ui.Prompt({
        get sessionID() {
          return props.slotProps.session_id;
        },
        get visible() {
          return props.slotProps.visible;
        },
        get disabled() {
          return Boolean(current() || props.slotProps.disabled);
        },
        get onSubmit() {
          return props.slotProps.on_submit;
        },
        get ref() {
          return props.slotProps.ref;
        },
        get right() {
          return typeof props.api.ui?.Slot === "function"
            ? props.api.ui.Slot({
                name: "session_prompt_right",
                get session_id() {
                  return props.slotProps.session_id ?? "";
                },
              })
            : undefined;
        },
      });
    }
    return props.slotProps.children ?? null;
  };

  return (
    <box flexDirection="column" gap={current() ? 1 : 0}>
      <Show when={current()} fallback={<box height={0} />}>
        {(item) => (
          <QuestionDialog
            api={props.api}
            view={item().view}
            choices={item().choices}
            onSettle={item().settle}
            advisor={item().advisor}
          />
        )}
      </Show>
      {renderPrompt()}
    </box>
  );
}

const VERTICAL_BAR_BORDER = {
  vertical: "┃",
  topLeft: "",
  bottomLeft: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};

export function QuestionDialog(props: QuestionDialogProps) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [expanded, setExpanded] = createSignal(false);
  const [advisorEntry, setAdvisorEntry] = createSignal<AdvisorIpcEntry | null>(null);
  let scrollboxRef: any = null;
  let hintTextRef: any = null;
  let footerHintRef: any = null;
  let settled = false;

  // Advisor: poll advisor-<callID>.json on a 200ms timer. Non-blocking — the
  // dialog renders immediately and the badge fills in when the model answers.
  const advisorProps = () => props.advisor;
  let advisorTimer: ReturnType<typeof setInterval> | undefined;
  if (advisorProps()) {
    const a = advisorProps()!;
    const refresh = () => {
      const entry = readAdvisorStatus<AdvisorIpcEntry>(a.callID, a.ipcDir);
      if (entry) setAdvisorEntry(entry);
    };
    refresh();
    advisorTimer = setInterval(refresh, 200);
  }
  onCleanup(() => {
    if (advisorTimer) clearInterval(advisorTimer);
  });

  // `r` retries a failed advisor analysis directly through the TUI's own SDK
  // client. Only armed when the last known status is "error".
  const retryAdvisor = () => {
    const a = advisorProps();
    if (!a || !a.client) return;
    if (advisorEntry()?.status !== "error") return;
    setAdvisorEntry({ callID: a.callID, status: "loading", updatedAt: Date.now() });
    void queryAdvisor({
      client: a.client,
      command: a.command,
      filePath: a.filePath,
      model: a.model ?? advisorEntry()?.model,
    }).then((outcome) => {
      setAdvisorEntry(
        outcome.result
          ? { callID: a.callID, status: "ready", result: outcome.result, model: outcome.model, updatedAt: Date.now() }
          : { callID: a.callID, status: "error", error: outcome.error ?? "unknown advisor error", model: outcome.model, updatedAt: Date.now() },
      );
    });
  };

  const settleOnce = (decision: "allow" | "deny") => {
    if (settled) return;
    settled = true;
    props.onSettle(decision);
  };

  onCleanup(() => {
    if (!settled) {
      settleOnce("deny");
    }
  });

  const detailLines = () => props.view.detail.split("\n");
  const estimatedLines = () => {
    const lines = detailLines();
    let total = 0;
    for (const l of lines) {
      total += Math.max(1, Math.ceil(l.length / 60));
    }
    return total;
  };

  const isExpandable = () => estimatedLines() >= 4;
  const compactHeight = () => Math.min(Math.max(estimatedLines(), 1), 3);
  const expandedHeight = () => Math.min(Math.max(estimatedLines(), 6), 14);

  const toggleExpand = () => {
    if (!isExpandable()) return;
    const next = !expanded();
    setExpanded(next);
    if (scrollboxRef) {
      scrollboxRef.height = next ? expandedHeight() : compactHeight();
      scrollboxRef.maxHeight = next ? 14 : 3;
    }
    if (hintTextRef) {
      hintTextRef.content = next ? "[tab collapse]" : "[tab expand]";
    }
    if (footerHintRef) {
      footerHintRef.content = next ? "tab collapse" : "tab expand";
    }
  };

  // 1. Push "question" mode so OpenCode suspends normal transcript scroll
  // and prompt navigation bindings while this dialog is visible.
  if (typeof props.api.mode?.push === "function") {
    const popMode = props.api.mode.push("question");
    onCleanup(() => {
      popMode?.();
    });
  }

  // 2. Register keymap layer in OpenCode's keymap system with high priority.
  const hasKeymap = typeof props.api.keymap?.registerLayer === "function";
  if (hasKeymap) {
    const unregister = props.api.keymap.registerLayer({
      priority: 1000,
      mode: "question",
      commands: [
        {
          name: "guardian.up",
          title: "Select Previous Option",
          category: "Guardian Angel",
          run() {
            setSelectedIndex((i) => (i <= 0 ? props.choices.length - 1 : i - 1));
          },
        },
        {
          name: "guardian.down",
          title: "Select Next Option",
          category: "Guardian Angel",
          run() {
            setSelectedIndex((i) => (i >= props.choices.length - 1 ? 0 : i + 1));
          },
        },
        {
          name: "guardian.tab",
          title: "Toggle Command Expansion",
          category: "Guardian Angel",
          run() {
            toggleExpand();
          },
        },
        {
          name: "guardian.scroll_up",
          title: "Scroll Command Up",
          category: "Guardian Angel",
          run() {
            scrollboxRef?.scrollBy?.(-2);
          },
        },
        {
          name: "guardian.scroll_down",
          title: "Scroll Command Down",
          category: "Guardian Angel",
          run() {
            scrollboxRef?.scrollBy?.(2);
          },
        },
        {
          name: "guardian.1",
          title: "Deny Command",
          category: "Guardian Angel",
          run() {
            settleOnce(props.choices[0]?.value ?? "deny");
          },
        },
        {
          name: "guardian.2",
          title: "Allow Command",
          category: "Guardian Angel",
          run() {
            settleOnce(props.choices[1]?.value ?? "allow");
          },
        },
        {
          name: "guardian.confirm",
          title: "Confirm Selected Option",
          category: "Guardian Angel",
          run() {
            const chosen = props.choices[selectedIndex()];
            settleOnce(chosen?.value ?? "deny");
          },
        },
        {
          name: "guardian.escape",
          title: "Dismiss and Deny",
          category: "Guardian Angel",
          run() {
            settleOnce("deny");
          },
        },
        {
          name: "guardian.advisor_retry",
          title: "Retry Security Advisor",
          category: "Guardian Angel",
          run() {
            retryAdvisor();
          },
        },
      ],
      bindings: [
        { key: "up", cmd: "guardian.up" },
        { key: "k", cmd: "guardian.up" },
        { key: "down", cmd: "guardian.down" },
        { key: "j", cmd: "guardian.down" },
        { key: "tab", cmd: "guardian.tab" },
        { key: "pageup", cmd: "guardian.scroll_up" },
        { key: "pagedown", cmd: "guardian.scroll_down" },
        { key: "1", cmd: "guardian.1" },
        { key: "2", cmd: "guardian.2" },
        { key: "r", cmd: "guardian.advisor_retry" },
        { key: "return", cmd: "guardian.confirm" },
        { key: "escape", cmd: "guardian.escape" },
      ],
    });
    onCleanup(() => {
      unregister?.();
    });
  }

  const theme = () => props.api.theme?.current ?? {
    warning: "#f5a742",
    accent: "#9d7cd8",
    success: "#7fd88f",
    error: "#e06c75",
    text: "#eeeeee",
    textMuted: "#808080",
    backgroundPanel: "#141414",
    backgroundElement: "#1e1e1e",
    border: "#484848",
  };

  const BADGE = {
    low: { glyph: "🟢", label: "Safe", color: () => theme().success },
    medium: { glyph: "🟡", label: "Caution", color: () => theme().warning },
    high: { glyph: "🔴", label: "Dangerous", color: () => theme().error },
  } as const;

  // 3. Fallback direct listener on keyInput only when keymap layer is not available
  // (e.g. test environments and raw terminals).
  if (!hasKeymap) {
    const keyInput = props.api.renderer?.keyInput;
    if (keyInput) {
      const onKeyPress = (key: any) => {
        if (!key) return;
        const name = key.name ?? key.sequence;
        if (name === "up" || name === "k" || key.sequence === "\x1b[A") {
          setSelectedIndex((i) => (i <= 0 ? props.choices.length - 1 : i - 1));
          key.preventDefault?.();
          key.stopPropagation?.();
        } else if (name === "down" || name === "j" || key.sequence === "\x1b[B") {
          setSelectedIndex((i) => (i >= props.choices.length - 1 ? 0 : i + 1));
          key.preventDefault?.();
          key.stopPropagation?.();
        } else if (name === "1" || key.sequence === "1") {
          settleOnce(props.choices[0]?.value ?? "deny");
          key.preventDefault?.();
          key.stopPropagation?.();
        } else if (name === "2" || key.sequence === "2") {
          if (props.choices.length > 1) {
            settleOnce(props.choices[1]?.value ?? "allow");
            key.preventDefault?.();
            key.stopPropagation?.();
          }
        } else if (name === "tab" || key.sequence === "\t") {
          toggleExpand();
          key.preventDefault?.();
          key.stopPropagation?.();
        } else if (name === "pageup" || (key.shift && (name === "up" || key.sequence === "\x1b[1;2A"))) {
          scrollboxRef?.scrollBy?.(-2);
          key.preventDefault?.();
          key.stopPropagation?.();
        } else if (name === "pagedown" || (key.shift && (name === "down" || key.sequence === "\x1b[1;2B"))) {
          scrollboxRef?.scrollBy?.(2);
          key.preventDefault?.();
          key.stopPropagation?.();
        } else if (name === "return" || name === "enter" || key.sequence === "\r" || key.sequence === "\n") {
          const chosen = props.choices[selectedIndex()];
          settleOnce(chosen?.value ?? "deny");
          key.preventDefault?.();
          key.stopPropagation?.();
        } else if (name === "escape" || key.sequence === "\x1b") {
          settleOnce("deny");
          key.preventDefault?.();
          key.stopPropagation?.();
        } else if (name === "r" || key.sequence === "r") {
          retryAdvisor();
          key.preventDefault?.();
          key.stopPropagation?.();
        }
      };

      keyInput.on("keypress", onKeyPress);
      onCleanup(() => {
        keyInput.off("keypress", onKeyPress);
      });
    }
  }

  return (
    <box
      flexDirection="column"
      border={["left"]}
      customBorderChars={VERTICAL_BAR_BORDER}
      borderColor={theme().warning}
      backgroundColor={theme().backgroundPanel}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      {/* Header Row: Title & ESC label */}
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().warning}>△</text>
          <text fg={theme().text} attributes={1 /* BOLD */}>
            {props.view.header}
          </text>
        </box>
        <text fg={theme().textMuted} onMouseUp={() => props.onSettle("deny")}>
          esc
        </text>
      </box>

      {/* Question prompt */}
      <box paddingTop={0}>
        <text fg={theme().text}>{props.view.question}</text>
      </box>

      {/* Command / Target detail */}
      <box paddingLeft={2} flexDirection="column" gap={0}>
        <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <text fg={theme().textMuted}>{props.view.toolLabel}:</text>
          <Show
            when={isExpandable()}
            fallback={<box width={0} height={0} />}
          >
            <box
              onMouseUp={() => toggleExpand()}
              flexShrink={0}
            >
              <text
                ref={(el: any) => {
                  hintTextRef = el;
                }}
                fg={theme().warning}
              >
                {expanded() ? "[tab collapse]" : "[tab expand]"}
              </text>
            </box>
          </Show>
        </box>
        <scrollbox
          ref={(el: any) => {
            scrollboxRef = el;
          }}
          height={expanded() ? expandedHeight() : compactHeight()}
          maxHeight={expanded() ? 14 : 3}
          scrollY={true}
          scrollX={false}
        >
          <text fg={theme().text}>{props.view.detail}</text>
        </scrollbox>
      </box>

      {/* Reason block */}
      <box paddingLeft={2} flexDirection="column">
        <text fg={theme().textMuted}>Why:</text>
        <text fg={theme().text}>{props.view.reason}</text>
      </box>

      {/* LLM Security Advisor card (non-blocking; omits when no advisor configured) */}
      <Show when={advisorProps()} fallback={<box width={0} height={0} />}>
        <box paddingLeft={2} flexDirection="column" gap={0}>
          <Show
            when={advisorEntry()?.status === "ready" ? advisorEntry()?.result : undefined}
            fallback={
              <Show
                when={advisorEntry()?.status === "error"}
                fallback={
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().textMuted}>Advisor:</text>
                    <text fg={theme().textMuted}>analyzing…</text>
                  </box>
                }
              >
                <box flexDirection="row" gap={1}>
                  <text fg={theme().error}>Advisor:</text>
                  <text fg={theme().error}>
                    {advisorEntry()?.error ?? "error"} — press r to retry
                  </text>
                </box>
              </Show>
            }
          >
            {(result) => {
              const res = result();
              const badge = BADGE[res.riskLevel];
              return (
                <box flexDirection="column" gap={0}>
                  <box flexDirection="row" gap={1}>
                    <text fg={badge.color()} attributes={1 /* BOLD */}>
                      {badge.glyph} {badge.label}
                    </text>
                    <text fg={theme().textMuted}>
                      {res.isReversible ? "reversible" : "irreversible"}
                    </text>
                  </box>
                  <text fg={theme().text}>{res.summary}</text>
                  <Show when={res.affectedResources.length > 0}>
                    <text fg={theme().textMuted}>
                      {"touches: " + res.affectedResources.slice(0, 3).join(", ")}
                    </text>
                  </Show>
                </box>
              );
            }}
          </Show>
        </box>
      </Show>

      {/* Numbered Choices List (no search box!) */}
      <box flexDirection="column" gap={1} paddingTop={1}>
        <For each={props.choices}>
          {(choice, idx) => {
            const isSelected = () => selectedIndex() === idx();
            return (
              <box
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isSelected() ? theme().backgroundElement : undefined}
                onMouseOver={() => setSelectedIndex(idx())}
                onMouseUp={() => settleOnce(choice.value)}
              >
                <box flexDirection="row" gap={1}>
                  <text
                    fg={isSelected() ? theme().warning : theme().textMuted}
                    attributes={isSelected() ? 1 : undefined}
                  >
                    {idx() + 1}.
                  </text>
                  <text
                    fg={isSelected() ? theme().warning : theme().text}
                    attributes={isSelected() ? 1 : undefined}
                  >
                    {choice.label.replace(/^\d+\.\s*/, "")}
                  </text>
                </box>
                <box paddingLeft={3}>
                  <text fg={theme().textMuted}>{choice.description}</text>
                </box>
              </box>
            );
          }}
        </For>
      </box>

      {/* Footer Toolbar */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingTop={1}
        flexShrink={0}
        backgroundColor={theme().backgroundElement}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" gap={2}>
          <text fg={theme().text}>
            ↑↓ <span style={{ fg: theme().textMuted }}>select</span>
          </text>
          <text fg={theme().text}>
            enter <span style={{ fg: theme().textMuted }}>confirm</span>
          </text>
          <Show
            when={isExpandable()}
            fallback={<box width={0} height={0} />}
          >
            <box flexShrink={0}>
              <text
                ref={(el: any) => {
                  footerHintRef = el;
                }}
                fg={theme().text}
              >
                tab {expanded() ? "collapse" : "expand"}
              </text>
            </box>
          </Show>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={theme().text}>
            1-2 <span style={{ fg: theme().textMuted }}>select</span>
          </text>
          <text fg={theme().text}>
            esc <span style={{ fg: theme().textMuted }}>dismiss</span>
          </text>
        </box>
      </box>
    </box>
  );
}
