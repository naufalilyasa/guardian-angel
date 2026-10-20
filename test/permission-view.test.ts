import { describe, expect, test } from "bun:test";
import {
  describeGuardRequest,
  guardChoices,
  renderGuardBody,
} from "../src/adapters/opencode/permission-view.ts";

/**
 * The dialog mirrors OpenCode's native `question` tool: a short header, the
 * full question as the prompt, and choices that each carry a description.
 * These tests lock that shape so the presentation cannot silently drift back
 * to a bare Cancel/Confirm prompt.
 */

describe("describeGuardRequest", () => {
  test("strips the tier prefix from the rule id for the header", () => {
    const view = describeGuardRequest({
      ruleId: "ask:git-push",
      reason: "git push requires approval",
      tool: "bash",
      command: "git push origin main",
    });
    expect(view.header).toBe("Guardian Angel: git-push");
  });

  test("handles block and rewrite rule ids the same way", () => {
    expect(
      describeGuardRequest({
        ruleId: "block:rm-root",
        reason: "blocked",
        tool: "bash",
        command: "rm -rf /",
      }).header,
    ).toBe("Guardian Angel: rm-root");

    expect(
      describeGuardRequest({
        ruleId: "rewrite:rm-trash",
        reason: "rewritten",
        tool: "bash",
        command: "rm ./build",
      }).header,
    ).toBe("Guardian Angel: rm-trash");
  });

  test("keeps the header within the 30 character native limit", () => {
    const view = describeGuardRequest({
      ruleId: "ask:a-very-long-rule-identifier-that-will-not-fit",
      reason: "r",
      tool: "bash",
      command: "c",
    });
    expect(view.header.length).toBeLessThanOrEqual(30);
    expect(view.header.endsWith("…")).toBe(true);
  });

  test("maps each guarded tool to a human label", () => {
    const label = (tool: string): string =>
      describeGuardRequest({ ruleId: "ask:x", reason: "r", tool, command: "c" }).toolLabel;

    expect(label("bash")).toBe("Shell command");
    expect(label("write")).toBe("Write file");
    expect(label("edit")).toBe("Edit file");
    expect(label("patch")).toBe("Patch file");
    expect(label("unknown-tool")).toBe("unknown-tool");
  });

  test("phrases the question in English", () => {
    const view = describeGuardRequest({
      ruleId: "ask:git-push",
      reason: "needs approval",
      tool: "bash",
      command: "git push",
    });
    expect(view.question).toBe("Allow Guardian Angel to run this shell command?");
  });

  test("uses the command for bash and the path for file tools", () => {
    expect(
      describeGuardRequest({
        ruleId: "ask:x",
        reason: "r",
        tool: "bash",
        command: "ls -la",
      }).detail,
    ).toBe("ls -la");

    expect(
      describeGuardRequest({
        ruleId: "ask:x",
        reason: "r",
        tool: "write",
        path: "/etc/hosts",
      }).detail,
    ).toBe("/etc/hosts");
  });

  test("falls back when neither command nor path is present", () => {
    expect(
      describeGuardRequest({ ruleId: "ask:x", reason: "r", tool: "bash" }).detail,
    ).toBe("(no additional detail)");
  });

  test("collapses newlines so a multi-line command stays on one line", () => {
    const view = describeGuardRequest({
      ruleId: "ask:x",
      reason: "r",
      tool: "bash",
      command: "line one\nline two\n  line three",
    });
    expect(view.detail).toBe("line one line two line three");
  });

  test("truncates a very long command with an ellipsis", () => {
    const view = describeGuardRequest({
      ruleId: "ask:x",
      reason: "r",
      tool: "bash",
      command: "a".repeat(500),
    });
    expect(view.detail.length).toBeLessThanOrEqual(120);
    expect(view.detail.endsWith("…")).toBe(true);
  });
});

describe("guardChoices", () => {
  test("offers exactly Deny and Allow", () => {
    expect(guardChoices().map((c) => c.label)).toEqual(["Deny", "Allow"]);
  });

  test("puts Deny first so an accidental Enter cannot execute the command", () => {
    expect(guardChoices()[0]?.value).toBe("deny");
  });

  test("gives every choice a non-empty description", () => {
    for (const choice of guardChoices()) {
      expect(choice.description.length).toBeGreaterThan(0);
    }
  });

  test("uses English copy", () => {
    const [deny, allow] = guardChoices();
    expect(deny?.description).toContain("ESC also denies");
    expect(allow?.description).toContain("24 hours");
  });
});

describe("renderGuardBody", () => {
  test("includes the question, the detail, and the reason", () => {
    const view = describeGuardRequest({
      ruleId: "ask:git-push",
      reason: "git push requires approval",
      tool: "bash",
      command: "git push origin main",
    });
    const body = renderGuardBody(view);

    expect(body).toContain("Allow Guardian Angel to run this shell command?");
    expect(body).toContain("Shell command:");
    expect(body).toContain("  git push origin main");
    expect(body).toContain("Why: git push requires approval");
  });
});
