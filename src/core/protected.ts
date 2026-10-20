import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolvePhysical } from "./paths.ts";

/**
 * Entries inside a workspace that the guarded agent must never modify.
 * `.guardian-angel` holds the audit log, approvals and trash; `.git` holds
 * repository history. Both are compared case-insensitively because the
 * default macOS filesystem is case-insensitive.
 */
export const PROTECTED_ENTRIES: readonly string[] = [".guardian-angel", ".git"];

function checkRelative(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return false;
  const first = rel.split(sep)[0]?.toLowerCase();
  return PROTECTED_ENTRIES.some((entry) => entry === first);
}

/**
 * True when `candidate` is (or lives under) a protected entry of `workspace`.
 * Paths outside the workspace are not "protected" — they are handled by the
 * outside-workspace rules instead. Resolves physical root to handle symlinked
 * roots (such as macOS /tmp -> /private/tmp).
 */
export function isProtectedPath(workspace: string, candidate: string): boolean {
  const root = resolve(workspace);
  const resolved = resolve(workspace, candidate);
  if (checkRelative(root, resolved)) return true;

  const physRoot = resolvePhysical(workspace, workspace);
  const physResolved = resolvePhysical(workspace, candidate);
  return checkRelative(physRoot, physResolved);
}

export function protectedReason(candidate: string): string {
  return `${candidate} is inside a guardian-angel protected area; changes are rejected`;
}
