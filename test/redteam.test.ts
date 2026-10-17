import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/core/classifier.ts";

type RedteamCase = { command: string; expectedTier: string; note: string };

const FIXTURE = join(import.meta.dir, "fixtures", "redteam.jsonl");
const WORKSPACE = "/ws";

const cases: RedteamCase[] = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as RedteamCase);

describe("redteam corpus", () => {
  test("fixture has at least 30 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const item of cases) {
    const isKnownBypass = item.note.startsWith("KNOWN BYPASS");
    test(`${isKnownBypass ? "documents bypass" : "classifies"}: ${item.command}`, () => {
      const result = classify({
        call: { toolName: "bash", input: { command: item.command } },
        workspace: WORKSPACE,
      });
      expect(result.verdict).toBe(item.expectedTier);
    });
  }

  test("every known bypass is explicitly documented", () => {
    const bypasses = cases.filter((c) => c.note.startsWith("KNOWN BYPASS"));
    expect(bypasses.length).toBeGreaterThan(0);
    for (const bypass of bypasses) {
      expect(bypass.note.length).toBeGreaterThan("KNOWN BYPASS:".length);
    }
  });

  test("no case is missing an expectation", () => {
    for (const item of cases) {
      expect(["allow", "ask", "block"]).toContain(item.expectedTier);
      expect(item.note.length).toBeGreaterThan(0);
    }
  });
});
