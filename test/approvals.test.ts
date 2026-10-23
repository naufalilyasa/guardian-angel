import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_TTL_MS,
  createApprovalStore,
  scopeKey,
} from "../src/core/approvals.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "ga-approvals-"));
}

const scope = (ws: string, path = "src/a.ts", ruleId = "ask:sudo") => ({
  workspace: ws,
  sessionId: "session-1",
  scopePath: path,
  ruleId,
});

describe("scopeKey", () => {
  test("combines workspace, session, scope path, and rule", () => {
    expect(scopeKey(scope("/ws"))).toBe("/ws\u0000session-1\u0000src/a.ts\u0000ask:sudo");
  });

  test("differs when the scope path differs", () => {
    const ws = "/ws";
    expect(scopeKey(scope(ws, "a"))).not.toBe(scopeKey(scope(ws, "b")));
  });

  test("REGRESSION: differs when only the rule differs", () => {
    const ws = "/ws";
    expect(scopeKey(scope(ws, "a", "ask:sudo"))).not.toBe(
      scopeKey(scope(ws, "a", "ask:git-push")),
    );
  });
});

describe("createApprovalStore", () => {
  test("grant then check returns true", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });
    const now = 1_700_000_000_000;

    store.grant(scope(ws), now);

    expect(store.check(scope(ws), now)).toBe(true);
  });

  test("check is false for a different scope", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });
    const now = 1_700_000_000_000;

    store.grant(scope(ws, "a"), now);

    expect(store.check(scope(ws, "b"), now)).toBe(false);
  });

  test("check is false for a different session", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });
    const now = 1_700_000_000_000;

    store.grant(scope(ws), now);

    expect(
      store.check({ workspace: ws, sessionId: "other", scopePath: "src/a.ts", ruleId: "ask:sudo" }, now),
    ).toBe(false);
  });

  test("expires after the TTL", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });
    const now = 1_700_000_000_000;

    store.grant(scope(ws), now);

    expect(store.check(scope(ws), now + APPROVAL_TTL_MS - 1)).toBe(true);
    expect(store.check(scope(ws), now + APPROVAL_TTL_MS)).toBe(false);
  });

  test("revoke removes the approval", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });
    const now = 1_700_000_000_000;

    store.grant(scope(ws), now);
    store.revoke(scope(ws));

    expect(store.check(scope(ws), now)).toBe(false);
  });

  test("gc removes only expired entries", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });
    const now = 1_700_000_000_000;

    store.grant(scope(ws, "old"), now);
    store.grant(scope(ws, "fresh"), now + APPROVAL_TTL_MS);

    const removed = store.gc(now + APPROVAL_TTL_MS + 1);

    expect(removed).toBe(1);
    expect(store.check(scope(ws, "old"), now + APPROVAL_TTL_MS + 1)).toBe(false);
    expect(store.check(scope(ws, "fresh"), now + APPROVAL_TTL_MS + 1)).toBe(true);
  });

  test("treats a corrupt file as empty without throwing", () => {
    const ws = workspace();
    mkdirSync(join(ws, ".guardian-angel"), { recursive: true });
    writeFileSync(join(ws, ".guardian-angel", "approvals.json"), "{", "utf8");

    const store = createApprovalStore({ workspace: ws });

    expect(() => store.check(scope(ws), 1)).not.toThrow();
    expect(store.check(scope(ws), 1)).toBe(false);
  });

  test("leaves no .tmp file after an atomic write", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });

    store.grant(scope(ws), 1_700_000_000_000);

    const files = readdirSync(join(ws, ".guardian-angel"));
    expect(files).not.toContain("approvals.json.tmp");
  });

  test("list returns only live entries", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });
    const now = 1_700_000_000_000;

    store.grant(scope(ws, "a"), now);
    store.grant(scope(ws, "b"), now);

    expect(store.list(now)).toHaveLength(2);
    expect(store.list(now + APPROVAL_TTL_MS)).toHaveLength(0);
  });

  test("TTL is 24 hours", () => {
    expect(APPROVAL_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("approvals.json is saved on disk with mode 0o400 read-only permissions", () => {
    const ws = workspace();
    const store = createApprovalStore({ workspace: ws });
    store.grant(scope(ws, "file.ts"), 1_700_000_000_000);

    const target = join(ws, ".guardian-angel", "approvals.json");
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o400);

    // Direct unauthorized write fails with EACCES
    expect(() => writeFileSync(target, "forged-content", "utf8")).toThrow();
  });

  test("tripwire detects external modification of approvals.json and purges forged entries", () => {
    const ws = workspace();
    let tamperReported: string | null = null;
    const store = createApprovalStore({
      workspace: ws,
      onTamper: (msg) => {
        tamperReported = msg;
      },
    });

    const now = 1_700_000_000_000;
    store.grant(scope(ws, "legit.ts", "ask:git-push"), now);
    expect(store.check(scope(ws, "legit.ts", "ask:git-push"), now)).toBe(true);

    // Attacker modifies approvals.json externally (e.g. chmod 0o600 + write forged entry)
    const target = join(ws, ".guardian-angel", "approvals.json");
    chmodSync(target, 0o600);
    const existing = JSON.parse(readFileSync(target, "utf8"));
    const forgedKey = scopeKey(scope(ws, "anything", "ask:sudo"));
    existing.entries[forgedKey] = {
      grantedAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
    };
    writeFileSync(target, JSON.stringify(existing, null, 2), "utf8");

    // Next check detects hash mismatch against witness
    const result = store.check(scope(ws, "anything", "ask:sudo"), now);

    // Forged approval is NOT granted!
    expect(result).toBe(false);
    expect(String(tamperReported)).toContain("approvals.json modified externally");

    // Legitimate check also resets because the store was tampered
    expect(store.check(scope(ws, "legit.ts", "ask:git-push"), now)).toBe(false);
  });
});
