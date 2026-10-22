import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureIpcDir,
  getWorkspaceIpcDir,
  isTuiActive,
  readResponse,
  writeHeartbeat,
  writeRequest,
} from "../src/adapters/opencode/ipc.ts";
import {
  getActiveSessionId,
  GuardianAngelTui,
  shouldHandleRequest,
} from "../src/adapters/opencode/tui.ts";
import type { IpcRequest } from "../src/adapters/opencode/types.ts";

describe("TUI Session Isolation & Routing (TDD)", () => {
  describe("getWorkspaceIpcDir", () => {
    test("respects envIpcDir override if provided", () => {
      const custom = "/custom/ipc/dir";
      expect(getWorkspaceIpcDir("/workspace/a", custom)).toBe(custom);
    });

    test("returns base dir if workspace is undefined or empty", () => {
      const dir1 = getWorkspaceIpcDir();
      const dir2 = getWorkspaceIpcDir("");
      expect(dir1).toContain("guardian-angel-ipc");
      expect(dir2).toBe(dir1);
    });

    test("generates isolated, distinct directories for different workspaces", () => {
      const wsA = "/Users/dev/project-alpha";
      const wsB = "/Users/dev/project-beta";

      const dirA = getWorkspaceIpcDir(wsA);
      const dirB = getWorkspaceIpcDir(wsB);

      expect(dirA).not.toBe(dirB);
      expect(dirA.startsWith(dirB)).toBe(false);
      expect(dirB.startsWith(dirA)).toBe(false);
    });

    test("generates identical path for same workspace with different trailing slashes", () => {
      const dir1 = getWorkspaceIpcDir("/Users/dev/project");
      const dir2 = getWorkspaceIpcDir("/Users/dev/project/");
      expect(dir1).toBe(dir2);
    });
  });

  describe("getActiveSessionId", () => {
    test("returns undefined when api or route is empty/missing", () => {
      expect(getActiveSessionId({})).toBeUndefined();
      expect(getActiveSessionId({ route: undefined })).toBeUndefined();
    });

    test("returns undefined when on home route", () => {
      const mockApi: any = {
        route: { current: { name: "home" } },
      };
      expect(getActiveSessionId(mockApi)).toBeUndefined();
    });

    test("returns sessionID when on session route with valid params", () => {
      const mockApi: any = {
        route: {
          current: {
            name: "session",
            params: { sessionID: "ses-test-123" },
          },
        },
      };
      expect(getActiveSessionId(mockApi)).toBe("ses-test-123");
    });

    test("returns undefined when route params sessionID is missing or not a string", () => {
      const mockApi: any = {
        route: {
          current: {
            name: "session",
            params: {},
          },
        },
      };
      expect(getActiveSessionId(mockApi)).toBeUndefined();
    });
  });

  describe("shouldHandleRequest", () => {
    test("allows request when activeSessionId matches req.sessionID (happy path)", () => {
      expect(shouldHandleRequest({ sessionID: "ses-1" }, "ses-1")).toBe(true);
    });

    test("blocks request when activeSessionId does NOT match req.sessionID (leak prevention)", () => {
      expect(shouldHandleRequest({ sessionID: "ses-other" }, "ses-active")).toBe(false);
    });

    test("allows request when activeSessionId is undefined (fallback / tests)", () => {
      expect(shouldHandleRequest({ sessionID: "ses-any" }, undefined)).toBe(true);
    });

    test("allows request when req.sessionID is a child/subagent of activeSessionId", () => {
      const mockApi: any = {
        state: {
          session: {
            get: (id: string) => {
              if (id === "ses-child") return { id: "ses-child", parentID: "ses-active" };
              return undefined;
            },
          },
        },
      };
      expect(shouldHandleRequest({ sessionID: "ses-child" }, "ses-active", mockApi)).toBe(true);
    });

    test("allows request when req.sessionID is a grandchild of activeSessionId", () => {
      const mockApi: any = {
        state: {
          session: {
            get: (id: string) => {
              if (id === "ses-grandchild") return { id: "ses-grandchild", parentID: "ses-child" };
              if (id === "ses-child") return { id: "ses-child", parentID: "ses-active" };
              return undefined;
            },
          },
        },
      };
      expect(shouldHandleRequest({ sessionID: "ses-grandchild" }, "ses-active", mockApi)).toBe(true);
    });

    test("blocks request when child session belongs to a different parent", () => {
      const mockApi: any = {
        state: {
          session: {
            get: (id: string) => {
              if (id === "ses-other-child") return { id: "ses-other-child", parentID: "ses-other-parent" };
              return undefined;
            },
          },
        },
      };
      expect(shouldHandleRequest({ sessionID: "ses-other-child" }, "ses-active", mockApi)).toBe(false);
    });
  });

  describe("Multi-session TUI integration (No Dialog Leaks)", () => {
    test("TUI on session A ignores pending requests for session B and only shows dialog for session A", async () => {
      const ipcDir = mkdtempSync(join(tmpdir(), "ga-tui-multi-ses-"));
      ensureIpcDir(ipcDir);

      let renderedA: any = null;
      const disposeCallbacksA: Array<() => void> = [];

      const mockApiSessionA: any = {
        route: {
          current: {
            name: "session",
            params: { sessionID: "ses-A" },
          },
        },
        ui: {
          dialog: {
            replace: (render: () => any) => {
              renderedA = render;
            },
            clear: () => {},
          },
          DialogConfirm: (props: any) => ({ type: "confirm", props }),
        },
        lifecycle: {
          onDispose: (cb: () => void) => {
            disposeCallbacksA.push(cb);
          },
        },
      };

      await GuardianAngelTui(mockApiSessionA, { ipcDir }, {} as any);

      // Submit request for session B (different session!)
      const reqB: IpcRequest = {
        callID: "call-for-b",
        sessionID: "ses-B",
        tool: "bash",
        command: "rm -rf build",
        reason: "hapus build",
        ruleId: "ask:rm-build",
        createdAt: Date.now(),
        deadline: Date.now() + 5000,
      };
      writeRequest(reqB, ipcDir);

      // Wait a few polling ticks
      await new Promise((r) => setTimeout(r, 450));

      // TUI on session A MUST NOT display dialog for session B!
      expect(renderedA).toBeNull();

      // Now submit request for session A (matching session)
      const reqA: IpcRequest = {
        callID: "call-for-a",
        sessionID: "ses-A",
        tool: "bash",
        command: "git push origin main",
        reason: "push remote",
        ruleId: "ask:git-push",
        createdAt: Date.now(),
        deadline: Date.now() + 5000,
      };
      writeRequest(reqA, ipcDir);

      for (let i = 0; i < 20; i++) {
        if (renderedA !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Dialog for session A must appear in TUI A!
      expect(renderedA).not.toBeNull();
      const comp = renderedA();
      expect(comp.props.title).toContain("Guardian Angel: git-push");
      comp.props.onConfirm();

      const res = readResponse("call-for-a", ipcDir);
      expect(res?.decision).toBe("allow");

      for (const cb of disposeCallbacksA) cb();
      rmSync(ipcDir, { recursive: true, force: true });
    });

    test("TUI on session A processes and displays request from a subagent session whose parentID is session A", async () => {
      const ipcDir = mkdtempSync(join(tmpdir(), "ga-tui-subagent-ses-"));
      ensureIpcDir(ipcDir);

      let renderedA: any = null;
      const disposeCallbacksA: Array<() => void> = [];

      const mockApiSessionA: any = {
        route: {
          current: {
            name: "session",
            params: { sessionID: "ses-A" },
          },
        },
        state: {
          session: {
            get: (id: string) => {
              if (id === "ses-subagent-1") {
                return {
                  id: "ses-subagent-1",
                  parentID: "ses-A",
                  title: "PHP Compatibility Check (@general subagent)",
                };
              }
              return undefined;
            },
          },
        },
        ui: {
          dialog: {
            replace: (render: () => any) => {
              renderedA = render;
            },
            clear: () => {},
          },
          DialogConfirm: (props: any) => ({ type: "confirm", props }),
        },
        lifecycle: {
          onDispose: (cb: () => void) => {
            disposeCallbacksA.push(cb);
          },
        },
      };

      await GuardianAngelTui(mockApiSessionA, { ipcDir }, {} as any);

      // Submit request from subagent
      const reqSubagent: IpcRequest = {
        callID: "call-from-subagent",
        sessionID: "ses-subagent-1",
        tool: "bash",
        command: "python3 -c 'import json; print(1)'",
        reason: "inline interpreter code cannot be inspected; approval required",
        ruleId: "ask:interpreter-inline",
        createdAt: Date.now(),
        deadline: 0,
      };
      writeRequest(reqSubagent, ipcDir);

      for (let i = 0; i < 20; i++) {
        if (renderedA !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // Dialog must appear on parent session A's screen!
      expect(renderedA).not.toBeNull();
      const comp = renderedA();
      expect(comp.props.title).toContain("Guardian Angel: interpreter-i");
      expect(comp.props.message).toContain("PHP Compatibility Check (@general subagent)");

      comp.props.onConfirm();
      const res = readResponse("call-from-subagent", ipcDir);
      expect(res?.decision).toBe("allow");

      for (const cb of disposeCallbacksA) cb();
      rmSync(ipcDir, { recursive: true, force: true });
    });

    test("Cross-workspace isolation: two projects do not share heartbeat or requests", () => {
      const ws1 = mkdtempSync(join(tmpdir(), "ga-proj-1-"));
      const ws2 = mkdtempSync(join(tmpdir(), "ga-proj-2-"));

      const ipcDir1 = getWorkspaceIpcDir(ws1);
      const ipcDir2 = getWorkspaceIpcDir(ws2);

      expect(ipcDir1).not.toBe(ipcDir2);

      writeHeartbeat(ipcDir1);
      expect(isTuiActive(ipcDir1)).toBe(true);
      expect(isTuiActive(ipcDir2)).toBe(false);

      rmSync(ws1, { recursive: true, force: true });
      rmSync(ws2, { recursive: true, force: true });
      try {
        rmSync(ipcDir1, { recursive: true, force: true });
      } catch {}
    });
  });
});
