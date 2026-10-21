import { describe, expect, test } from "bun:test";
import { render } from "@opentui/solid";
import { createTestRenderer } from "@opentui/core/testing";
import { QuestionDialog } from "../src/adapters/opencode/question-dialog.js";
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
      expect(frame).toContain("Run once and remember this rule for 24 hours");

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
});
