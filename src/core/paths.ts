import { resolve, sep } from "node:path";

/**
 * Resolve `input` against `workspace` without touching the filesystem.
 * Absolute inputs are normalized and kept; relative inputs resolve against
 * the workspace. `.` and `..` segments are normalized lexically. No
 * realpath/symlink resolution is performed.
 */
export function resolveLexical(workspace: string, input: string): string {
  return resolve(workspace, input);
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
 * Throw unless `path` is strictly inside `sandboxRoot`.
 * The error message always starts with `GA_SANDBOX_VIOLATION:`.
 */
export function assertInSandbox(path: string, sandboxRoot: string): void {
  const root = resolve(sandboxRoot);
  const resolved = resolve(sandboxRoot, path);

  if (!isInsideWorkspace(root, resolved)) {
    throw new Error(
      `GA_SANDBOX_VIOLATION: ${resolved} is outside sandbox ${root}`,
    );
  }
}
