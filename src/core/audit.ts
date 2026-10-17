import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditSink } from "./types.ts";

export type AuditEntry = {
  ts: string;
  sessionId: string;
  tool: string;
  tier: "allow" | "ask" | "block" | "rewrite" | "classifier_error";
  reason?: string;
  scopeKey?: string;
  command?: string;
};

// Keys are matched case-insensitively. Quoted values are consumed whole so
// spaces inside a secret never leak past the redaction boundary; the
// --password space form is handled separately from the key=value form.
const EQUALS_FORM =
  /(--password|password|passwd|token|secret|api_key)(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s&;,'"]+)/gi;
const SPACE_FORM =
  /(--password)(\s+)(?:"[^"]*"|'[^']*'|[^\s&;,'"]+)/gi;

export function redact(text: string): string {
  return text
    .replace(SPACE_FORM, "$1$2[REDACTED]")
    .replace(EQUALS_FORM, "$1$2[REDACTED]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = redactValue(inner);
    }
    return out;
  }
  return value;
}

function auditPath(workspace: string): string {
  return join(workspace, ".guardian-angel", "audit.jsonl");
}

function appendLine(workspace: string, entry: Record<string, unknown>): void {
  const file = auditPath(workspace);
  mkdirSync(join(workspace, ".guardian-angel"), { recursive: true });
  const safe = redactValue(entry) as Record<string, unknown>;
  appendFileSync(file, `${JSON.stringify(safe)}\n`, "utf8");
}

export function appendAudit(workspace: string, entry: AuditEntry): void {
  appendLine(workspace, entry);
}

export function createAuditSink(workspace: string): AuditSink {
  return {
    append(entry: Record<string, unknown>): void {
      appendLine(workspace, entry);
    },
  };
}
