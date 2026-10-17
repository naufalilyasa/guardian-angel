import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAudit,
  createAuditSink,
  redact,
  type AuditEntry,
} from "../src/core/audit.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "ga-audit-"));
}

const baseEntry = (command?: string): AuditEntry => ({
  ts: "2026-10-17T00:00:00.000Z",
  sessionId: "s1",
  tool: "bash",
  tier: "block",
  ...(command === undefined ? {} : { command }),
});

function readLines(ws: string): string[] {
  return readFileSync(join(ws, ".guardian-angel", "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("redact", () => {
  test("redacts password=", () => {
    expect(redact("mysql password=hunter2")).toBe("mysql password=[REDACTED]");
  });

  test("redacts --password space form", () => {
    expect(redact("tool --password hunter2")).toBe("tool --password [REDACTED]");
  });

  test("redacts uppercase TOKEN=", () => {
    expect(redact("TOKEN=abc123")).toBe("TOKEN=[REDACTED]");
  });

  test("redacts api_key=", () => {
    expect(redact("api_key=xyz")).toBe("api_key=[REDACTED]");
  });

  test("redacts secret=", () => {
    expect(redact("secret=s3cr3t")).toBe("secret=[REDACTED]");
  });

  test("keeps the key text", () => {
    expect(redact("password=hunter2")).toContain("password=");
  });

  test("does not alter ordinary text", () => {
    expect(redact("ls -la src")).toBe("ls -la src");
  });

  test("redacts multiple secrets in one string", () => {
    const result = redact("password=a token=b");
    expect(result).not.toContain("password=a");
    expect(result).not.toContain("token=b");
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2);
  });
});

describe("appendAudit", () => {
  test("appends exactly one line per call", () => {
    const ws = workspace();
    appendAudit(ws, baseEntry("rm -rf /"));
    expect(readLines(ws)).toHaveLength(1);
    appendAudit(ws, baseEntry("DROP TABLE t"));
    expect(readLines(ws)).toHaveLength(2);
  });

  test("writes valid JSON", () => {
    const ws = workspace();
    appendAudit(ws, baseEntry("rm -rf /"));
    const parsed = JSON.parse(readLines(ws)[0]);
    expect(parsed.tier).toBe("block");
    expect(parsed.tool).toBe("bash");
  });

  test("preserves prior lines when appending", () => {
    const ws = workspace();
    appendAudit(ws, baseEntry("first"));
    appendAudit(ws, baseEntry("second"));
    const lines = readLines(ws);
    expect(JSON.parse(lines[0]).command).toBe("first");
    expect(JSON.parse(lines[1]).command).toBe("second");
  });

  test("redacts secrets in the command field", () => {
    const ws = workspace();
    appendAudit(ws, baseEntry("mysql password=hunter2"));
    const line = readLines(ws)[0];
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("hunter2");
  });
});

describe("createAuditSink", () => {
  test("writes through the AuditSink interface", () => {
    const ws = workspace();
    const sink = createAuditSink(ws);
    sink.append({ tier: "ask", tool: "bash", command: "git push" });
    expect(readLines(ws)).toHaveLength(1);
  });

  test("redacts nested string fields", () => {
    const ws = workspace();
    const sink = createAuditSink(ws);
    sink.append({ tier: "block", detail: { command: "password=hunter2" } });
    expect(readLines(ws)[0]).not.toContain("hunter2");
  });
});
