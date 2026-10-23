export type Tier = "allow" | "ask" | "block";

export type ToolName =
  | "bash"
  | "write"
  | "edit"
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "patch";

export type ToolCall = {
  toolName: ToolName;
  input: Record<string, unknown>;
};

/**
 * An approval scope. `ruleId` is the identity of the rule that produced the
 * `ask` verdict; without it a single approval would cover every `ask`-tier
 * command in the workspace (approving `git push` would also allow `sudo`,
 * recursive chmod, and docker prune).
 */
export type Scope = {
  workspace: string;
  sessionId: string;
  scopePath: string;
  ruleId: string;
};

export type PolicyRule = {
  match: { tool?: string; command?: string; path?: string };
  tier: Tier;
  reason?: string;
  /** Set only by mergePolicy for rules originating from the user's global config. */
  source?: "global";
};

export type PolicyConfig = { rules: PolicyRule[] };

export type GuardResult = {
  verdict: Tier;
  reason?: string;
  replacement?: { kind: "trash"; path: string };
  /**
   * Stable identity of the rule that produced this verdict. Used to scope
   * approvals so that one approval cannot unlock a different rule's commands.
   */
  ruleId?: string;
  /**
   * Specific path to scope this approval to, if narrower than the workspace root.
   */
  scopePath?: string;
};

export type ApprovalStore = {
  check(scope: Scope, now: number): boolean;
  grant(scope: Scope, now: number, reason?: string): void;
  revoke(scope: Scope): void;
  gc(now: number): number;
};

export type AuditSink = {
  append(entry: Record<string, unknown>): void;
};

/**
 * Why an `ask` verdict did not turn into an approval. Carried back from the
 * adapter so the audit trail can distinguish a real user denial from a
 * timeout, a headless run with no UI, or a transport failure. All of them are
 * fail-closed, but conflating them hides operational problems behind a
 * message that blames the user.
 */
export type ConfirmDenialReason =
  | "denied by the user"
  | "approval timeout"
  | "TUI is not running"
  | (string & {});

/**
 * Adapter reply to a confirmation request. A bare boolean stays supported so
 * simple adapters and tests keep working; richer adapters return the object
 * form to explain a denial.
 */
export type ConfirmResult = boolean | { approved: boolean; denialReason?: ConfirmDenialReason };

export type GuardDeps = {
  workspace: string;
  sessionId: string;
  confirm(title: string, message: string): Promise<ConfirmResult>;
  now(): number;
  policy: PolicyConfig;
  approvals: ApprovalStore;
  audit: AuditSink;
};
