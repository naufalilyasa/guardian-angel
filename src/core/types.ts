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

export type GuardDeps = {
  workspace: string;
  sessionId: string;
  confirm(title: string, message: string): Promise<boolean>;
  now(): number;
  policy: PolicyConfig;
  approvals: ApprovalStore;
  audit: AuditSink;
};
