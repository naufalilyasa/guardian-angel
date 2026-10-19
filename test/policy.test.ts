import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_RULES,
  loadPolicyFromFiles,
  matchRule,
  mergePolicy,
  parsePolicyConfig,
  type PolicyLayer,
} from "../src/core/policy.ts";

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "ga-policy-"));
}

function writeProjectConfig(workspace: string, raw: unknown): void {
  mkdirSync(join(workspace, ".guardian-angel"), { recursive: true });
  writeFileSync(
    join(workspace, ".guardian-angel", "config.json"),
    JSON.stringify(raw),
    "utf8",
  );
}

function writeGlobalConfig(home: string, raw: unknown): void {
  mkdirSync(join(home, ".config", "guardian-angel"), { recursive: true });
  writeFileSync(
    join(home, ".config", "guardian-angel", "config.json"),
    JSON.stringify(raw),
    "utf8",
  );
}

describe("parsePolicyConfig", () => {
  test("accepts a valid config", () => {
    const result = parsePolicyConfig({
      rules: [{ match: { tool: "bash", command: "git push*" }, tier: "ask" }],
    });
    expect(result.config?.rules).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  test("rejects null", () => {
    expect(parsePolicyConfig(null).config).toBeNull();
    expect(parsePolicyConfig(null).error).toBeTruthy();
  });

  test("rejects an array", () => {
    expect(parsePolicyConfig([]).config).toBeNull();
  });

  test("rejects a non-array rules field", () => {
    expect(parsePolicyConfig({ rules: "x" }).config).toBeNull();
  });

  test("rejects an unknown tier", () => {
    const result = parsePolicyConfig({
      rules: [{ match: { tool: "bash" }, tier: "nope" }],
    });
    expect(result.config).toBeNull();
    expect(result.error).toContain("invalid tier");
  });

  test("rejects a rule without match", () => {
    expect(parsePolicyConfig({ rules: [{ tier: "ask" }] }).config).toBeNull();
  });

  test("rejects a non-string match field", () => {
    expect(
      parsePolicyConfig({ rules: [{ match: { tool: 1 }, tier: "ask" }] }).config,
    ).toBeNull();
  });
});

describe("matchRule", () => {
  test("anchors globs at both ends", () => {
    const rules = [{ match: { tool: "bash", command: "rm -rf *" }, tier: "ask" as const }];
    expect(matchRule(rules, { tool: "bash", command: "rm -rf /tmp" })).not.toBeNull();
    expect(matchRule(rules, { tool: "bash", command: "xrm -rf /tmp" })).toBeNull();
  });

  test("treats an omitted field as a wildcard", () => {
    const rules = [{ match: { tool: "bash" }, tier: "ask" as const }];
    expect(matchRule(rules, { tool: "bash", command: "anything" })).not.toBeNull();
  });

  test("does not match when the subject lacks a required field", () => {
    const rules = [{ match: { command: "git push*" }, tier: "ask" as const }];
    expect(matchRule(rules, { tool: "bash" })).toBeNull();
  });

  test("returns the last match", () => {
    const rules = [
      { match: { tool: "bash" }, tier: "ask" as const, reason: "first" },
      { match: { tool: "bash" }, tier: "block" as const, reason: "second" },
    ];
    expect(matchRule(rules, { tool: "bash" })?.reason).toBe("second");
  });

  test("is case-sensitive", () => {
    const rules = [{ match: { command: "DROP *" }, tier: "block" as const }];
    expect(matchRule(rules, { tool: "bash", command: "drop table" })).toBeNull();
  });
});

describe("mergePolicy", () => {
  test("project cannot lower a builtin block", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "project",
        config: {
          rules: [{ match: { tool: "bash", command: "rm -rf /*" }, tier: "allow", reason: "local" }],
        },
      },
    ];
    const merged = mergePolicy(layers);
    const winning = matchRule(merged.rules, { tool: "bash", command: "rm -rf /" });
    expect(winning?.tier).toBe("block");
    expect(merged.warnings.join(" ")).toContain("project cannot lower block");
  });

  test("global may lower a builtin block", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "global",
        config: {
          rules: [{ match: { tool: "bash", command: "sudo *" }, tier: "allow", reason: "trusted" }],
        },
      },
    ];
    const merged = mergePolicy(layers);
    expect(matchRule(merged.rules, { tool: "bash", command: "sudo ls" })?.tier).toBe("allow");
  });

  test("REGRESSION: global rules are tagged so the guard can treat them as authoritative", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "global",
        config: {
          rules: [{ match: { tool: "bash", command: "rm -rf /*" }, tier: "allow" }],
        },
      },
    ];
    const merged = mergePolicy(layers);
    const rule = matchRule(merged.rules, { tool: "bash", command: "rm -rf /" });
    expect(rule?.tier).toBe("allow");
    expect(rule?.source).toBe("global");
  });

  test("project rules are NOT tagged as global", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "project",
        config: { rules: [{ match: { tool: "bash", command: "my-tool *" }, tier: "ask" }] },
      },
    ];
    const merged = mergePolicy(layers);
    const rule = matchRule(merged.rules, { tool: "bash", command: "my-tool x" });
    expect(rule?.source).toBeUndefined();
  });

  test("project may raise an ask to block", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "project",
        config: {
          rules: [{ match: { tool: "bash", command: "git push*" }, tier: "block", reason: "no push" }],
        },
      },
    ];
    const merged = mergePolicy(layers);
    expect(matchRule(merged.rules, { tool: "bash", command: "git push origin" })?.tier).toBe("block");
  });

  test("REGRESSION: a broad project rule cannot bypass a builtin block and does not block benign commands", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "project",
        config: { rules: [{ match: { tool: "bash" }, tier: "allow", reason: "broad allow" }] },
      },
    ];
    const merged = mergePolicy(layers);
    expect(matchRule(merged.rules, { tool: "bash", command: "rm -rf /" })?.tier).toBe("block");
    expect(matchRule(merged.rules, { tool: "bash", command: "ls -la" })?.tier).not.toBe("block");
    expect(merged.warnings.join(" ")).toContain("project cannot lower block");
  });

  test("REGRESSION: a wildcard project rule cannot bypass a builtin block", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "project",
        config: { rules: [{ match: { tool: "bash", command: "*" }, tier: "allow" }] },
      },
    ];
    const merged = mergePolicy(layers);
    expect(matchRule(merged.rules, { tool: "bash", command: "mkfs.ext4 /dev/sda" })?.tier).toBe("block");
  });

  test("REGRESSION: a broad project ask rule stays ask, it is not inverted to block", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "project",
        config: { rules: [{ match: { tool: "bash" }, tier: "ask", reason: "review every bash" }] },
      },
    ];
    const merged = mergePolicy(layers);

    expect(matchRule(merged.rules, { tool: "bash", command: "ls -la" })?.tier).toBe("ask");
    expect(matchRule(merged.rules, { tool: "bash", command: "npm test" })?.tier).toBe("ask");
    expect(merged.warnings).toHaveLength(0);
  });

  test("REGRESSION: the documented `rm -rf *` -> ask example actually asks", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "project",
        config: {
          rules: [
            { match: { tool: "bash", command: "rm -rf *" }, tier: "ask", reason: "hapus rekursif" },
          ],
        },
      },
    ];
    const merged = mergePolicy(layers);

    expect(matchRule(merged.rules, { tool: "bash", command: "rm -rf ./build" })?.tier).toBe("ask");
    expect(matchRule(merged.rules, { tool: "bash", command: "rm -rf node_modules" })?.tier).toBe("ask");
    expect(merged.warnings).toHaveLength(0);
  });

  test("REGRESSION: a broad ask rule never outranks a builtin block", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      { source: "project", config: { rules: [{ match: { tool: "bash" }, tier: "ask" }] } },
    ];
    const merged = mergePolicy(layers);

    expect(matchRule(merged.rules, { tool: "bash", command: "rm -rf /" })?.tier).toBe("block");
    expect(matchRule(merged.rules, { tool: "bash", command: "mkfs.ext4 /dev/sda1" })?.tier).toBe("block");
  });

  test("REGRESSION: a broad project block rule still blocks", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      { source: "project", config: { rules: [{ match: { tool: "bash" }, tier: "block" }] } },
    ];
    const merged = mergePolicy(layers);

    expect(matchRule(merged.rules, { tool: "bash", command: "ls -la" })?.tier).toBe("block");
    expect(merged.warnings).toHaveLength(0);
  });

  test("a specific project rule may still allow a non-builtin command", () => {
    const layers: PolicyLayer[] = [
      { source: "builtin", config: { rules: BUILTIN_RULES } },
      {
        source: "project",
        config: { rules: [{ match: { tool: "bash", command: "my-tool *" }, tier: "ask" }] },
      },
    ];
    const merged = mergePolicy(layers);
    expect(matchRule(merged.rules, { tool: "bash", command: "my-tool x" })?.tier).toBe("ask");
  });
});

