import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupCall,
  cleanupStale,
  ensureIpcDir,
  isTuiActive,
  listPendingRequests,
  readResponse,
  removeHeartbeat,
  waitForResponse,
  writeHeartbeat,
  writeRequest,
  writeResponse,
} from "../src/adapters/opencode/ipc.ts";
import type { IpcRequest } from "../src/adapters/opencode/types.ts";

describe("OpenCode IPC bridge", () => {
  const testIpcDir = join(tmpdir(), `test-ga-ipc-${Date.now()}`);

  beforeEach(() => {
    ensureIpcDir(testIpcDir);
  });

  afterEach(() => {
    try {
      if (existsSync(testIpcDir)) {
        rmSync(testIpcDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  test("heartbeat lifecycle and active check", async () => {
    expect(isTuiActive(testIpcDir)).toBe(false);

    writeHeartbeat(testIpcDir);
    expect(isTuiActive(testIpcDir)).toBe(true);

    removeHeartbeat(testIpcDir);
    expect(isTuiActive(testIpcDir)).toBe(false);
  });

  test("request and response exchange", async () => {
    const req: IpcRequest = {
      callID: "call-123",
      sessionID: "ses-abc",
      tool: "bash",
      command: "rm -rf /test",
      reason: "hapus file",
      ruleId: "ask:rm",
      createdAt: Date.now(),
      deadline: Date.now() + 5000,
    };

    writeRequest(req, testIpcDir);

    const pending = listPendingRequests(testIpcDir);
    expect(pending.length).toBe(1);
    expect(pending[0].callID).toBe("call-123");
    expect(pending[0].command).toBe("rm -rf /test");

    expect(readResponse("call-123", testIpcDir)).toBeNull();

    writeResponse("call-123", "allow", testIpcDir);

    const res = readResponse("call-123", testIpcDir);
    expect(res).not.toBeNull();
    expect(res?.decision).toBe("allow");

    cleanupCall("call-123", testIpcDir);
    expect(readResponse("call-123", testIpcDir)).toBeNull();
    expect(listPendingRequests(testIpcDir).length).toBe(0);
  });

  test("waitForResponse resolves when response is written", async () => {
    const callID = "call-wait-1";
    const deadline = Date.now() + 2000;

    // Write response after 200ms
    setTimeout(() => {
      writeResponse(callID, "deny", testIpcDir);
    }, 200);

    const res = await waitForResponse(callID, deadline, testIpcDir, 50);
    expect(res).not.toBeNull();
    expect(res?.decision).toBe("deny");
  });

  test("waitForResponse returns null on deadline expiry", async () => {
    const callID = "call-timeout-1";
    const deadline = Date.now() + 200;

    const res = await waitForResponse(callID, deadline, testIpcDir, 50);
    expect(res).toBeNull();
  });

  test("cleanupStale removes old files", async () => {
    const req: IpcRequest = {
      callID: "call-stale",
      sessionID: "ses-stale",
      tool: "bash",
      reason: "stale test",
      ruleId: "ask:stale",
      createdAt: Date.now(),
      deadline: Date.now() + 5000,
    };

    writeRequest(req, testIpcDir);
    expect(listPendingRequests(testIpcDir).length).toBe(1);

    // Call cleanup with maxAgeMs = 0 -> should delete immediately
    cleanupStale(testIpcDir, -1);
    expect(listPendingRequests(testIpcDir).length).toBe(0);
  });
});
