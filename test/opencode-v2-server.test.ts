import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GuardianAngelServerV2,
  createServerV2Hook,
  normalizeToolInput,
  resolveAdvisorClient,
  type ToolExecuteBeforeEvent,
} from "../src/adapters/opencode-v2/server.ts";
import { clearDenialCache } from "../src/adapters/opencode/server.ts";
import { BUILTIN_RULES } from "../src/core/policy.ts";
import {
  ensureIpcDir,
  readAdvisorStatus,
  writeHeartbeat,
  writeResponse,
} from "../src/adapters/opencode/ipc.ts";

describe("OpenCode v2 Server Adapter", () => {
  let ws: string;
  let ipcDir: string;

  beforeEach(() => {
    ws = join(tmpdir(), `test-ga-v2-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ipcDir = join(tmpdir(), `test-ga-v2-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  describe("normalizeToolInput", () => {
    test("normalizes path to filePath for write tool", () => {
      const input: Record<string, string> = { path: "/ws/file.txt", content: "hello" };
      normalizeToolInput("write", input);
      expect(input.filePath).toBe("/ws/file.txt");
      expect(input.path).toBe("/ws/file.txt");
    });

    test("normalizes path to filePath for edit tool", () => {
      const input: Record<string, string> = { path: "/ws/file.txt", oldString: "a", newString: "b" };
      normalizeToolInput("edit", input);
      expect(input.filePath).toBe("/ws/file.txt");
    });

    test("normalizes path to filePath for patch tool", () => {
      const input: Record<string, string> = { path: "/ws/file.txt", patch: "@@ -1 +1 @@" };
      normalizeToolInput("patch", input);
      expect(input.filePath).toBe("/ws/file.txt");
    });

    test("does not overwrite existing filePath", () => {
      const input: Record<string, string> = { path: "/other.txt", filePath: "/correct.txt" };
      normalizeToolInput("write", input);
      expect(input.filePath).toBe("/correct.txt");
    });

    test("leaves bash command input unchanged", () => {
      const input: Record<string, string> = { command: "ls -la" };
      normalizeToolInput("bash", input);
      expect(input.command).toBe("ls -la");
    });

    test("handles non-object input safely", () => {
      expect(normalizeToolInput("bash", null as any)).toBeNull();
      expect(normalizeToolInput("bash", undefined as any)).toBeUndefined();
    });
  });

  describe("resolveAdvisorClient", () => {
    test("returns advisorClient from opts if provided", () => {
      const mockClient = { session: { create: async () => ({}), prompt: async () => ({}) } } as any;
      const client = resolveAdvisorClient({ advisorClient: mockClient });
      expect(client).toBe(mockClient);
    });

    test("returns undefined if no client provided", () => {
      const client = resolveAdvisorClient({});
      expect(client).toBeUndefined();
    });
  });

  describe("v2 execute.before hook handler", () => {
    test("maps v2 tool name shell -> bash before delegating to shared handler", async () => {
      const seen: string[] = [];
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
        guardFn: ((call: any) => {
          seen.push(call.toolName);
          return { tier: "allow" } as any;
        }) as any,
      });

      await hook({
        tool: "shell",
        sessionID: "s-map",
        id: "call-map",
        input: { command: "echo real-v2-tool-name" },
      });

      expect(seen).toEqual(["bash"]);
    });

    test("allows benign shell command without modification", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const event: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-1",
        id: "call-v2-1",
        input: { command: "echo 'hello v2'" },
      };

      await hook(event);
      expect(event.input.command).toBe("echo 'hello v2'");
    });

    test("rewrites single clean rm in-place on event.input.command", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const originalInput = { command: "rm ./clean-target.txt" };
      const event: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-2",
        id: "call-v2-2",
        input: originalInput,
      };

      await hook(event);

      // Verify in-place mutation of the input object
      expect(event.input).toBe(originalInput);
      expect(event.input.command).toContain("trash");
      expect(event.input.command).toContain("clean-target.txt");
    });

    test("supports path field normalization for write in v2 event", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      // Write inside workspace with `path` instead of `filePath`
      const event: ToolExecuteBeforeEvent = {
        tool: "write",
        sessionID: "s-v2-3",
        id: "call-v2-3",
        input: { path: join(ws, "new-file.txt"), content: "inside workspace" },
      };

      await hook(event);
      // Normalized filePath should be added
      expect(event.input.filePath).toBe(join(ws, "new-file.txt"));
    });

    test("blocks destructive root rm with thrown Error in v2", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const event: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-4",
        id: "call-v2-4",
        input: { command: "rm -rf /" },
      };

      await expect(hook(event)).rejects.toThrow(/\[guardian-angel\].*root/i);
    });

    test("blocks write to protected .guardian-angel store in v2", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const event: ToolExecuteBeforeEvent = {
        tool: "write",
        sessionID: "s-v2-5",
        id: "call-v2-5",
        input: { path: ".guardian-angel/audit.jsonl", content: "hacked" },
      };

      await expect(hook(event)).rejects.toThrow(/\[guardian-angel\]/);
    });

    test("headless mode fails closed when ask-tier tool call has no active TUI", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const event: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-6",
        id: "call-v2-6",
        input: { command: "git push origin main" },
      };

      await expect(hook(event)).rejects.toThrow(/TUI is not running/);
    });

    test("active TUI approves ask-tier command via IPC and allows 24h cached call", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
        confirmTimeoutMs: 2000,
      });

      writeHeartbeat(ipcDir);

      // Simulate TUI response
      setTimeout(() => {
        writeResponse("c-v2-ask-1", "allow", ipcDir);
      }, 50);

      const event1: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-7",
        id: "c-v2-ask-1",
        input: { command: "git push origin main" },
      };

      await hook(event1);
      expect(event1.input.command).toBe("git push origin main");

      // Second call in same session should use 24h approval cache without IPC wait
      const event2: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-7",
        id: "c-v2-ask-2",
        input: { command: "git push origin main" },
      };

      await hook(event2);
      expect(event2.input.command).toBe("git push origin main");
    });

    test("active TUI denies ask-tier command and suppresses immediate retry", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
        confirmTimeoutMs: 2000,
        loadPolicy: () => ({ rules: [...BUILTIN_RULES], warnings: [] }),
      });

      writeHeartbeat(ipcDir);

      setTimeout(() => {
        writeResponse("c-v2-deny-1", "deny", ipcDir);
      }, 50);

      const event: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-8",
        id: "c-v2-deny-1",
        input: { command: "docker system prune -af" },
      };

      await expect(hook(event)).rejects.toThrow(/denied by the user/);

      // Immediate retry by agent hits 30s denial cache
      const retryEvent: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-8",
        id: "c-v2-retry-1",
        input: { command: "docker system prune -af" },
      };

      await expect(hook(retryEvent)).rejects.toThrow(/automatic retry suppressed/);
    });

    test("passes file write content to advisor and appends advisor audit record", async () => {
      let statusDuringCall: any = null;

      const mockAdvisorClient = {
        session: {
          create: async () => ({ data: { id: "advisor-ses-v2" } }),
          prompt: async () => ({
            data: {
              parts: [
                {
                  type: "text",
                  text: JSON.stringify({
                    risk_level: "low",
                    summary: "Safe script write in workspace",
                    is_reversible: true,
                    affected_resources: ["deploy.sh"],
                  }),
                },
              ],
            },
          }),
        },
      };

      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
        confirmTimeoutMs: 2000,
        advisorClient: mockAdvisorClient as any,
      });

      writeHeartbeat(ipcDir);

      // Check advisor status during call, then send allow response
      setTimeout(() => {
        statusDuringCall = readAdvisorStatus("c-v2-adv-1", ipcDir);
        writeResponse("c-v2-adv-1", "allow", ipcDir);
      }, 50);

      const event: ToolExecuteBeforeEvent = {
        tool: "write",
        sessionID: "s-v2-9",
        id: "c-v2-adv-1",
        input: {
          filePath: "/outside/dir/target.txt",
          content: "echo 'deploying'",
        },
      };

      await hook(event);

      // Status during call was written (loading or ready)
      expect(statusDuringCall).not.toBeNull();
      expect(["loading", "ready"]).toContain(statusDuringCall?.status);

      // Wait briefly for advisor async promise to finish appending to audit
      await new Promise((r) => setTimeout(r, 100));

      // Verify audit.jsonl contains advisor record
      const auditFile = join(ws, ".guardian-angel", "audit.jsonl");
      expect(existsSync(auditFile)).toBe(true);
      const lines = readFileSync(auditFile, "utf-8").trim().split("\n");
      const advisorEntry = lines.map((l) => JSON.parse(l)).find((e) => e.ruleId === "advisor");
      expect(advisorEntry).toBeDefined();
      expect(advisorEntry.advisor.risk_level).toBe("low");
      expect(advisorEntry.advisor.summary).toBe("Safe script write in workspace");
    });

    test("ignores unguarded tools without throwing", async () => {
      const hook = createServerV2Hook({
        workspace: ws,
        pkgRoot: join(import.meta.dir, ".."),
        ipcDir,
      });

      const event: ToolExecuteBeforeEvent = {
        tool: "read",
        sessionID: "s-v2-10",
        id: "c-v2-10",
        input: { filePath: "anything.txt" },
      };

      // Should complete without error
      await hook(event);
    });
  });

  describe("GuardianAngelServerV2 Plugin.define setup", () => {
    test("registers execute.before hook on ctx.tool", async () => {
      let registeredHookName = "";
      let registeredHandler: any = null;

      const mockCtx: any = {
        options: {
          workspace: ws,
          ipcDir,
        },
        location: {
          directory: ws,
        },
        tool: {
          hook: async (name: string, handler: any) => {
            registeredHookName = name;
            registeredHandler = handler;
          },
        },
      };

      await GuardianAngelServerV2.setup(mockCtx);

      expect(registeredHookName).toBe("execute.before");
      expect(typeof registeredHandler).toBe("function");

      // Verify the registered handler actually blocks destructive command
      const event: ToolExecuteBeforeEvent = {
        tool: "shell",
        sessionID: "s-v2-setup",
        id: "c-v2-setup",
        input: { command: "rm -rf /" },
      };

      await expect(registeredHandler(event)).rejects.toThrow(/\[guardian-angel\]/);
    });
  });
});
