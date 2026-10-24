import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditSink } from "./types.ts";

export type AuditEntry = {
  ts: string;
  sessionId: string;
  tool: string;
  tier: "allow" | "ask" | "block" | "rewrite" | "classifier_error";
  ruleId?: string;
  reason?: string;
  scopeKey?: string;
  command?: string;
  /** LLM Security Advisor verdict, recorded for forensic review. */
  advisor?: { risk_level: string; summary: string };
};

// Redaction is a deny-list of *shapes*, not a list of exact key names: a new
// provider will invent a new name long before it invents a new shape. Quoted
// values are consumed whole so spaces inside a secret never leak past the
// redaction boundary.
const SECRET_KEY =
  "password|passwd|pwd|token|secret|api_?key|access_?key|private_?key|" +
  "client_?secret|credential|session_?key|signing_?key|salt";

const QUOTED = `(?:"[^"]*"|'[^']*')`;
const BARE = `[^\\s&;,'"]+`;

// Authorization: Bearer <token> — handled before the generic key/value pass so
// the "Authorization:" part is not mistaken for a key.
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]+)/gi;

// Credentials embedded in a URL: scheme://user:password@host
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)([^/\s@]+)(@)/gi;

// KEY=value, KEY: value, "KEY": "value", and any *_SECRET / *_KEY / *_TOKEN
// suffix (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, STRIPE_SECRET_KEY, ...).
// Optional quotes around the key cover JSON (`"password":"x"`).
const KEY_VALUE = new RegExp(
  `("?[A-Za-z0-9_.-]*(?:${SECRET_KEY})[A-Za-z0-9_.-]*"?)(\\s*[=:]\\s*)(${QUOTED}|${BARE})`,
  "gi",
);

// CLI flags: --password value, --password=value, -p value, -p<value>.
const FLAG_SPACE = new RegExp(
  `(--?[A-Za-z-]*(?:pass|token|secret|key)[A-Za-z-]*)(\\s+)(${QUOTED}|${BARE})`,
  "gi",
);
// Scoped -p redaction: only database clients (-p password) or attached form (-phunter2).
// Avoids redacting standard utility flags like `mkdir -p` or `git log -p`.
const DB_CLIENT_P = /(^|\s)(mysql(?:dump)?|mariadb|psql|pg_dump)(\s+.*?)(-p\s+)(?:[^\s;&|]+)/gi;
const ATTACHED_P = /(^|\s)(-p)([A-Za-z0-9_!@#$%^&*+=.~-]+)/g;

export function redact(text: string): string {
  return text
    .replace(URL_CREDENTIALS, "$1[REDACTED]$3")
    .replace(BEARER, "$1[REDACTED]")
    .replace(DB_CLIENT_P, "$1$2$3$4[REDACTED]")
    .replace(ATTACHED_P, "$1$2[REDACTED]")
    .replace(FLAG_SPACE, "$1$2[REDACTED]")
    .replace(KEY_VALUE, "$1$2[REDACTED]");
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
  const line = `${JSON.stringify(safe)}\n`;

  if (existsSync(file)) {
    try {
      chmodSync(file, 0o600);
    } catch {}
  }

  appendFileSync(file, line, { mode: 0o400, encoding: "utf8" });

  try {
    chmodSync(file, 0o400);
  } catch {}
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
