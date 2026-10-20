import { describe, expect, test } from "bun:test";

/**
 * Regression: pelaporan false positive harus bisa membedakan block milik
 * Guardian Angel dari block milik guard lain di harness.
 *
 * Sebelum ini, `scripts/run-false-positive-test.ts` hanya menghitung baris
 * audit.jsonl. Akibatnya block dari CC Safety Net / destructive-guard.js tidak
 * terlihat, model salah mengatribusikan block ke GA, dan "0 false positive"
 * bisa berarti "plugin GA tidak termuat sama sekali".
 */

const EXTERNAL_GUARD_SIGNATURES: Array<{ label: string; re: RegExp }> = [
  { label: "Destructive Command Guard", re: /destructive[- ]command guard/i },
  { label: "destructive-guard.js", re: /destructive-guard(?:\.js)?/i },
  { label: "CC Safety Net", re: /cc[- ]safety[- ]net/i },
  { label: "Safety Net failed closed", re: /safety net failed closed/i },
];

function detectExternalGuards(output: string): string[] {
  return EXTERNAL_GUARD_SIGNATURES.filter((s) => s.re.test(output)).map((s) => s.label);
}

function ruleIdOf(e: { ruleId?: string; scopeKey?: string }): string {
  if (e.ruleId) return e.ruleId;
  if (e.scopeKey) return e.scopeKey.split("\u0000").pop() ?? "-";
  return "-";
}

describe("REGRESSION: atribusi block GA vs guard eksternal", () => {
  test("mengenali pesan Destructive Command Guard", () => {
    expect(
      detectExternalGuards("The shell heredoc was blocked by the Destructive Command Guard"),
    ).toEqual(["Destructive Command Guard"]);
  });

  test("mengenali CC Safety Net dan varian 'failed closed'", () => {
    expect(
      detectExternalGuards("Error: CC Safety Net failed closed because command analysis failed"),
    ).toEqual(["CC Safety Net", "Safety Net failed closed"]);
  });

  test("mengenali path plugin destructive-guard.js", () => {
    expect(
      detectExternalGuards("blocked by ~/.config/opencode/plugins/destructive-guard.js"),
    ).toEqual(["destructive-guard.js"]);
  });

  test("pesan guardian-angel sendiri BUKAN guard eksternal", () => {
    expect(detectExternalGuards("Error: [guardian-angel] rm -rf / ditolak")).toEqual([]);
  });

  test("output bersih tidak memicu deteksi apa pun", () => {
    expect(detectExternalGuards("all tests passed, nothing blocked")).toEqual([]);
  });
});

describe("REGRESSION: ruleId diturunkan dari scopeKey bila field ruleId absen", () => {
  test("scopeKey dengan empat segmen mengambil segmen terakhir", () => {
    expect(
      ruleIdOf({ scopeKey: "/ws\u0000ses_1\u0000/ws/file.ts\u0000ask:write-outside" }),
    ).toBe("ask:write-outside");
  });

  test("field ruleId eksplisit menang atas scopeKey", () => {
    expect(ruleIdOf({ ruleId: "block:rm-root", scopeKey: "x\u0000y" })).toBe("block:rm-root");
  });

  test("entri tanpa ruleId dan scopeKey menghasilkan tanda hubung", () => {
    expect(ruleIdOf({})).toBe("-");
  });
});
