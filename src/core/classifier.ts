import type { GuardResult, PolicyConfig, ToolCall } from "./types.ts";
import { isInsideWorkspace, resolveLexical } from "./paths.ts";

export type ClassifierInput = {
  call: ToolCall;
  workspace: string;
  policy?: PolicyConfig;
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

const BLOCK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[\s;|&])rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*\s+\/(\s|$)/, reason: "rm -rf pada root filesystem diblokir" },
  { re: /(^|[\s;|&])rm\s+(-[a-zA-Z]+\s+)*~(\s|$)/, reason: "rm pada home directory diblokir" },
  { re: /(^|[\s;|&])rm\s+(-[a-zA-Z]+\s+)*\$HOME(\s|$)/, reason: "rm pada $HOME diblokir" },
  { re: /(^|[\s;|&])mkfs(\.[a-z0-9]+)?(\s|$)/, reason: "mkfs memformat filesystem dan diblokir" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, reason: "dd menulis langsung ke block device dan diblokir" },
  { re: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, reason: "fork bomb diblokir" },
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/, reason: "pipe dari network ke shell diblokir" },
  { re: /\bfind\b[^\n]*\s-delete\b/, reason: "find -delete menghapus banyak target tanpa bisa di-undo" },
  { re: /(^|[\s;|&])shred(\s|$)/, reason: "shred menghapus data secara permanen dan diblokir" },
];

const ASK_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[\s;|&])sudo(\s|$)/, reason: "sudo memerlukan persetujuan" },
  { re: /(^|[\s;|&])git\s+push\b/, reason: "git push memerlukan persetujuan" },
  { re: /(^|[\s;|&])ch(mod|own)\s+-R\b/, reason: "perubahan permission rekursif memerlukan persetujuan" },
  { re: /(^|[\s;|&])kill\s+-9\s+-1(\s|$)/, reason: "membunuh semua proses memerlukan persetujuan" },
  { re: /(^|[\s;|&])docker\s+system\s+prune\b/, reason: "docker system prune memerlukan persetujuan" },
];

const RM_ALLOWED_FLAGS = new Set([
  "-f", "-r", "-rf", "-fr", "-R", "--force", "--recursive",
]);

const RM_UNSAFE_CHARS = /[*?[\]$`(){}~]/;

/** Split a shell command into segments on unquoted separators. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function classifyRm(segment: string, workspace: string): GuardResult | null {
  let tokens = tokenize(segment);

  while (tokens.length > 0 && (tokens[0] === "sudo" || tokens[0] === "command" || tokens[0] === "env" || tokens[0] === "nohup" || tokens[0] === "time")) {
    tokens = tokens.slice(1);
    while (tokens.length > 0 && (tokens[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))) {
      tokens = tokens.slice(1);
    }
  }

  if (tokens[0] !== "rm") return null;

  const operands: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith("-")) {
      if (!RM_ALLOWED_FLAGS.has(token)) {
        return {
          verdict: "block",
          reason: `rm dengan flag tidak dikenal (${token}); gunakan ga trash <path> per target`,
        };
      }
      continue;
    }
    operands.push(token);
  }

  if (operands.length === 0) {
    return { verdict: "ask", reason: "rm tanpa operand memerlukan persetujuan" };
  }
  if (operands.length > 1) {
    return {
      verdict: "block",
      reason: "rm dengan banyak target tidak dapat di-undo otomatis; jalankan ga trash <path> per target",
    };
  }

  const raw = operands[0];
  const stripped = unquote(raw);
  if (RM_UNSAFE_CHARS.test(stripped)) {
    return {
      verdict: "block",
      reason: `rm target kompleks (${raw}) tidak dapat di-parse dengan aman; jalankan ga trash <path> per target`,
    };
  }

  const target = resolveLexical(workspace, stripped);

  if (!isInsideWorkspace(workspace, target)) {
    return {
      verdict: "block",
      reason: `trash hanya mencakup workspace; ${target} berada di luar workspace`,
    };
  }

  return {
    verdict: "allow",
    reason: "rewritten to trash",
    replacement: { kind: "trash", path: target },
  };
}

const SEVERITY: Record<"allow" | "ask" | "block", number> = { allow: 0, ask: 1, block: 2 };

function stricter(
  a: { verdict: "allow" | "ask" | "block"; reason?: string; replacement?: { kind: "trash"; path: string } },
  b: { verdict: "allow" | "ask" | "block"; reason?: string; replacement?: { kind: "trash"; path: string } },
) {
  return SEVERITY[b.verdict] > SEVERITY[a.verdict] ? b : a;
}

export function classify(input: ClassifierInput): GuardResult {
  const { call, workspace } = input;

  if (READ_ONLY_TOOLS.has(call.toolName)) {
    return { verdict: "allow", reason: "read-only tool" };
  }

  if (call.toolName === "write" || call.toolName === "edit") {
    const rawPath = call.input.path;
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return { verdict: "ask", reason: "path tidak diketahui; persetujuan diperlukan" };
    }
    const resolved = resolveLexical(workspace, rawPath);
    if (isInsideWorkspace(workspace, resolved)) {
      return { verdict: "allow", reason: "menulis di dalam workspace" };
    }
    return {
      verdict: "ask",
      reason: `menulis di luar workspace: ${resolved}`,
    };
  }

  const command = call.input.command;
  if (typeof command !== "string") {
    return { verdict: "allow", reason: "default allow" };
  }
  if (command.trim().length === 0) {
    return { verdict: "allow", reason: "default allow" };
  }

  for (const { re, reason } of BLOCK_PATTERNS) {
    if (re.test(command)) return { verdict: "block", reason };
  }

  const rmResult = (() => {
    for (const segment of splitSegments(command)) {
      const result = classifyRm(segment, workspace);
      if (result) return result;
    }
    return null;
  })();

  for (const { re, reason } of ASK_PATTERNS) {
    if (re.test(command)) {
      return rmResult ? stricter(rmResult, { verdict: "ask", reason }) : { verdict: "ask", reason };
    }
  }

  if (rmResult) return rmResult;

  return { verdict: "allow", reason: "default allow" };
}