describe("loadPolicyFromFiles", () => {
  test("skips a missing config silently", () => {
    const workspace = makeWorkspace();
    const result = loadPolicyFromFiles({ workspace, env: {} });
    expect(result.warnings).toEqual([]);
    expect(result.rules.length).toBe(BUILTIN_RULES.length);
  });

  test("loads a project config and keeps block protected", () => {
    const workspace = makeWorkspace();
    writeProjectConfig(workspace, {
      rules: [{ match: { tool: "bash", command: "rm -rf /*" }, tier: "allow" }],
    });
    const result = loadPolicyFromFiles({ workspace, env: {} });
    expect(matchRule(result.rules, { tool: "bash", command: "rm -rf /" })?.tier).toBe("block");
    expect(result.warnings.join(" ")).toContain("project cannot lower block");
  });

  test("loads a global config from XDG_CONFIG_HOME", () => {
    const workspace = makeWorkspace();
    const home = makeWorkspace();
    const xdg = makeWorkspace();
    mkdirSync(join(xdg, "guardian-angel"), { recursive: true });
    writeFileSync(
      join(xdg, "guardian-angel", "config.json"),
      JSON.stringify({ rules: [{ match: { tool: "bash", command: "sudo *" }, tier: "allow" }] }),
      "utf8",
    );
    const result = loadPolicyFromFiles({ workspace, home, env: { XDG_CONFIG_HOME: xdg } });
    expect(matchRule(result.rules, { tool: "bash", command: "sudo ls" })?.tier).toBe("allow");
  });

  test("loads a global config from HOME fallback", () => {
    const workspace = makeWorkspace();
    const home = makeWorkspace();
    writeGlobalConfig(home, {
      rules: [{ match: { tool: "bash", command: "sudo *" }, tier: "allow" }],
    });
    const result = loadPolicyFromFiles({ workspace, home, env: {} });
    expect(matchRule(result.rules, { tool: "bash", command: "sudo ls" })?.tier).toBe("allow");
  });

  test("warns on an invalid JSON file instead of crashing", () => {
    const workspace = makeWorkspace();
    mkdirSync(join(workspace, ".guardian-angel"), { recursive: true });
    writeFileSync(join(workspace, ".guardian-angel", "config.json"), "{", "utf8");
    const result = loadPolicyFromFiles({ workspace, env: {} });
    expect(result.warnings.join(" ")).toContain("JSON parse");
  });

  test("warns on a schema-invalid config", () => {
    const workspace = makeWorkspace();
    writeProjectConfig(workspace, { rules: [{ tier: "nope" }] });
    const result = loadPolicyFromFiles({ workspace, env: {} });
    expect(result.warnings.join(" ")).toContain("invalid config");
  });
});

describe("BUILTIN_RULES", () => {
  test("is non-empty and covers the core block patterns", () => {
    expect(BUILTIN_RULES.length).toBeGreaterThanOrEqual(8);
    const commands = BUILTIN_RULES.map((r) => r.match.command);
    expect(commands).toContain("mkfs*");
    expect(commands).toContain("git push*");
  });
});
