import { createSignal, onCleanup, For, Show } from "solid-js";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { GuardRequestView, GuardChoice } from "./permission-view.js";

export interface QuestionDialogProps {
  api: TuiPluginApi;
  view: GuardRequestView;
  choices: GuardChoice[];
  onSettle: (decision: "allow" | "deny") => void;
}

export interface PromptSlotItem {
  req: { sessionID?: string };
  view: GuardRequestView;
  choices: GuardChoice[];
  settle: (decision: "allow" | "deny") => void;
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
    if (
      item.req.sessionID &&
      props.slotProps.session_id &&
      item.req.sessionID !== props.slotProps.session_id
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

  const theme = () => props.api.theme?.current ?? {
    warning: "#f5a742",
    accent: "#9d7cd8",
    text: "#eeeeee",
    textMuted: "#808080",
    backgroundPanel: "#141414",
    backgroundElement: "#1e1e1e",
    border: "#484848",
  };

  const keyInput = props.api.renderer?.keyInput;
  if (keyInput) {
    const onKeyPress = (key: any) => {
      if (!key) return;
      const name = key.name;
      if (name === "up" || name === "k") {
        setSelectedIndex((i) => (i <= 0 ? props.choices.length - 1 : i - 1));
        key.preventDefault?.();
        key.stopPropagation?.();
      } else if (name === "down" || name === "j") {
        setSelectedIndex((i) => (i >= props.choices.length - 1 ? 0 : i + 1));
        key.preventDefault?.();
        key.stopPropagation?.();
      } else if (name === "1") {
        props.onSettle(props.choices[0]?.value ?? "deny");
        key.preventDefault?.();
        key.stopPropagation?.();
      } else if (name === "2" && props.choices.length > 1) {
        props.onSettle(props.choices[1]?.value ?? "allow");
        key.preventDefault?.();
        key.stopPropagation?.();
      } else if (name === "return") {
        const chosen = props.choices[selectedIndex()];
        props.onSettle(chosen?.value ?? "deny");
        key.preventDefault?.();
        key.stopPropagation?.();
      } else if (name === "escape") {
        props.onSettle("deny");
        key.preventDefault?.();
        key.stopPropagation?.();
      }
    };

    keyInput.on("keypress", onKeyPress);
    onCleanup(() => {
      keyInput.off("keypress", onKeyPress);
    });
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
      <box paddingLeft={2} flexDirection="column">
        <text fg={theme().textMuted}>{props.view.toolLabel}:</text>
        <text fg={theme().text}>{props.view.detail}</text>
      </box>

      {/* Reason block */}
      <box paddingLeft={2} flexDirection="column">
        <text fg={theme().textMuted}>Why:</text>
        <text fg={theme().text}>{props.view.reason}</text>
      </box>

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
                onMouseUp={() => props.onSettle(choice.value)}
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
