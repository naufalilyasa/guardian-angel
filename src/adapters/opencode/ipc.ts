import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
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

export function getWorkspaceIpcDir(
  workspace?: string,
  envIpcDir = process.env.GA_IPC_DIR,
): string {
  if (envIpcDir) return envIpcDir;
  const base = getDefaultIpcDir();
  if (!workspace || workspace.trim().length === 0) return base;
  // ponytail: 16-hex sha256 provides collision-free workspace isolation in tmpdir
  const hash = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
  return join(base, hash);
}

export function ensureIpcDir(ipcDir = getDefaultIpcDir()): string {
  try {
    if (!existsSync(ipcDir)) {
      mkdirSync(ipcDir, { recursive: true, mode: 0o700 });
    }
    const stat = lstatSync(ipcDir);
    if (stat.isSymbolicLink()) {
      throw new Error(`[guardian-angel] insecure IPC directory: symlink detected at ${ipcDir}`);
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`[guardian-angel] insecure IPC directory: ownership mismatch at ${ipcDir}`);
    }
    try {
      chmodSync(ipcDir, 0o700);
    } catch {}
  } catch (err: any) {
    if (err?.message?.includes("insecure IPC directory")) throw err;
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
  writeFileSync(target, JSON.stringify(data), { encoding: "utf-8", mode: 0o600 });
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

export function writeRequest(req: IpcRequest, ipcDir = getDefaultIpcDir()): string {
  ensureIpcDir(ipcDir);
  const nonce = req.nonce ?? randomUUID();
  const fullReq: IpcRequest = { ...req, nonce };
  const target = join(ipcDir, `request-${req.callID}.json`);
  writeFileSync(target, JSON.stringify(fullReq, null, 2), { encoding: "utf-8", mode: 0o600 });
  return nonce;
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

/**
 * Read the advisor status file for a pending request. Returns null when no
 * advisor entry exists yet (the query is still in flight or never started).
 */
export function readAdvisorStatus<T = unknown>(
  callID: string,
  ipcDir = getDefaultIpcDir(),
): T | null {
  try {
    const target = join(ipcDir, `advisor-${callID}.json`);
    if (!existsSync(target)) return null;
    const content = readFileSync(target, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export function writeResponse(
  callID: string,
  decision: "allow" | "deny",
  ipcDir = getDefaultIpcDir(),
  nonce?: string,
): void {
  ensureIpcDir(ipcDir);
  let effectiveNonce = nonce;
  if (!effectiveNonce) {
    try {
      const reqFile = join(ipcDir, `request-${callID}.json`);
      if (existsSync(reqFile)) {
        const req = JSON.parse(readFileSync(reqFile, "utf-8")) as IpcRequest;
        effectiveNonce = req.nonce;
      }
    } catch {
      // ignore
    }
  }
  const res: IpcResponse = {
    callID,
    decision,
    answeredAt: Date.now(),
    ...(effectiveNonce ? { nonce: effectiveNonce } : {}),
  };
  const target = join(ipcDir, `response-${callID}.json`);
  writeFileSync(target, JSON.stringify(res, null, 2), { encoding: "utf-8", mode: 0o600 });
}

export function cleanupCall(callID: string, ipcDir = getDefaultIpcDir()): void {
  for (const prefix of ["request-", "response-", "advisor-"]) {
    try {
      const file = join(ipcDir, `${prefix}${callID}.json`);
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // ignore
    }
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
          if (parsed && parsed.callID && typeof parsed.deadline === "number") {
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
        (f.startsWith("request-") || f.startsWith("response-") || f.startsWith("advisor-")) &&
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
  expectedNonce?: string,
): Promise<IpcResponse | null> {
  while (deadline === 0 || Date.now() < deadline) {
    const res = readResponse(callID, ipcDir);
    if (res) {
      if (expectedNonce && res.nonce !== expectedNonce) {
        return null;
      }
      return res;
    }
    // Fail-closed safety: if waiting indefinitely and TUI is no longer active, stop waiting
    if (deadline === 0 && !isTuiActive(ipcDir)) {
      return null;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return null;
}
