import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import {
  expandHome,
  isInsideWorkspace,
  isInsideWorkspacePhysical,
  resolvePhysical,
} from "./paths.ts";
import type { GuardResult } from "./types.ts";

const MAX_INSPECTABLE_BYTES = 512 * 1024;

const SCRIPT_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".sh",
  ".bash",
  ".zsh",
  ".pl",
  ".pm",
  ".rb",
  ".php",
  ".lua",
]);

const PYTHON_PROGRAM = /^python\d*(\.\d+)?$/i;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const OTHER_INTERPRETERS = new Set(["perl", "ruby", "php", "lua", "luajit"]);

const PROTECTED_ENTRY_RE = /\.(?:guardian-angel|git)\b/;

const DESTRUCTIVE_SCRIPT_RE =
  /\b(?:rm\s+(?:-[a-zA-Z-]+\s+)*-[a-zA-Z]*f[a-zA-Z]*\s+(?:\/|~|\$HOME)(?:[\s;)|'"&]|$)|shutil\.rmtree\s*\(\s*['"](?:\/|~|\$HOME)|mkfs(\.[a-z0-9]+)?\b|dd\b[^\n]*\bof=\/dev\/|DROP\s+(DATABASE|TABLE)|TRUNCATE\s+TABLE\b)/i;

function cleanToken(token: string): string {
  let cleaned = token;
  if (cleaned.startsWith("$'") || cleaned.startsWith('$"')) {
    cleaned = cleaned.replace(
      /\\x([0-9a-fA-F]{1,2})|\\([0-7]{1,3})|\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g,
      (_, hex?: string, oct?: string, u4?: string, u8?: string) => {
        if (hex) return String.fromCharCode(parseInt(hex, 16));
        if (oct) return String.fromCharCode(parseInt(oct, 8));
        if (u4) return String.fromCharCode(parseInt(u4, 16));
        if (u8) return String.fromCodePoint(parseInt(u8, 16));
        return _;
      },
    );
  }
  return cleaned.replace(/^\$['"]/, "").replace(/['"\\]/g, "");
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith("$'") || t.startsWith('$"')) {
    return cleanToken(t);
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function extractPythonScript(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const tok = cleanToken(tokens[i]);
    if (tok === "-m" || tok === "-c" || tok === "-V" || tok === "--version" || tok === "-h" || tok === "--help") {
      return null;
    }
    if (tok.startsWith("-")) {
      if (tok === "-W" || tok === "-X") i++;
      continue;
    }
    return tokens[i];
  }
  return null;
}

function extractNodeScript(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const tok = cleanToken(tokens[i]);
    if (["-e", "--eval", "-p", "--print", "-pe", "-v", "--version", "-h", "--help"].includes(tok)) {
      return null;
    }
    if (["-r", "--require", "--loader", "--import"].includes(tok)) {
      i++;
      continue;
    }
    if (tok.startsWith("-")) continue;
    return tokens[i];
  }
  return null;
}

function extractBunScript(tokens: string[]): string | null {
  if (tokens.length < 2) return null;
  const t1 = cleanToken(tokens[1]).toLowerCase();
  if (["test", "install", "add", "remove", "pm", "create", "init", "x"].includes(t1)) return null;
  if (t1 === "run") {
    for (let i = 2; i < tokens.length; i++) {
      const tok = cleanToken(tokens[i]);
      if (tok.startsWith("-")) continue;
      return tokens[i];
    }
    return null;
  }
  return !t1.startsWith("-") ? tokens[1] : null;
}

function extractDenoScript(tokens: string[]): string | null {
  if (tokens.length < 2) return null;
  if (cleanToken(tokens[1]).toLowerCase() !== "run") return null;
  for (let i = 2; i < tokens.length; i++) {
    const tok = cleanToken(tokens[i]);
    if (tok.startsWith("-")) {
      if (tok === "--import-map" || tok === "-c" || tok === "--config") i++;
      continue;
    }
    return tokens[i];
  }
  return null;
}

function extractShellScript(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const tok = cleanToken(tokens[i]);
    if (tok === "-c" || tok === "--command") return null;
    if (tok.startsWith("-")) {
      if (tok === "-o" && tokens[i + 1]) i++;
      continue;
    }
    return tokens[i];
  }
  return null;
}

function extractScriptCandidate(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const prog = cleanToken(tokens[0].split("/").pop() ?? "").toLowerCase();

  if (PYTHON_PROGRAM.test(prog)) return extractPythonScript(tokens);
  if (prog === "node" || prog === "nodejs") return extractNodeScript(tokens);
  if (prog === "bun") return extractBunScript(tokens);
  if (prog === "deno") return extractDenoScript(tokens);
  if (SHELLS.has(prog)) return extractShellScript(tokens);

  if (OTHER_INTERPRETERS.has(prog)) {
    for (let i = 1; i < tokens.length; i++) {
      const tok = cleanToken(tokens[i]);
      if (["-e", "-E", "-r", "-R", "-v", "--version", "-h", "--help"].includes(tok)) return null;
      if (tok.startsWith("-")) continue;
      return tokens[i];
    }
    return null;
  }

  const first = cleanToken(tokens[0]);
  const ext = extname(first);
  if (SCRIPT_EXTENSIONS.has(ext) || first.startsWith("./")) return tokens[0];
  return null;
}

function inspectScriptContent(
  target: string,
  resolved: string,
  content: string,
  workspace: string,
): GuardResult | null {
  const lines = content.split("\n");
  let hasProtectedRef = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#") || line.startsWith("//") || line.startsWith("*")) continue;

    const withoutExcludes = line.replace(
      /--(?:exclude|ignore)[=\s]+['"]?\.(?:guardian-angel|git)\b/gi,
      "",
    );

    if (PROTECTED_ENTRY_RE.test(withoutExcludes)) {
      const hasTamperVerb =
        /\b(?:open\s*\([^)]*['"][wa+]|write\w*|append\w*|unlink\w*|rm\w*|remove\w*|rmtree|copy\w*|cp\w*|truncate\w*|chmod\w*|chown\w*|system|popen|subprocess|exec\w*|spawn\w*)\b/i.test(
          withoutExcludes,
        ) || />>?\s*['"]?[^\s'"]*\.(?:guardian-angel|git)\b/.test(withoutExcludes);
      if (hasTamperVerb) {
        return {
          verdict: "block",
          reason: `script file '${target}' attempts to modify protected area (.guardian-angel/.git) and is blocked`,
          ruleId: "block:protected-script",
        };
      }
      hasProtectedRef = true;
    }

    if (DESTRUCTIVE_SCRIPT_RE.test(line)) {
      return {
        verdict: "block",
        reason: `script file '${target}' contains destructive command and is blocked`,
        ruleId: "block:script-destructive",
      };
    }
  }

  if (hasProtectedRef) {
    return {
      verdict: "ask",
      reason: `script file '${target}' references protected area (.guardian-angel/.git); approval required`,
      ruleId: "ask:script-protected",
      scopePath: resolved,
    };
  }

  const rel = relative(workspace, resolved);
  const isVendorOrBuild = /(?:^|\/)(?:node_modules|\.venv|venv|dist|build|\.next|vendor)\//.test(rel);
  if (!isVendorOrBuild) {
    const hasObfuscation =
      /\b(eval\s*\(|exec\s*\(|__import__\s*\(|Function\s*\(|base64\.(?:b64decode|decode)\s*\(|Buffer\.from\([^)]*['"]base64['"]|atob\s*\()/i.test(
        content,
      );
    if (hasObfuscation) {
      return {
        verdict: "ask",
        reason: `script file '${target}' contains dynamic or obfuscated code execution; approval required`,
        ruleId: "ask:script-obfuscated",
        scopePath: resolved,
      };
    }
  }

  return null;
}

function readAndInspectScript(
  target: string,
  resolved: string,
  workspace: string,
): GuardResult | null {
  try {
    const lstat = lstatSync(resolved);
    if (lstat.isSymbolicLink()) {
      const physical = resolvePhysical(workspace, resolved);
      if (!isInsideWorkspacePhysical(workspace, physical) && !isInsideWorkspace(workspace, physical)) {
        return {
          verdict: "ask",
          reason: `script file '${target}' points outside the workspace; approval required`,
          ruleId: "ask:script-outside",
          scopePath: physical,
        };
      }
    }
    const stat = statSync(resolved);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_INSPECTABLE_BYTES) {
      return {
        verdict: "ask",
        reason: `script file '${target}' exceeds 512KB and cannot be inspected; approval required`,
        ruleId: "ask:script-uninspectable",
        scopePath: resolved,
      };
    }
    let buf: Buffer;
    try {
      buf = readFileSync(resolved);
    } catch {
      return {
        verdict: "ask",
        reason: `script file '${target}' cannot be read; approval required`,
        ruleId: "ask:script-uninspectable",
        scopePath: resolved,
      };
    }
    const hasScriptExt = SCRIPT_EXTENSIONS.has(extname(resolved));
    const isShebang = buf.length >= 2 && buf[0] === 0x23 && buf[1] === 0x21; // #!
    if (!hasScriptExt && !isShebang) return null;

    const probeLen = Math.min(buf.length, 8192);
    for (let j = 0; j < probeLen; j++) {
      if (buf[j] === 0) {
        return {
          verdict: "ask",
          reason: `script file '${target}' appears to be binary and cannot be inspected; approval required`,
          ruleId: "ask:script-uninspectable",
          scopePath: resolved,
        };
      }
    }
    return inspectScriptContent(target, resolved, buf.toString("utf8"), workspace);
  } catch {
    return null;
  }
}

/**
 * Inspect interpreter script execution (`python3 script.py`, `node server.js`, `bash build.sh`).
 * Checks whether the script touches protected areas, executes destructive actions, or uses
 * obfuscated execution.
 */
export function classifyScriptFile(
  tokens: string[],
  workspace: string,
  effectiveCwd: string = workspace,
): GuardResult | null {
  const candidate = extractScriptCandidate(tokens);
  if (!candidate) return null;

  const target = unquote(candidate);
  if (!target || target.startsWith("-") || /^(&|&&|\||\|\||;|>|>>|<)$/.test(target)) return null;

  if (target.includes("$")) {
    return {
      verdict: "ask",
      reason: `script path '${target}' uses shell expansion that cannot be resolved statically; approval required`,
      ruleId: "ask:script-unresolvable",
      scopePath: resolve(effectiveCwd, target),
    };
  }

  const expanded = expandHome(target);
  const resolved = isAbsolute(expanded) ? expanded : resolve(effectiveCwd, expanded);
  if (!isInsideWorkspacePhysical(workspace, resolved) && !isInsideWorkspace(workspace, resolved)) {
    return {
      verdict: "ask",
      reason: `executing a script located outside the workspace (${target}) requires approval`,
      ruleId: "ask:script-outside",
      scopePath: resolved,
    };
  }

  if (!existsSync(resolved)) return null;
  return readAndInspectScript(target, resolved, workspace);
}
