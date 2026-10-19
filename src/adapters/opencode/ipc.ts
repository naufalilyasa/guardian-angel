import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import type { IpcHeartbeat, IpcRequest, IpcResponse } from "./types.ts";

export function getDefaultIpcDir(): string {
  if (process.env.GA_IPC_DIR) {
    return process.env.GA_IPC_DIR;
  }
  let username = "default";
  try {
    username = userInfo().username || "default";
  } catch {
    // fallback
  }
  return join(tmpdir(), `guardian-angel-ipc-${username}`);
}

export function ensureIpcDir(ipcDir = getDefaultIpcDir()): string {
  try {
    mkdirSync(ipcDir, { recursive: true, mode: 0o700 });
  } catch {
    // directory may already exist
  }
  return ipcDir;
}

const HEARTBEAT_FILE = "tui-heartbeat.json";

export function writeHeartbeat(ipcDir = getDefaultIpcDir()): void {
  ensureIpcDir(ipcDir);
  const data: IpcHeartbeat = {
    pid: process.pid,
    updatedAt: Date.now(),
  };
  const target = join(ipcDir, HEARTBEAT_FILE);
  writeFileSync(target, JSON.stringify(data), "utf-8");
}

export function removeHeartbeat(ipcDir = getDefaultIpcDir()): void {
  try {
    const target = join(ipcDir, HEARTBEAT_FILE);
    if (existsSync(target)) {
      unlinkSync(target);
    }
  } catch {
    // ignore
  }
}

export function isTuiActive(ipcDir = getDefaultIpcDir(), maxAgeMs = 5000): boolean {
  try {
    const target = join(ipcDir, HEARTBEAT_FILE);
    if (!existsSync(target)) return false;
    const content = readFileSync(target, "utf-8");
    const data = JSON.parse(content) as IpcHeartbeat;
    return typeof data.updatedAt === "number" && Date.now() - data.updatedAt < maxAgeMs;
  } catch {
    return false;
  }
}

export function writeRequest(req: IpcRequest, ipcDir = getDefaultIpcDir()): void {
  ensureIpcDir(ipcDir);
  const target = join(ipcDir, `request-${req.callID}.json`);
  writeFileSync(target, JSON.stringify(req, null, 2), "utf-8");
}

export function readResponse(callID: string, ipcDir = getDefaultIpcDir()): IpcResponse | null {
  try {
    const target = join(ipcDir, `response-${callID}.json`);
    if (!existsSync(target)) return null;
    const content = readFileSync(target, "utf-8");
    return JSON.parse(content) as IpcResponse;
  } catch {
    return null;
  }
}

export function writeResponse(
  callID: string,
  decision: "allow" | "deny",
  ipcDir = getDefaultIpcDir(),
): void {
  ensureIpcDir(ipcDir);
  const res: IpcResponse = {
    callID,
    decision,
    answeredAt: Date.now(),
  };
  const target = join(ipcDir, `response-${callID}.json`);
  writeFileSync(target, JSON.stringify(res, null, 2), "utf-8");
}

export function cleanupCall(callID: string, ipcDir = getDefaultIpcDir()): void {
  try {
    const reqFile = join(ipcDir, `request-${callID}.json`);
    if (existsSync(reqFile)) unlinkSync(reqFile);
  } catch {
    // ignore
  }
  try {
    const resFile = join(ipcDir, `response-${callID}.json`);
    if (existsSync(resFile)) unlinkSync(resFile);
  } catch {
    // ignore
  }
}

export function listPendingRequests(ipcDir = getDefaultIpcDir()): IpcRequest[] {
  try {
    if (!existsSync(ipcDir)) return [];
    const files = readdirSync(ipcDir);
    const requests: IpcRequest[] = [];

    for (const f of files) {
      if (f.startsWith("request-") && f.endsWith(".json")) {
        try {
          const content = readFileSync(join(ipcDir, f), "utf-8");
          const parsed = JSON.parse(content) as IpcRequest;
          if (parsed && parsed.callID && parsed.deadline) {
            requests.push(parsed);
          }
        } catch {
          // ignore corrupted files
        }
      }
    }

    return requests.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export function cleanupStale(ipcDir = getDefaultIpcDir(), maxAgeMs = 120_000): void {
  try {
    if (!existsSync(ipcDir)) return;
    const files = readdirSync(ipcDir);
    const now = Date.now();

    for (const f of files) {
      if (
        (f.startsWith("request-") || f.startsWith("response-")) &&
        f.endsWith(".json")
      ) {
        try {
          const path = join(ipcDir, f);
          const st = statSync(path);
          if (now - st.mtimeMs > maxAgeMs) {
            unlinkSync(path);
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

export async function waitForResponse(
  callID: string,
  deadline: number,
  ipcDir = getDefaultIpcDir(),
  pollIntervalMs = 150,
): Promise<IpcResponse | null> {
  while (Date.now() < deadline) {
    const res = readResponse(callID, ipcDir);
    if (res) return res;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return null;
}
