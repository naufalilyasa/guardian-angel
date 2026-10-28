import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GuardianAngelTuiV2,
  getActiveSessionIdV2,
  shouldHandleRequestV2,
  createApiShim,
} from "../src/adapters/opencode-v2/tui.tsx";
import {
  ensureIpcDir,
  isTuiActive,
  readResponse,
  writeRequest,
} from "../src/adapters/opencode/ipc.ts";
import type { IpcRequest } from "../src/adapters/opencode/types.ts";

describe("OpenCode v2 TUI Adapter", () => {
  let ws: string;
  let ipcDir: string;

  beforeEach(() => {
    ws = join(tmpdir(), `test-ga-v2-tui-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ipcDir = join(tmpdir(), `test-ga-v2-tui-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(ws, { recursive: true });
    ensureIpcDir(ipcDir);
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

  describe("routing and session helpers", () => {
    test("getActiveSessionIdV2 extracts sessionID when route is session", () => {
      const mockContext: any = {
        ui: {
          router: {
            current: () => ({ type: "session", sessionID: "ses-v2-active" }),
          },
        },
      };
      expect(getActiveSessionIdV2(mockContext)).toBe("ses-v2-active");
    });

    test("getActiveSessionIdV2 returns undefined when route is home", () => {
      const mockContext: any = {
        ui: {
          router: {
            current: () => ({ type: "home" }),
          },
        },
      };
      expect(getActiveSessionIdV2(mockContext)).toBeUndefined();
    });

    test("shouldHandleRequestV2 matches direct active session", () => {
      expect(shouldHandleRequestV2({ sessionID: "ses-1" }, "ses-1")).toBe(true);
      expect(shouldHandleRequestV2({ sessionID: "ses-1" }, "ses-2")).toBe(false);
      expect(shouldHandleRequestV2({ sessionID: "ses-1" }, undefined)).toBe(true);
    });

    test("shouldHandleRequestV2 bubbles child subagents to active parent session", () => {
      const mockContext: any = {
        data: {
          session: {
            get: (id: string) => {
              if (id === "ses-child") return { parentID: "ses-root" };
              if (id === "ses-grandchild") return { parentID: "ses-child" };
              return undefined;
            },
          },
        },
      };

      expect(shouldHandleRequestV2({ sessionID: "ses-child" }, "ses-root", mockContext)).toBe(true);
      expect(shouldHandleRequestV2({ sessionID: "ses-grandchild" }, "ses-root", mockContext)).toBe(true);
      expect(shouldHandleRequestV2({ sessionID: "ses-child" }, "ses-other", mockContext)).toBe(false);
    });
  });

  describe("createApiShim", () => {
    test("bridges keymap mode and layers cleanly", () => {
      let pushedMode = "";
      let registeredLayer: any = null;

      const mockContext: any = {
        keymap: {
          mode: {
            push: (m: string) => {
              pushedMode = m;
              return () => {
                pushedMode = "";
              };
            },
          },
          layer: (factory: () => any) => {
            registeredLayer = factory();
          },
        },
        theme: {
          text: { base: "#ffffff", muted: "#888888" },
        },
      };

      const shim = createApiShim(mockContext);
      const pop = shim.mode.push("question");
      expect(pushedMode).toBe("question");
      pop();
      expect(pushedMode).toBe("");

      shim.keymap.registerLayer({
        mode: "question",
        priority: 1000,
        commands: [{ name: "g.up", title: "Up", run: () => {} }],
        bindings: [{ key: "up", cmd: "g.up" }, { key: "k", cmd: "g.up" }],
      });

      expect(registeredLayer.mode).toBe("question");
      expect(registeredLayer.priority).toBe(1000);
      expect(registeredLayer.commands[0].id).toBe("g.up");
      expect(registeredLayer.commands[0].bind).toBe("up,k");
    });
  });

  describe("TUI lifecycle and slot registration", () => {
    test("starts heartbeat and registers session.composer.top slot", async () => {
      let registeredSlotName = "";
      let slotRenderer: any = null;
      let notificationReceived = false;

      const mockContext: any = {
        options: {
          workspace: ws,
          ipcDir,
        },
        location: {
          directory: ws,
        },
        ui: {
          slot: (claim: any) => {
            if (claim.append) {
              registeredSlotName = claim.append;
              slotRenderer = claim.render;
            }
          },
          router: {
            current: () => ({ type: "session", sessionID: "ses-v2-main" }),
          },
          dialog: {
            clear: () => {},
          },
        },
        attention: {
          notify: async () => {
            notificationReceived = true;
          },
        },
      };

      const cleanup = await GuardianAngelTuiV2.setup(mockContext);

      expect(isTuiActive(ipcDir)).toBe(true);
      expect(registeredSlotName).toBe("session.composer.top");
      expect(typeof slotRenderer).toBe("function");

      // Post pending request
      const req: IpcRequest = {
        callID: "call-v2-slot-test",
        sessionID: "ses-v2-main",
        tool: "bash",
        command: "git push origin main",
        reason: "pushing code",
        ruleId: "ask:git-push",
        createdAt: Date.now(),
        deadline: 0,
      };
      writeRequest(req, ipcDir);

      // Wait for poll timer (200ms) to process request
      for (let i = 0; i < 20; i++) {
        if (notificationReceived) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(notificationReceived).toBe(true);

      // Dispose cleanup
      if (typeof cleanup === "function") {
        await cleanup();
      }
      expect(isTuiActive(ipcDir)).toBe(false);
    });

    test("fallback dialog confirm path allows approval via modal", async () => {
      let dialogComponent: any = null;
      let dialogCloseCb: any = null;

      const mockContext: any = {
        options: {
          workspace: ws,
          ipcDir,
        },
        ui: {
          dialog: {
            set: () => {},
            show: (render: any, onClose: any) => {
              dialogComponent = render;
              dialogCloseCb = onClose;
            },
            clear: () => {},
          },
          router: {
            current: () => ({ type: "session", sessionID: "ses-v2-fallback" }),
          },
        },
      };

      const cleanup = await GuardianAngelTuiV2.setup(mockContext);

      const req: IpcRequest = {
        callID: "call-v2-fallback",
        sessionID: "ses-v2-fallback",
        tool: "bash",
        command: "docker system prune -af",
        reason: "cleanup docker",
        ruleId: "ask:docker-prune",
        createdAt: Date.now(),
        deadline: 0,
      };
      writeRequest(req, ipcDir);

      // Wait for poll
      for (let i = 0; i < 20; i++) {
        if (dialogComponent !== null) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(dialogComponent).not.toBeNull();

      // Trigger onClose (dismiss/ESC) -> should fail-closed and write deny
      dialogCloseCb();

      const response = readResponse("call-v2-fallback", ipcDir);
      expect(response).not.toBeNull();
      expect(response?.decision).toBe("deny");

      if (typeof cleanup === "function") {
        await cleanup();
      }
    });
  });
});
