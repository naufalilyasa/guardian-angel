import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearDenialCache,
  createHookHandler,
  toToolCall,
} from "../src/adapters/opencode/server.ts";
import { BUILTIN_RULES } from "../src/core/policy.ts";
import { GuardianAngelTui } from "../src/adapters/opencode/tui.ts";
import {
  ensureIpcDir,
  isTuiActive,
  readResponse,
  writeHeartbeat,
  writeRequest,
  writeResponse,
} from "../src/adapters/opencode/ipc.ts";
import type { IpcRequest } from "../src/adapters/opencode/types.ts";

describe("OpenCode Adapter", () => {
  let ws: string;
  let ipcDir: string;

  beforeEach(() => {
    ws = join(tmpdir(), `test-ga-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ipcDir = join(tmpdir(), `test-ga-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(ws, { recursive: true });
    ensureIpcDir(ipcDir);
    clearDenialCache();
  });

  afterEach(() => {
    try {
      if (existsSync(ws)) rmSync(ws, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      if (existsSync(ipcDir)) rmSync(ipcDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("toToolCall mapping", () => {
    test("maps bash tool call", () => {
      const call = toToolCall("bash", { command: "echo hello" });
      expect(call).not.toBeNull();
      expect(call?.toolName).toBe("bash");
      expect(call?.input.command).toBe("echo hello");
    });

    test("maps write tool call", () => {
      const call = toToolCall("write", { filePath: "a.txt", content: "foo" });
      expect(call).not.toBeNull();
      expect(call?.toolName).toBe("write");
      expect(call?.input.filePath).toBe("a.txt");
      expect(call?.input.content).toBe("foo");
    });

    test("maps edit tool call", () => {
      const call = toToolCall("edit", { filePath: "a.txt", oldString: "x", newString: "y" });
      expect(call).not.toBeNull();
      expect(call?.toolName).toBe("edit");
      expect(call?.input.filePath).toBe("a.txt");
    });

    test("maps patch tool call", () => {
      const call = toToolCall("patch", { filePath: "a.txt", patch: "diff" });
      expect(call).not.toBeNull();
      expect(call?.toolName).toBe("patch");
    });

    test("returns null for unguarded tool", () => {
      expect(toToolCall("read", { filePath: "a.txt" })).toBeNull();
      expect(toToolCall("grep", { pattern: "foo" })).toBeNull();
    });
  });

  describe("tool.execute.before handler", () => {
    test("allows benign commands without modification", async () => {
      const handler = createHookHandler({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const output = { args: { command: "ls -la" } };
      await handler({ tool: "bash", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.command).toBe("ls -la");
    });

    test("rewrites single rm command to ga trash", async () => {
      const handler = createHookHandler({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const output = { args: { command: "rm ./file.txt" } };
      await handler({ tool: "bash", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.command).toContain("trash");
      expect(output.args.command).toContain("file.txt");
    });

    test("blocks destructive root rm with thrown Error", async () => {
      const handler = createHookHandler({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const output = { args: { command: "rm -rf /" } };
      expect(
        handler({ tool: "bash", sessionID: "s1", callID: "c1" }, output),
      ).rejects.toThrow(/\[guardian-angel\]/);
    });

    test("blocks write to protected .guardian-angel directory", async () => {
      const handler = createHookHandler({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const output = { args: { filePath: ".guardian-angel/config.json", content: "{}" } };
      expect(
        handler({ tool: "write", sessionID: "s1", callID: "c1" }, output),
      ).rejects.toThrow(/\[guardian-angel\]/);
    });

    test("headless mode fails closed on ask-tier command", async () => {
      const handler = createHookHandler({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      // No TUI heartbeat present
      const output = { args: { command: "git push origin main" } };
      expect(
        handler({ tool: "bash", sessionID: "s1", callID: "c1" }, output),
      ).rejects.toThrow(/TUI tidak aktif/);
    });

    test("active TUI approves ask-tier command via IPC and caches approval", async () => {
      const handler = createHookHandler({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
        confirmTimeoutMs: 2000,
      });

      writeHeartbeat(ipcDir);

      // Simulate TUI response after 100ms
      setTimeout(() => {
        writeResponse("c-ask-1", "allow", ipcDir);
      }, 100);

      const output = { args: { command: "git push origin main" } };
      await handler({ tool: "bash", sessionID: "s1", callID: "c-ask-1" }, output);

      // Successfully allowed!
      expect(output.args.command).toBe("git push origin main");

      // Now test 24h approval cache: second run in same session should NOT need IPC response
      const output2 = { args: { command: "git push origin main" } };
      await handler({ tool: "bash", sessionID: "s1", callID: "c-ask-2" }, output2);
      expect(output2.args.command).toBe("git push origin main");
    });

    test("active TUI denies ask-tier command via IPC and caches denial for retry", async () => {
      const handler = createHookHandler({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
        confirmTimeoutMs: 2000,
        loadPolicy: () => ({ rules: [...BUILTIN_RULES], warnings: [] }),
      });

      writeHeartbeat(ipcDir);

      setTimeout(() => {
        writeResponse("c-deny-1", "deny", ipcDir);
      }, 100);

      const output = { args: { command: "docker system prune -af" } };
      await expect(
        handler({ tool: "bash", sessionID: "s1", callID: "c-deny-1" }, output),
      ).rejects.toThrow(/ditolak/);

      // Immediate retry by agent should hit denial cache and fail immediately
      await expect(
        handler({ tool: "bash", sessionID: "s1", callID: "c-retry-1" }, output),
      ).rejects.toThrow(/retry otomatis ditahan/);
    });

    test("overwrite of existing file in workspace triggers ask", async () => {
      const handler = createHookHandler({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      // Create an existing file
      writeFileSync(join(ws, "existing.txt"), "important data");

      // Headless -> ask throws
      const output = { args: { command: "echo 'new' > existing.txt" } };
      await expect(
        handler({ tool: "bash", sessionID: "s1", callID: "c-over-1" }, output),
      ).rejects.toThrow(/menimpa file/);
    });
  });

  describe("TUI plugin lifecycle and dialog dispatch", () => {
    test("starts heartbeat and displays confirm dialog on pending request", async () => {
      let dialogRendered: (() => any) | null = null;
      let dialogCleared = false;
      const disposeCallbacks: Array<() => void> = [];

      const mockApi: any = {
        ui: {
          dialog: {
            replace: (render: () => any) => {
              dialogRendered = render;
            },
            clear: () => {
              dialogCleared = true;
            },
          },
          DialogConfirm: (props: any) => {
            return { type: "confirm", props };
          },
        },
        lifecycle: {
          onDispose: (cb: () => void) => {
            disposeCallbacks.push(cb);
          },
        },
      };

      // Activate TUI plugin
      await GuardianAngelTui(mockApi, { ipcDir }, {} as any);

      expect(isTuiActive(ipcDir)).toBe(true);

      // Post an IPC request
      const req: IpcRequest = {
        callID: "call-tui-test",
        sessionID: "ses-1",
        tool: "bash",
        command: "git push origin main",
        reason: "push ke remote repository",
        ruleId: "ask:git-push",
        createdAt: Date.now(),
        deadline: Date.now() + 5000,
      };
      writeRequest(req, ipcDir);

      // Wait for poll loop to trigger dialog replace
      for (let i = 0; i < 20; i++) {
        if (dialogRendered !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(dialogRendered).not.toBeNull();

      // Execute rendered dialog confirm
      const component = dialogRendered!();
      expect(component.type).toBe("confirm");
      expect(component.props.title).toContain("ask:git-push");
      expect(component.props.message).toContain("push ke remote repository");

      // User clicks confirm
      component.props.onConfirm();

      expect(dialogCleared).toBe(true);

      // Response should be written
      const response = readResponse("call-tui-test", ipcDir);
      expect(response).not.toBeNull();
      expect(response?.decision).toBe("allow");

      // Dispose plugin
      for (const cb of disposeCallbacks) cb();
      expect(isTuiActive(ipcDir)).toBe(false);
    });

    test("REGRESSION: closing the dialog without choosing (ESC/backdrop) denies instead of timing out", async () => {
      let onCloseCb: (() => void) | null = null;
      const disposeCallbacks: Array<() => void> = [];

      const mockApi: any = {
        ui: {
          dialog: {
            replace: (_render: () => any, onClose?: () => void) => {
              onCloseCb = onClose ?? null;
            },
            clear: () => {},
          },
          DialogConfirm: (props: any) => ({ type: "confirm", props }),
        },
        lifecycle: {
          onDispose: (cb: () => void) => {
            disposeCallbacks.push(cb);
          },
        },
      };

      await GuardianAngelTui(mockApi, { ipcDir }, {} as any);

      const req: IpcRequest = {
        callID: "call-tui-escape",
        sessionID: "ses-1",
        tool: "bash",
        command: "git push origin main",
        reason: "push ke remote repository",
        ruleId: "ask:git-push",
        createdAt: Date.now(),
        deadline: Date.now() + 5000,
      };
      writeRequest(req, ipcDir);

      for (let i = 0; i < 20; i++) {
        if (onCloseCb !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(onCloseCb).not.toBeNull();

      // User hits ESC / clicks the backdrop: no explicit decision was made.
      onCloseCb!();

      const response = readResponse("call-tui-escape", ipcDir);
      expect(response).not.toBeNull();
      expect(response?.decision).toBe("deny");

      for (const cb of disposeCallbacks) cb();
    });

    test("REGRESSION: a late close after confirm does not overwrite the allow response", async () => {
      let dialogRendered: (() => any) | null = null;
      let onCloseCb: (() => void) | null = null;
      const disposeCallbacks: Array<() => void> = [];

      const mockApi: any = {
        ui: {
          dialog: {
            replace: (render: () => any, onClose?: () => void) => {
              dialogRendered = render;
              onCloseCb = onClose ?? null;
            },
            clear: () => {},
          },
          DialogConfirm: (props: any) => ({ type: "confirm", props }),
        },
        lifecycle: {
          onDispose: (cb: () => void) => {
            disposeCallbacks.push(cb);
          },
        },
      };

      await GuardianAngelTui(mockApi, { ipcDir }, {} as any);

      const req: IpcRequest = {
        callID: "call-tui-late-close",
        sessionID: "ses-1",
        tool: "bash",
        command: "git push origin main",
        reason: "push ke remote repository",
        ruleId: "ask:git-push",
        createdAt: Date.now(),
        deadline: Date.now() + 5000,
      };
      writeRequest(req, ipcDir);

      for (let i = 0; i < 20; i++) {
        if (dialogRendered !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(dialogRendered).not.toBeNull();

      // Confirm first, then let our own dialog.clear() fire onClose.
      dialogRendered!().props.onConfirm();
      expect(onCloseCb).not.toBeNull();
      onCloseCb!();

      const response = readResponse("call-tui-late-close", ipcDir);
      expect(response?.decision).toBe("allow");

      for (const cb of disposeCallbacks) cb();
    });
  });
});
