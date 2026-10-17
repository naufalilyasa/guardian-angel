import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHandler,
  renderReplacement,
  shellQuote,
  toToolCall,
} from "../src/adapters/senpi.ts";
import type { ExtensionContext, ToolCallEvent } from "@code-yeongyu/senpi";

const PKG_ROOT = "/pkg";

function makeCtx(workspace: string, opts: { hasUI?: boolean; confirmResult?: boolean } = {}) {
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const ctx = {
    cwd: workspace,
    hasUI: opts.hasUI ?? true,
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      confirm: async (title: string, message: string) => {
        confirmCalls.push({ title, message });
        return opts.confirmResult ?? true;
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, confirmCalls };
}

function bashEvent(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command },
  } as ToolCallEvent;
}

function writeEvent(path: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "call-2",
    toolName: "write",
    input: { path, content: "x" },
  } as ToolCallEvent;
}

describe("toToolCall", () => {
  test("maps bash", () => {
    expect(toToolCall(bashEvent("ls"))?.toolName).toBe("bash");
  });

  test("ignores non-guarded tools", () => {
    const event = { type: "tool_call", toolCallId: "c", toolName: "read", input: {} } as ToolCallEvent;
    expect(toToolCall(event)).toBeNull();
  });
});

describe("shellQuote", () => {
  test("leaves a safe path unquoted", () => {
    expect(shellQuote("/ws/build")).toBe("/ws/build");
  });

  test("quotes a path with spaces", () => {
    expect(shellQuote("/ws/my file")).toBe("'/ws/my file'");
  });

  test("escapes an embedded single quote", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("renderReplacement", () => {
  test("renders a ga trash invocation", () => {
    const rendered = renderReplacement({ path: "/ws/build" }, PKG_ROOT);
    expect(rendered).toBe("bun run /pkg/src/cli/ga.ts trash /ws/build");
  });

  test("quotes a path with spaces", () => {
    const rendered = renderReplacement({ path: "/ws/my file" }, PKG_ROOT);
    expect(rendered).toContain("'/ws/my file'");
  });
});

describe("handler", () => {
  test("blocks a destructive command", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ga-adapter-"));
    const { ctx } = makeCtx(workspace);
    const handler = createHandler({ pkgRoot: PKG_ROOT });

    const result = await handler(bashEvent("rm -rf /"), ctx);

    expect(result?.block).toBe(true);
    expect(result?.reason).toBeTruthy();
  });

  test("rewrites a clean rm into a ga trash command", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ga-adapter-"));
    const { ctx } = makeCtx(workspace);
    const handler = createHandler({ pkgRoot: PKG_ROOT });
    const event = bashEvent("rm ./build");

    const result = await handler(event, ctx);

    expect(result).toBeUndefined();
    if (event.toolName !== "bash") throw new Error("expected bash event");
    expect(event.input.command).toContain("ga.ts trash");
    expect(event.input.command).toContain(join(workspace, "build"));
  });

  test("asks for a write outside the workspace and allows when confirmed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ga-adapter-"));
    const { ctx, confirmCalls } = makeCtx(workspace, { confirmResult: true });
    const handler = createHandler({ pkgRoot: PKG_ROOT });

    const result = await handler(writeEvent("/etc/hosts"), ctx);

    expect(result).toBeUndefined();
    expect(confirmCalls).toHaveLength(1);
  });

  test("blocks when the user denies", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ga-adapter-"));
    const { ctx } = makeCtx(workspace, { confirmResult: false });
    const handler = createHandler({ pkgRoot: PKG_ROOT });

    const result = await handler(writeEvent("/etc/hosts"), ctx);

    expect(result?.block).toBe(true);
  });

  test("blocks an ask when there is no UI (fail-closed)", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ga-adapter-"));
    const { ctx, confirmCalls } = makeCtx(workspace, { hasUI: false });
    const handler = createHandler({ pkgRoot: PKG_ROOT });

    const result = await handler(writeEvent("/etc/hosts"), ctx);

    expect(result?.block).toBe(true);
    expect(confirmCalls).toHaveLength(0);
  });

  test("does not touch non-bash input", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ga-adapter-"));
    const { ctx } = makeCtx(workspace);
    const handler = createHandler({ pkgRoot: PKG_ROOT });
    const event = writeEvent("inside.txt");

    await handler(event, ctx);

    if (event.toolName !== "write") throw new Error("expected write event");
    expect(event.input.content).toBe("x");
  });

  test("allows a benign command unchanged", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ga-adapter-"));
    const { ctx } = makeCtx(workspace);
    const handler = createHandler({ pkgRoot: PKG_ROOT });
    const event = bashEvent("ls -la");

    const result = await handler(event, ctx);

    expect(result).toBeUndefined();
    if (event.toolName !== "bash") throw new Error("expected bash event");
    expect(event.input.command).toBe("ls -la");
  });

  test("creates the store directory on first use", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ga-adapter-"));
    const { ctx } = makeCtx(workspace);
    const handler = createHandler({ pkgRoot: PKG_ROOT });

    await handler(bashEvent("ls"), ctx);

    expect(readdirSync(workspace)).toContain(".guardian-angel");
  });
});
