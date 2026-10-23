import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

  describe("REGRESSION: secret shapes that used to leak", () => {
    const leaks: Array<[string, string]> = [
      ["AWS_SECRET_ACCESS_KEY=abc123", "abc123"],
      ["AWS_ACCESS_KEY_ID=AKIA123", "AKIA123"],
      ["GITHUB_TOKEN=ghp_abc", "ghp_abc"],
      ["STRIPE_SECRET_KEY=sk_live_x", "sk_live_x"],
      ["DB_PASSWORD=hunter2", "hunter2"],
      ["CLIENT_SECRET=shh", "shh"],
      ["Authorization: Bearer tok123", "tok123"],
      ["curl -H 'Authorization: Bearer tok123' https://x", "tok123"],
      ["mysql -p hunter2", "hunter2"],
      ["mysql -phunter2", "hunter2"],
      ["mysql --password hunter2", "hunter2"],
      ['{"password":"hunter2"}', "hunter2"],
      ["psql postgres://user:secret@localhost/db", "secret"],
      ["git clone https://user:token123@github.com/x/y", "token123"],
    ];

    for (const [input, secret] of leaks) {
      test(`redacts ${input}`, () => {
        const result = redact(input);
        expect(result).not.toContain(secret);
        expect(result).toContain("[REDACTED]");
      });
    }

    test("keeps the key name visible", () => {
      expect(redact("AWS_SECRET_ACCESS_KEY=abc123")).toContain("AWS_SECRET_ACCESS_KEY=");
      expect(redact("Authorization: Bearer tok123")).toContain("Authorization:");
    });

    test("does not redact ordinary assignments", () => {
      expect(redact("NORMAL_VAR=hello")).toBe("NORMAL_VAR=hello");
      expect(redact("echo $HOME")).toBe("echo $HOME");
      expect(redact("ls -la src")).toBe("ls -la src");
      expect(redact("mkdir -p /tmp/build/dir")).toBe("mkdir -p /tmp/build/dir");
      expect(redact("git log -p src/file.ts")).toBe("git log -p src/file.ts");
    });
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
  test("preserves ruleId when provided", () => {
    const ws = workspace();
    appendAudit(ws, {
      ...baseEntry("ls"),
      ruleId: "block:rm-root",
    });
    const parsed = JSON.parse(readLines(ws)[0]);
    expect(parsed.ruleId).toBe("block:rm-root");
  });

  test("audit.jsonl is locked with mode 0o400 preventing unauthorized truncate/write", () => {
    const ws = workspace();
    appendAudit(ws, baseEntry("command 1"));

    const auditFile = join(ws, ".guardian-angel", "audit.jsonl");
    const mode = statSync(auditFile).mode & 0o777;
    expect(mode).toBe(0o400);

    // Direct unauthorized write/truncate fails with EACCES
    expect(() => writeFileSync(auditFile, "truncate attack", "utf8")).toThrow();

    // Legitimate appendAudit still succeeds and preserves 0o400 mode
    appendAudit(ws, baseEntry("command 2"));
    expect(readLines(ws)).toHaveLength(2);
    expect(statSync(auditFile).mode & 0o777).toBe(0o400);
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
