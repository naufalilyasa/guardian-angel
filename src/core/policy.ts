import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyConfig, PolicyRule, Tier } from "./types.ts";

export type PolicyLayer = {
  source: "builtin" | "global" | "project";
  config: PolicyConfig;
};

export type LoadedPolicy = { rules: PolicyRule[]; warnings: string[] };

const TIERS: Tier[] = ["allow", "ask", "block"];
const TIER_RANK: Record<Tier, number> = { allow: 0, ask: 1, block: 2 };

export const BUILTIN_RULES: PolicyRule[] = [
  { match: { tool: "bash", command: "rm -rf /*" }, tier: "block", reason: "root filesystem" },
  { match: { tool: "bash", command: "mkfs*" }, tier: "block", reason: "format filesystem" },
  { match: { tool: "bash", command: "curl * | bash" }, tier: "block", reason: "remote script execution" },
  { match: { tool: "bash", command: "wget * | bash" }, tier: "block", reason: "remote script execution" },
  { match: { tool: "bash", command: "DROP *" }, tier: "block", reason: "destructive SQL" },
  { match: { tool: "bash", command: "TRUNCATE *" }, tier: "block", reason: "destructive SQL" },
  { match: { tool: "bash", command: "sudo *" }, tier: "ask", reason: "privilege escalation" },
  { match: { tool: "bash", command: "git push*" }, tier: "ask", reason: "remote write" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(raw: unknown): { rule: PolicyRule | null; error?: string } {
  if (!isRecord(raw)) return { rule: null, error: "rule must be an object" };
  if (!isRecord(raw.match)) return { rule: null, error: "rule.match must be an object" };
  if (typeof raw.tier !== "string" || !TIERS.includes(raw.tier as Tier)) {
    return { rule: null, error: `invalid tier: ${String(raw.tier)}` };
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    return { rule: null, error: "rule.reason must be a string" };
  }

  const match: PolicyRule["match"] = {};
  for (const field of ["tool", "command", "path"] as const) {
    const value = raw.match[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      return { rule: null, error: `rule.match.${field} must be a string` };
    }
    match[field] = value;
  }

  const rule: PolicyRule = { match, tier: raw.tier as Tier };
  if (typeof raw.reason === "string") rule.reason = raw.reason;
  return { rule };
}

export function parsePolicyConfig(raw: unknown): {
  config: PolicyConfig | null;
  error?: string;
} {
  if (!isRecord(raw)) return { config: null, error: "config must be an object" };
  if (!Array.isArray(raw.rules)) return { config: null, error: "config.rules must be an array" };

  const rules: PolicyRule[] = [];
  for (let i = 0; i < raw.rules.length; i += 1) {
    const parsed = parseRule(raw.rules[i]);
    if (parsed.rule === null) {
      return { config: null, error: `rules[${i}]: ${parsed.error}` };
    }
    rules.push(parsed.rule);
  }
  return { config: { rules } };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === "*" ? "\u0000" : `\\${ch}`,
  );
  return new RegExp(`^${escaped.replace(/\u0000/g, ".*")}$`);
}

function fieldMatches(pattern: string | undefined, value: string | undefined): boolean {
  if (pattern === undefined) return true;
  if (value === undefined) return false;
  return globToRegExp(pattern).test(value);
}

export function matchRule(
  rules: PolicyRule[],
  subject: { tool: string; command?: string; path?: string },
): PolicyRule | null {
  let found: PolicyRule | null = null;
  for (const rule of rules) {
    if (!fieldMatches(rule.match.tool, subject.tool)) continue;
    if (!fieldMatches(rule.match.command, subject.command)) continue;
    if (!fieldMatches(rule.match.path, subject.path)) continue;
    found = rule;
  }
  return found;
}

function builtinTierFor(rule: PolicyRule): Tier | null {
  const match = matchRule(BUILTIN_RULES, {
    tool: rule.match.tool ?? "",
    command: rule.match.command,
    path: rule.match.path,
  });
  return match ? match.tier : null;
}

function patternCovers(candidate: string | undefined, target: string | undefined): boolean {
  if (candidate === undefined) return true;
  if (target === undefined) return false;
  if (candidate === target) return true;
  return globToRegExp(candidate).test(target);
}

function couldWeakenBuiltinBlock(rule: PolicyRule): boolean {
  if (TIER_RANK[rule.tier] >= TIER_RANK.block) return false;
  for (const builtin of BUILTIN_RULES) {
    if (builtin.tier !== "block") continue;
    const coversTool = patternCovers(rule.match.tool, builtin.match.tool);
    const coversCommand = patternCovers(rule.match.command, builtin.match.command);
    const coversPath = patternCovers(rule.match.path, builtin.match.path);
    if (coversTool && coversCommand && coversPath) return true;
  }
  return false;
}

export function mergePolicy(layers: PolicyLayer[]): LoadedPolicy {
  const warnings: string[] = [];
  const rules: PolicyRule[] = [];

  for (const layer of layers) {
    if (layer.source === "builtin") continue;
    for (const rule of layer.config.rules) {
      if (layer.source === "project" && couldWeakenBuiltinBlock(rule)) {
        warnings.push(
          `project cannot lower block: ${rule.reason ?? rule.match.command ?? "rule"}`,
        );
        rules.push({ ...rule, tier: "block" });
        continue;
      }
      rules.push(rule);
    }
  }

  const globalRules = layers
    .filter((layer) => layer.source === "global")
    .flatMap((layer) => layer.config.rules);

  for (const builtin of BUILTIN_RULES) {
    if (builtin.tier !== "block") continue;
    const globalOverride = matchRule(globalRules, {
      tool: builtin.match.tool ?? "",
      command: builtin.match.command,
      path: builtin.match.path,
    });
    if (globalOverride && TIER_RANK[globalOverride.tier] < TIER_RANK.block) {
      continue;
    }
    rules.push(builtin);
  }

  for (const builtin of BUILTIN_RULES) {
    if (builtin.tier === "block") continue;
    rules.unshift(builtin);
  }

  return { rules, warnings };
}

function readLayer(
  path: string,
  source: "global" | "project",
  warnings: string[],
): PolicyLayer | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`invalid config (JSON parse): ${path}`);
    return null;
  }

  const result = parsePolicyConfig(parsed);
  if (result.config === null) {
    warnings.push(`invalid config (${result.error}): ${path}`);
    return null;
  }
  return { source, config: result.config };
}

export function loadPolicyFromFiles(opts: {
  workspace: string;
  home?: string;
  env?: Record<string, string | undefined>;
}): LoadedPolicy {
  const warnings: string[] = [];
  const env = opts.env ?? {};
  const home = opts.home ?? env.HOME;
  const xdg = env.XDG_CONFIG_HOME;

  const layers: PolicyLayer[] = [
    { source: "builtin", config: { rules: BUILTIN_RULES } },
  ];

  const globalPath = xdg
    ? join(xdg, "guardian-angel", "config.json")
    : home
      ? join(home, ".config", "guardian-angel", "config.json")
      : null;
  if (globalPath) {
    const globalLayer = readLayer(globalPath, "global", warnings);
    if (globalLayer) layers.push(globalLayer);
  }

  const projectLayer = readLayer(
    join(opts.workspace, ".guardian-angel", "config.json"),
    "project",
    warnings,
  );
  if (projectLayer) layers.push(projectLayer);

  const merged = mergePolicy(layers);
  return { rules: merged.rules, warnings: [...warnings, ...merged.warnings] };
}
