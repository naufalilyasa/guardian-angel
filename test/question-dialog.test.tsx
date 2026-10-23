import { describe, expect, test } from "bun:test";
import { render } from "@opentui/solid";
import { createTestRenderer } from "@opentui/core/testing";
import {
  QuestionDialog,
  PromptSlotWrapper,
  type PromptSlotItem,
} from "../src/adapters/opencode/question-dialog.js";
import { describeGuardRequest, guardChoices } from "../src/adapters/opencode/permission-view.js";

describe("QuestionDialog Component (OpenTUI Solid)", () => {
  test("renders native question-style dialog without search box", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    let settledDecision: "allow" | "deny" | null = null;

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const req = {
      ruleId: "ask:git-push",
      reason: "pushing code to remote repository requires user approval",
      tool: "bash",
      command: "git push origin main --force-with-lease",
    };

    const view = describeGuardRequest(req);
    const choices = guardChoices();

    try {
      await render(
        () => (
          <QuestionDialog
            api={mockApi}
            view={view}
            choices={choices}
            onSettle={(decision) => {
              settledDecision = decision;
            }}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      const frame = setup.captureCharFrame();

      // Check header and question
      expect(frame).toContain("Guardian Angel: git-push");
      expect(frame).toContain("Allow Guardian Angel to run this shell command?");
      expect(frame).toContain("Command:");
      expect(frame).toContain("git push origin main --force-with-lease");
      expect(frame).toContain("Why:");
      expect(frame).toContain("pushing code to remote repository requires user approval");

      // Check choices
      expect(frame).toContain("1. Deny");
      expect(frame).toContain("Block this command (safe default, ESC also denies)");
      expect(frame).toContain("2. Allow");
      expect(frame).toContain("Execute now and remember approval for 24 hours");

      // Ensure NO search input box!
      expect(frame).not.toContain("Search");

      // Check footer toolbar hints
      expect(frame).toContain("select");
      expect(frame).toContain("confirm");
      expect(frame).toContain("dismiss");

      // Test keypress '2' -> should immediately settle 'allow'
      setup.mockInput.pressKey("2");
      expect(settledDecision as string | null).toBe("allow");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("handles arrow navigation and enter confirmation", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    let settledDecision: "allow" | "deny" | null = null;

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const req = {
      ruleId: "ask:rm-outside",
      reason: "deleting file outside workspace",
      tool: "bash",
      command: "rm -rf /outside/dir",
    };

    const view = describeGuardRequest(req);
    const choices = guardChoices();

    try {
      await render(
        () => (
          <QuestionDialog
            api={mockApi}
            view={view}
            choices={choices}
            onSettle={(decision) => {
              settledDecision = decision;
            }}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();

      // Down arrow -> moves to option 2 (Allow)
      setup.mockInput.pressArrow("down");
      await setup.renderOnce();

      // Enter -> settles selected option ('allow')
      setup.mockInput.pressEnter();
      expect(settledDecision as string | null).toBe("allow");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("escape key dismisses and settles deny", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    let settledDecision: "allow" | "deny" | null = null;

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const req = {
      ruleId: "ask:write-outside",
      reason: "writing outside workspace",
      tool: "write",
      path: "/tmp/foo.txt",
    };

    const view = describeGuardRequest(req);
    const choices = guardChoices();

    try {
      await render(
        () => (
          <QuestionDialog
            api={mockApi}
            view={view}
            choices={choices}
            onSettle={(decision) => {
              settledDecision = decision;
            }}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();

      // Escape -> settles 'deny'
      setup.renderer.keyInput.emit("keypress", { name: "escape" } as any);
      expect(settledDecision as string | null).toBe("deny");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("PromptSlotWrapper renders child only when no active request", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    try {
      await render(
        () => (
          <PromptSlotWrapper
            api={mockApi}
            activeRequest={() => null}
            slotProps={{
              session_id: "ses-1",
              children: <box><text>[PROMPT CHIP FIELD]</text></box>,
            }}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("[PROMPT CHIP FIELD]");
      expect(frame).not.toContain("Guardian Angel:");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("PromptSlotWrapper renders dialog directly above prompt without overlay", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    let settledDecision: string | null = null;

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const req = {
      ruleId: "ask:git-push",
      reason: "pushing code to remote",
      tool: "bash",
      command: "git push origin main",
      sessionID: "ses-1",
    };
    const view = describeGuardRequest(req);
    const choices = guardChoices();

    const activeItem: PromptSlotItem = {
      req,
      view,
      choices,
      settle: (decision) => {
        settledDecision = decision;
      },
    };

    try {
      await render(
        () => (
          <PromptSlotWrapper
            api={mockApi}
            activeRequest={() => activeItem}
            slotProps={{
              session_id: "ses-1",
              children: <box><text>[PROMPT CHIP FIELD]</text></box>,
            }}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      const frame = setup.captureCharFrame();

      // Dialog is rendered directly above the prompt chip field!
      expect(frame).toContain("Guardian Angel: git-push");
      expect(frame).toContain("[PROMPT CHIP FIELD]");
      expect(frame).toContain("1. Deny");
      expect(frame).toContain("2. Allow");
      expect(frame).not.toContain("Search");

      // Press '2' -> settles allow
      setup.mockInput.pressKey("2");
      expect(settledDecision as string | null).toBe("allow");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("PromptSlotWrapper delegates to api.ui.Prompt with chips and right slot", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    let passedPromptProps: any = null;

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      ui: {
        Prompt: (props: any) => {
          passedPromptProps = props;
          return (
            <box flexDirection="row">
              <text>[AGENT: build] [MODEL: deepseek] [PROMPT INPUT]</text>
              {props.right}
            </box>
          );
        },
        Slot: (props: any) => <text>[RIGHT: {props.name}]</text>,
      },
      renderer: setup.renderer,
    };

    const mockRef = () => {};
    const mockSubmit = () => {};

    try {
      await render(
        () => (
          <PromptSlotWrapper
            api={mockApi}
            activeRequest={() => null}
            slotProps={{
              session_id: "ses-test-1",
              visible: true,
              disabled: false,
              on_submit: mockSubmit,
              ref: mockRef,
            }}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("[AGENT: build] [MODEL: deepseek] [PROMPT INPUT]");
      expect(frame).toContain("[RIGHT: session_prompt_right]");

      expect(passedPromptProps).not.toBeNull();
      expect(passedPromptProps.sessionID).toBe("ses-test-1");
      expect(passedPromptProps.disabled).toBe(false);
      expect(passedPromptProps.visible).toBe(true);
      expect(passedPromptProps.onSubmit).toBe(mockSubmit);
      expect(passedPromptProps.ref).toBe(mockRef);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("PromptSlotWrapper disables prompt input while dialog is active", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    let passedPromptProps: any = null;

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      ui: {
        Prompt: (props: any) => {
          passedPromptProps = props;
          return <box><text>[PROMPT AREA]</text></box>;
        },
      },
      renderer: setup.renderer,
    };

    const req = {
      ruleId: "ask:sudo",
      reason: "elevated permissions",
      tool: "bash",
      command: "sudo su",
      sessionID: "ses-active",
    };

    const activeItem: PromptSlotItem = {
      req,
      view: describeGuardRequest(req),
      choices: guardChoices(),
      settle: () => {},
    };

    try {
      await render(
        () => (
          <PromptSlotWrapper
            api={mockApi}
            activeRequest={() => activeItem}
            slotProps={{
              session_id: "ses-active",
              visible: true,
              disabled: false,
            }}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Guardian Angel: sudo");
      expect(frame).toContain("[PROMPT AREA]");
      expect(passedPromptProps.disabled).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("QuestionDialog pushes question mode and registers keymap layer", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    let pushedMode: string | null = null;
    let modePopped = false;
    let registeredLayer: any = null;
    let layerUnregistered = false;
    let settledDecision: string | null = null;

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      mode: {
        push: (m: string) => {
          pushedMode = m;
          return () => {
            modePopped = true;
          };
        },
      },
      keymap: {
        registerLayer: (layer: any) => {
          registeredLayer = layer;
          return () => {
            layerUnregistered = true;
          };
        },
      },
      renderer: setup.renderer,
    };

    const req = {
      ruleId: "ask:git-push",
      reason: "pushing code",
      tool: "bash",
      command: "git push origin main",
    };

    try {
      await render(
        () => (
          <QuestionDialog
            api={mockApi}
            view={describeGuardRequest(req)}
            choices={guardChoices()}
            onSettle={(d) => {
              settledDecision = d;
            }}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();

      // Mode and keymap layer registered
      expect(pushedMode as string | null).toBe("question");
      expect(registeredLayer).not.toBeNull();
      expect(registeredLayer.mode).toBe("question");
      expect(registeredLayer.priority).toBe(1000);

      // Verify commands in layer
      const upCmd = registeredLayer.commands.find((c: any) => c.name === "guardian.up");
      const downCmd = registeredLayer.commands.find((c: any) => c.name === "guardian.down");
      const allowCmd = registeredLayer.commands.find((c: any) => c.name === "guardian.2");
      const tabCmd = registeredLayer.commands.find((c: any) => c.name === "guardian.tab");
      const scrollUpCmd = registeredLayer.commands.find((c: any) => c.name === "guardian.scroll_up");
      const scrollDownCmd = registeredLayer.commands.find((c: any) => c.name === "guardian.scroll_down");
      expect(upCmd).toBeDefined();
      expect(downCmd).toBeDefined();
      expect(allowCmd).toBeDefined();
      expect(tabCmd).toBeDefined();
      expect(scrollUpCmd).toBeDefined();
      expect(scrollDownCmd).toBeDefined();

      // Verify key bindings for navigation and expansion
      const tabBinding = registeredLayer.bindings.find((b: any) => b.key === "tab");
      const pageUpBinding = registeredLayer.bindings.find((b: any) => b.key === "pageup");
      const pageDownBinding = registeredLayer.bindings.find((b: any) => b.key === "pagedown");
      expect(tabBinding?.cmd).toBe("guardian.tab");
      expect(pageUpBinding?.cmd).toBe("guardian.scroll_up");
      expect(pageDownBinding?.cmd).toBe("guardian.scroll_down");

      // Trigger allow command through keymap
      allowCmd.run();
      expect(settledDecision as string | null).toBe("allow");
    } finally {
      setup.renderer.destroy();
      expect(modePopped).toBe(true);
      expect(layerUnregistered).toBe(true);
    }
  });

  test("renders compact scrollbox with tab expand hint for long commands", async () => {
    const setup = await createTestRenderer({ width: 88, height: 30 });

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const longCmd = [
      "python3 -c '",
      "import json",
      "d = json.load(open(\"config.json\"))",
      "for item in d[\"items\"]:",
      "    print(item[\"name\"], item[\"version\"])",
      "'",
    ].join("\n");

    const req = {
      ruleId: "ask:interpreter-inline",
      reason: "inline interpreter code cannot be inspected",
      tool: "bash",
      command: longCmd,
    };

    try {
      await render(
        () => (
          <QuestionDialog
            api={mockApi}
            view={describeGuardRequest(req)}
            choices={guardChoices()}
            onSettle={() => {}}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      const frame = setup.captureCharFrame();

      // Long command is compact initially with expand hint
      expect(frame).toContain("[tab expand]");
      expect(frame).toContain("tab expand");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("tab key toggles between compact and expanded scrollbox views for long single-line commands", async () => {
    const setup = await createTestRenderer({ width: 88, height: 30 });

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const singleLineLongCmd =
      "git push origin feature/very-long-branch-name-for-user-authentication-and-authorization-token-refresh --force-with-lease --verbose";

    const req = {
      ruleId: "ask:git-push",
      reason: "pushing code",
      tool: "bash",
      command: singleLineLongCmd,
    };

    try {
      await render(
        () => (
          <QuestionDialog
            api={mockApi}
            view={describeGuardRequest(req)}
            choices={guardChoices()}
            onSettle={() => {}}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      const compactFrame = setup.captureCharFrame();
      expect(compactFrame).toContain("[tab expand]");

      // Press Tab to expand
      setup.renderer.keyInput.emit("keypress", { name: "tab", sequence: "\t" } as any);
      await setup.renderOnce();
      const expandedFrame = setup.captureCharFrame();
      expect(expandedFrame).toContain("[tab collapse]");
      expect(expandedFrame).toContain("authorization-token-refresh");

      // Press Tab again to collapse
      setup.renderer.keyInput.emit("keypress", { name: "tab", sequence: "\t" } as any);
      await setup.renderOnce();
      const recompactFrame = setup.captureCharFrame();
      expect(recompactFrame).toContain("[tab expand]");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("guardian.tab keymap command expands and collapses scrollbox height for expandable command", async () => {
    const setup = await createTestRenderer({ width: 88, height: 30 });
    let registeredLayer: any = null;

    const mockApi: any = {
      keymap: {
        registerLayer: (layer: any) => {
          registeredLayer = layer;
          return () => {};
        },
      },
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const singleLineLongCmd =
      "git push origin feature/very-long-branch-name-for-user-authentication-and-authorization-token-refresh --force-with-lease --verbose";

    const req = {
      ruleId: "ask:git-push",
      reason: "pushing code",
      tool: "bash",
      command: singleLineLongCmd,
    };

    try {
      await render(
        () => (
          <QuestionDialog
            api={mockApi}
            view={describeGuardRequest(req)}
            choices={guardChoices()}
            onSettle={() => {}}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("[tab expand]");

      const tabCmd = registeredLayer.commands.find((c: any) => c.name === "guardian.tab");
      expect(tabCmd).toBeDefined();

      // Run guardian.tab -> expands height
      tabCmd.run();
      await setup.renderOnce();
      const expandedFrame = setup.captureCharFrame();
      expect(expandedFrame).toContain("[tab collapse]");
      expect(expandedFrame).toContain("authorization-token-refresh");

      // Run guardian.tab again -> collapses height
      tabCmd.run();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("[tab expand]");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("does not show expand hint for short single-line commands", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const req = {
      ruleId: "ask:git-push",
      reason: "pushing code",
      tool: "bash",
      command: "git push origin main",
    };

    try {
      await render(
        () => (
          <QuestionDialog
            api={mockApi}
            view={describeGuardRequest(req)}
            choices={guardChoices()}
            onSettle={() => {}}
          />
        ),
        setup.renderer,
      );

      await setup.renderOnce();
      const frame = setup.captureCharFrame();

      // Single line command does not show expand hint
      expect(frame).not.toContain("[tab expand]");
      expect(frame).not.toContain("tab expand");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("unmounting without manual settlement fails closed and settles deny", async () => {
    const setup = await createTestRenderer({ width: 88, height: 24 });
    let settledDecision: "allow" | "deny" | null = null;

    const mockApi: any = {
      theme: {
        current: {
          warning: "#f5a742",
          text: "#eeeeee",
          textMuted: "#808080",
          backgroundPanel: "#141414",
          backgroundElement: "#1e1e1e",
        },
      },
      renderer: setup.renderer,
    };

    const req = {
      ruleId: "ask:git-push",
      reason: "pushing code",
      tool: "bash",
      command: "git push origin main",
    };

    await render(
      () => (
        <QuestionDialog
          api={mockApi}
          view={describeGuardRequest(req)}
          choices={guardChoices()}
          onSettle={(d) => {
            settledDecision = d;
          }}
        />
      ),
      setup.renderer,
    );

    await setup.renderOnce();
    expect(settledDecision).toBeNull();

    // Session switch / component unmount
    setup.renderer.destroy();
    expect(settledDecision as string | null).toBe("deny");
  });
});
