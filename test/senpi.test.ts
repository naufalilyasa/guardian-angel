import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../src/adapters/senpi.ts";
import { BUILTIN_RULES } from "../src/core/policy.ts";
import type { GuardDeps, GuardResult, ToolCall } from "../src/core/types.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "ga-senpi-"));
}

const event = (command: string) =>
  ({
    type: "custom",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command },
  }) as never;

const context = (
  ws: string,
  opts: { sessionId?: () => string } = {},
) =>
  ({
    cwd: ws,
    hasUI: true,
    sessionManager: { getSessionId: opts.sessionId ?? (() => "session-1") },
    ui: { confirm: async () => true },
  }) as never;

type GuardFn = (call: ToolCall, deps: GuardDeps) => Promise<GuardResult>;

describe("adapter fail-closed behaviour", () => {
  test("REGRESSION: a policy load failure keeps the builtin rules", async () => {
    const ws = workspace();
    let sawBlockRule = false;

    const handler = createHandler({
      pkgRoot: "/pkg",
      loadPolicy: () => {
        throw new Error("boom");
      },
      guardFn: (async (_call: ToolCall, deps: GuardDeps) => {
        sawBlockRule = deps.policy.rules.some((r) => r.tier === "block");
        return { verdict: "block", reason: "probe" };
      }) as unknown as GuardFn,
    });

    const result = await handler(event("rm -rf /"), context(ws));

    expect(sawBlockRule).toBe(true);
    expect(result?.block).toBe(true);
  });

  test("REGRESSION: the builtin fallback contains every builtin rule", async () => {
    const ws = workspace();
    let ruleCount = -1;

    const handler = createHandler({
      pkgRoot: "/pkg",
      loadPolicy: () => {
        throw new Error("boom");
      },
      guardFn: (async (_call: ToolCall, deps: GuardDeps) => {
        ruleCount = deps.policy.rules.length;
        return { verdict: "allow" };
      }) as unknown as GuardFn,
    });

    await handler(event("ls"), context(ws));

    expect(ruleCount).toBe(BUILTIN_RULES.length);
  });

  test("REGRESSION: a failing session id does not collapse every session into one", async () => {
    const ws = workspace();
    const seen: string[] = [];

    const handler = createHandler({
      pkgRoot: "/pkg",
      loadPolicy: () => ({ rules: BUILTIN_RULES, warnings: [] }),
      guardFn: (async (_call: ToolCall, deps: GuardDeps) => {
        seen.push(deps.sessionId);
        return { verdict: "allow" };
      }) as unknown as GuardFn,
    });

    const throwing = context(ws, {
      sessionId: () => {
        throw new Error("no session");
      },
    });

    await handler(event("ls"), throwing);
    await handler(event("ls"), throwing);

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe("unknown-session");
    expect(seen[0]).toBe(seen[1]);
  });

  test("a store that cannot be prepared does not break the tool call", async () => {
    const ws = workspace();
    writeFileSync(join(ws, ".guardian-angel"), "not a directory", "utf8");

    const handler = createHandler({
      pkgRoot: "/pkg",
      loadPolicy: () => ({ rules: BUILTIN_RULES, warnings: [] }),
      guardFn: (async () => ({ verdict: "allow" })) as unknown as GuardFn,
    });

    await expect(handler(event("ls"), context(ws))).resolves.toBeUndefined();
  });
});
