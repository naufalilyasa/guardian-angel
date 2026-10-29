import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

/**
 * Extract active session ID from the current TUI route, if on a session page.
 */
export function getActiveSessionId(api: Partial<TuiPluginApi>): string | undefined {
  const current = api.route?.current;
  if (
    current &&
    current.name === "session" &&
    typeof (current as { params?: { sessionID?: unknown } }).params?.sessionID === "string"
  ) {
    return (current as { params: { sessionID: string } }).params.sessionID;
  }
  return undefined;
}

/**
 * Check whether a pending IPC request belongs to the currently active session.
 *
 * A request belongs to the active session if:
 * 1. No active session ID is known (fallback / test environments).
 * 2. `req.sessionID === activeSessionId` (direct call by main agent).
 * 3. `req.sessionID` is a child, grandchild, or subagent session whose ancestor
 *    chain traces back to `activeSessionId` (subagents launched via task tool).
 *
 * `sessionGet` overrides the session lookup used for the ancestor walk
 * (v2 adapters pass `context.data.session.get`; v1 uses `api.state.session`).
 */
export function shouldHandleRequest(
  req: { sessionID: string },
  activeSessionId: string | undefined,
  api?: Partial<TuiPluginApi>,
  sessionGet?: (id: string) => { parentID?: string } | undefined,
): boolean {
  if (!activeSessionId) return true;
  if (req.sessionID === activeSessionId) return true;

  const lookup = sessionGet ?? api?.state?.session?.get;
  // Bubble up child / subagent sessions to active parent session
  if (lookup) {
    let currentId: string | undefined = req.sessionID;
    const visited = new Set<string>();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const session = lookup(currentId);
      if (!session) break;
      if (session.parentID === activeSessionId) return true;
      currentId = session.parentID;
    }
  }

  return false;
}
