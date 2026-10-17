export type {
  Tier,
  ToolName,
  ToolCall,
  Scope,
  PolicyRule,
  PolicyConfig,
  GuardResult,
  ApprovalStore,
  AuditSink,
  GuardDeps,
} from "./core/types.ts";

export {
  resolveLexical,
  isInsideWorkspace,
  assertInSandbox,
} from "./core/paths.ts";

export { classify, splitSegments } from "./core/classifier.ts";
export type { ClassifierInput } from "./core/classifier.ts";

export { classifySql } from "./core/sql.ts";
export type { SqlVerdict } from "./core/sql.ts";

export {
  BUILTIN_RULES,
  loadPolicyFromFiles,
  matchRule,
  mergePolicy,
  parsePolicyConfig,
} from "./core/policy.ts";
export type { LoadedPolicy, PolicyLayer } from "./core/policy.ts";

export {
  approvalsFile,
  auditFile,
  ensureStore,
  storeDir,
  trashDir,
} from "./core/store.ts";

export {
  gc,
  listTrash,
  restore,
  safeDelete,
  TRASH_TTL_MS,
} from "./core/trash.ts";
export type { TrashEntry } from "./core/trash.ts";

export {
  APPROVAL_TTL_MS,
  createApprovalStore,
  scopeKey,
} from "./core/approvals.ts";

export { appendAudit, createAuditSink, redact } from "./core/audit.ts";
export type { AuditEntry } from "./core/audit.ts";

export { guard } from "./core/guard.ts";
