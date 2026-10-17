import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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

const scope = (ws: string, path = "src/a.ts") => ({
  workspace: ws,
  sessionId: "session-1",
  scopePath: path,
});

describe("scopeKey", () => {
  test("combines workspace, session, and scope path", () => {
    expect(scopeKey(scope("/ws"))).toBe("/ws\u0000session-1\u0000src/a.ts");
  });

  test("differs when the scope path differs", () => {
    const ws = "/ws";
    expect(scopeKey(scope(ws, "a"))).not.toBe(scopeKey(scope(ws, "b")));
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
      store.check({ workspace: ws, sessionId: "other", scopePath: "src/a.ts" }, now),
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
});
