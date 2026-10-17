import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function storeDir(workspace: string): string {
  return join(workspace, ".guardian-angel");
}

export function trashDir(workspace: string): string {
  return join(storeDir(workspace), "trash");
}

export function approvalsFile(workspace: string): string {
  return join(storeDir(workspace), "approvals.json");
}

export function auditFile(workspace: string): string {
  return join(storeDir(workspace), "audit.jsonl");
}

const IGNORE_LINE = ".guardian-angel/";

export function ensureStore(workspace: string): void {
  mkdirSync(trashDir(workspace), { recursive: true });

  const gitignorePath = join(workspace, ".gitignore");
  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, "utf8");
  }

  const hasLine = existing
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === IGNORE_LINE || line === ".guardian-angel");

  if (!hasLine) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignorePath, `${prefix}${IGNORE_LINE}\n`, "utf8");
  }
}

export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  const { renameSync } = require("node:fs") as typeof import("node:fs");
  renameSync(tmp, path);
}
