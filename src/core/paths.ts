import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 */
export function expandHome(input: string): string {
  if (!input) return input;
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return resolve(homedir(), input.slice(2));
  }
  return input;
}

/**
 * Resolve `input` against `workspace` without touching the filesystem.
 * Absolute inputs are normalized and kept; relative inputs resolve against
 * the workspace. `.` and `..` segments are normalized lexically. No
 * realpath/symlink resolution is performed.
 */
export function resolveLexical(workspace: string, input: string): string {
  return resolve(workspace, expandHome(input));
}

/**
 * True only when `candidate` is strictly inside `workspace` (never equal to
 * the workspace root). Both paths are normalized lexically first, so
 * traversal such as `/ws/../etc` and sibling prefixes such as `/ws-other`
 * are rejected.
 */
export function isInsideWorkspace(
  workspace: string,
  candidate: string,
): boolean {
  if (!workspace || !candidate) return false;

  const root = resolve(workspace);
  const resolved = resolve(workspace, candidate);

  if (resolved === root) return false;
  return resolved.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve `input` against `workspace` and follow symlinks in every component
 * that already exists on disk. Dangling symlinks are traversed to their declared
 * targets so an in-workspace symlink pointing outside is not mistakenly treated
 * as an in-workspace path. The non-existent tail is appended verbatim.
 */
export function resolvePhysical(workspace: string, input: string): string {
  let current = resolve(workspace, expandHome(input));
  const tail: string[] = [];
  const seen = new Set<string>();
  let hops = 0;

  while (hops++ < 40) {
    if (seen.has(current)) break;
    seen.add(current);

    let isSymlink = false;
    let exists = false;
    try {
      const st = lstatSync(current);
      exists = true;
      isSymlink = st.isSymbolicLink();
    } catch {}

    if (isSymlink) {
      try {
        const linkTarget = resolve(dirname(current), readlinkSync(current));
        current = tail.length > 0 ? resolve(linkTarget, ...tail) : linkTarget;
        tail.length = 0;
        continue;
      } catch {}
    }

    if (exists) {
      try {
        current = realpathSync(current);
      } catch {}
      break;
    }

    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }

  return tail.length > 0 ? resolve(current, ...tail) : current;
}

/** True when `input` resolves, through symlinks, to a path inside `workspace`. */
export function isInsideWorkspacePhysical(
  workspace: string,
  input: string,
): boolean {
  if (!workspace || !input) return false;
  return isInsideWorkspace(
    resolvePhysical(workspace, workspace),
    resolvePhysical(workspace, input),
  );
}

/**
 * Throw unless `path` is strictly inside `sandboxRoot`.
 * The error message always starts with `GA_SANDBOX_VIOLATION:`.
 */
export function assertInSandbox(path: string, sandboxRoot: string): void {
  const root = resolve(sandboxRoot);
  const resolved = resolve(sandboxRoot, path);

  if (!isInsideWorkspace(root, resolved) && !isInsideWorkspacePhysical(root, resolved)) {
    throw new Error(
      `GA_SANDBOX_VIOLATION: ${resolved} is outside sandbox ${root}`,
    );
  }
}

/**
 * Extract target file path from tool input. Normalizes differences across
 * harnesses (e.g. OpenCode uses `filePath`, Senpi uses `path`, other tools
 * use `targetPath` or `file`).
 */
export function extractPath(input?: Record<string, unknown> | null): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "filePath", "targetPath", "file"]) {
    const val = input[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return undefined;
}

