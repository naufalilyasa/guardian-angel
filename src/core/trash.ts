import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { assertInSandbox, isInsideWorkspace, resolveLexical } from "./paths.ts";
import { isProtectedPath, protectedReason } from "./protected.ts";
import { ensureStore, trashDir } from "./store.ts";

export type TrashEntry = {
  id: string;
  originalPath: string;
  deletedAt: string;
  kind: "file" | "dir";
};

export const TRASH_TTL_MS = 24 * 60 * 60 * 1000;

function makeId(target: string, nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  const name = basename(target).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "item";
  const hash = createHash("sha256")
    .update(`${target}:${nowMs}:${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
  return `${stamp}-${name}-${hash}`;
}

function isValidId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";
}

function entryDir(workspace: string, id: string): string {
  if (!isValidId(id)) {
    throw new Error(`GA_TRASH_INVALID_ID: ${id}`);
  }
  const dir = join(trashDir(workspace), id);
  assertInSandbox(dir, trashDir(workspace));
  return dir;
}

function readEntry(workspace: string, id: string): TrashEntry | null {
  const metaPath = join(entryDir(workspace, id), "meta.json");
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as TrashEntry;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.originalPath !== "string" ||
      typeof parsed.deletedAt !== "string" ||
      (parsed.kind !== "file" && parsed.kind !== "dir")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function assertNoSymlinkComponents(workspace: string, target: string): void {
  const rel = relative(workspace, target);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`GA_TRASH_REFUSED: outside workspace: ${target}`);
  }

  let current = workspace;
  for (const part of rel.split(sep).filter((p) => p.length > 0)) {
    current = join(current, part);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`GA_TRASH_REFUSED: symlink in path: ${current}`);
    }
  }
}

function validateSafeDelete(workspace: string, resolved: string) {
  if (!isInsideWorkspace(workspace, resolved)) {
    throw new Error(`GA_TRASH_REFUSED: outside workspace: ${resolved}`);
  }
  // Trashing the store would move the audit log and approvals out of the way
  // (and `gc` would then erase them), so the store protects itself.
  if (isProtectedPath(workspace, resolved)) {
    throw new Error(`GA_TRASH_REFUSED: ${protectedReason(resolved)}`);
  }
  assertInSandbox(resolved, workspace);
  assertNoSymlinkComponents(workspace, resolved);

  if (!existsSync(resolved)) {
    throw new Error(`GA_TRASH_REFUSED: target does not exist: ${resolved}`);
  }

  const stats = lstatSync(resolved);
  if (stats.isSymbolicLink()) {
    throw new Error(`GA_TRASH_REFUSED: symlink: ${resolved}`);
  }
  return stats;
}

/**
 * Safely move a file or directory inside the workspace into `.guardian-angel/trash`.
 * Refuses paths outside workspace, protected store paths, and symlinks.
 *
 * @param workspace - The workspace root path
 * @param target - The path to move to trash
 * @param now - Optional timestamp supplier (defaults to Date.now)
 * @returns The unique trash entry ID
 */
export function safeDelete(
  workspace: string,
  target: string,
  now: () => number = Date.now,
): string {
  const resolved = resolveLexical(workspace, target);
  const stats = validateSafeDelete(workspace, resolved);

  ensureStore(workspace);

  const nowMs = now();
  const id = makeId(resolved, nowMs);
  const dir = entryDir(workspace, id);
  mkdirSync(dir, { recursive: true });

  const kind: TrashEntry["kind"] = stats.isDirectory() ? "dir" : "file";
  const entry: TrashEntry = {
    id,
    originalPath: resolved,
    deletedAt: new Date(nowMs).toISOString(),
    kind,
  };

  const payloadPath = join(dir, "payload");
  try {
    renameSync(resolved, payloadPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    rmSync(dir, { recursive: true, force: true });
    if (code === "EXDEV") {
      throw new Error(`GA_TRASH_REFUSED: cross-device rename: ${resolved}`);
    }
    throw error;
  }

  writeFileSync(join(dir, "meta.json"), JSON.stringify(entry, null, 2), "utf8");
  return id;
}

/**
 * List all valid trash entries in the workspace, sorted latest first.
 * Skips corrupted or invalid entries without throwing.
 */
export function listTrash(workspace: string): TrashEntry[] {
  const dir = trashDir(workspace);
  if (!existsSync(dir)) return [];

  const entries: TrashEntry[] = [];
  for (const name of readdirSync(dir)) {
    // A single stray directory (spaces, unicode, an editor temp dir) must not
    // make `ga list`/`status`/`restore --last`/`gc` throw. Skip it; only
    // explicit user input is validated strictly by `entryDir`.
    if (!isValidId(name)) continue;
    const entry = readEntry(workspace, name);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
}

/**
 * Restore a trashed item back to its original location.
 *
 * @param workspace - The workspace root path
 * @param id - The trash entry ID to restore
 * @returns The restored file path
 */
export function restore(workspace: string, id: string): string {
  const entry = readEntry(workspace, id);
  if (!entry) throw new Error(`GA_TRASH_NOT_FOUND: ${id}`);

  if (existsSync(entry.originalPath)) {
    throw new Error(`GA_TRASH_RESTORE_CONFLICT: ${entry.originalPath}`);
  }

  if (!isInsideWorkspace(workspace, entry.originalPath)) {
    throw new Error(`GA_TRASH_REFUSED: outside workspace: ${entry.originalPath}`);
  }
  assertNoSymlinkComponents(workspace, entry.originalPath);

  const dir = entryDir(workspace, id);
  const payload = join(dir, "payload");
  if (!existsSync(payload)) {
    throw new Error(`GA_TRASH_NOT_FOUND: payload missing for ${id}`);
  }

  mkdirSync(dirname(entry.originalPath), { recursive: true });
  renameSync(payload, entry.originalPath);
  rmSync(dir, { recursive: true, force: true });
  return entry.originalPath;
}

/**
 * Remove expired trash entries older than TRASH_TTL_MS (24 hours).
 * Corrupted or future timestamps are treated as expired to prevent leak.
 *
 * @param workspace - The workspace root path
 * @param now - Optional timestamp supplier (defaults to Date.now)
 * @returns The number of removed entries
 */
export function gc(workspace: string, now: () => number = Date.now): number {
  const current = now();
  const cutoff = current - TRASH_TTL_MS;
  let removed = 0;

  for (const entry of listTrash(workspace)) {
    const deletedAt = Date.parse(entry.deletedAt);

    // A trash entry can never be deleted in the future, so an unparsable or
    // future timestamp is corruption/tampering, not a young entry. Treat both
    // as expired; otherwise a single edited meta.json makes an entry immortal.
    const valid = Number.isFinite(deletedAt) && deletedAt <= current;
    const effective = valid ? deletedAt : cutoff - 1;

    if (effective < cutoff) {
      rmSync(entryDir(workspace, entry.id), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
