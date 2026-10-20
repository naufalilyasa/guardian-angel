/**
 * Pure view helpers for the Guardian Angel permission dialog.
 *
 * The dialog mirrors OpenCode's native `question` tool presentation: a short
 * header, the full question body, and labelled choices with descriptions.
 * Keeping the formatting here (no TUI imports) makes it testable without a
 * terminal and keeps `tui.ts` focused on IPC and dialog lifecycle.
 */

export type GuardRequestView = {
  /** Very short label, max 30 chars, shown as the dialog header. */
  header: string;
  /** Complete question text shown as the dialog body. */
  question: string;
  /** Human-readable tool label, e.g. "Shell command" or "Write file". */
  toolLabel: string;
  /** The command or path under review. */
  detail: string;
  /** Why the guard stopped the call. */
  reason: string;
};

export type GuardChoice = {
  label: string;
  description: string;
  value: "allow" | "deny";
};

const TOOL_LABELS: Record<string, string> = {
  bash: "Shell command",
  write: "Write file",
  edit: "Edit file",
  patch: "Patch file",
};

const MAX_HEADER = 30;
const MAX_DETAIL = 120;

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}

/** Derive the dialog header from the rule id, e.g. "ask:git-push" -> "git-push". */
function headerFromRuleId(ruleId: string): string {
  const bare = ruleId.replace(/^(ask|block|rewrite):/, "");
  const label = `Guardian Angel: ${bare}`;
  return label.length <= MAX_HEADER ? label : `${label.slice(0, MAX_HEADER - 1)}…`;
}

/**
 * Build the English dialog content for a pending guard request.
 *
 * `detail` is the command (bash) or path (write/edit/patch). It is collapsed to
 * a single line and truncated so a long command cannot push the choices off
 * screen; the full text stays in the audit log.
 */
export function describeGuardRequest(req: {
  ruleId: string;
  reason: string;
  tool: string;
  command?: string;
  path?: string;
}): GuardRequestView {
  const toolLabel = TOOL_LABELS[req.tool] ?? req.tool;
  const rawDetail = req.command ?? req.path ?? "(no additional detail)";
  const detail = truncate(rawDetail, MAX_DETAIL);
  const reason = req.reason.trim();

  return {
    header: headerFromRuleId(req.ruleId),
    question: `Allow Guardian Angel to run this ${toolLabel.toLowerCase()}?`,
    toolLabel,
    detail,
    reason,
  };
}

/**
 * The two choices offered for every guard request.
 *
 * `Allow` is deliberately not the default: the dialog opens with `Deny`
 * selected so an accidental Enter cannot execute a destructive command.
 */
export function guardChoices(): GuardChoice[] {
  return [
    {
      label: "Deny",
      description: "Block this call (safe default, ESC also denies)",
      value: "deny",
    },
    {
      label: "Allow",
      description: "Run it once and remember this rule for 24 hours",
      value: "allow",
    },
  ];
}

/** Multi-line body shown inside the dialog: question, detail, then reason. */
export function renderGuardBody(view: GuardRequestView): string {
  return [
    view.question,
    "",
    `${view.toolLabel}:`,
    `  ${view.detail}`,
    "",
    `Why: ${view.reason}`,
  ].join("\n");
}
