import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { GuardResult, ToolCall } from "./types.ts";
import {
  extractPath,
  isInsideWorkspace,
  isInsideWorkspacePhysical,
  resolveLexical,
  resolvePhysical,
} from "./paths.ts";
import { isProtectedPath, protectedReason } from "./protected.ts";
import { classifySql } from "./sql.ts";

export type ClassifierInput = {
  call: ToolCall;
  workspace: string;
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

const BLOCK_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: "block:rm-root", re: /(^|[\s;|&(])(?:[^\s;|&(]*\/)?rm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*\s+\/([\s;)|]|$)/, reason: "rm -rf pada root filesystem diblokir" },
  { id: "block:rm-home", re: /(^|[\s;|&(])(?:[^\s;|&(]*\/)?rm\s+(-[a-zA-Z]+\s+)*~([\s;)|]|$)/, reason: "rm pada home directory diblokir" },
  { id: "block:rm-home-env", re: /(^|[\s;|&(])(?:[^\s;|&(]*\/)?rm\s+(-[a-zA-Z]+\s+)*\$HOME([\s;)|]|$)/, reason: "rm pada $HOME diblokir" },
    {
    id: "block:protected-bash-write",
    re: /(^|[\s;&|('"`])env\s+[^\n]*?(-C|--chdir[=\s])\s*['"]?\.?(guardian-angel|git)\b/,
    reason: "eksekusi perintah di dalam direktori proteksi (.guardian-angel atau .git) diblokir",
  },
  {
    id: "block:protected-rm", re: /(^|[\s;|&(])(?:[^\s;|&(]*\/)?(rm|unlink|shred)\b[^\n]*\.(guardian-angel|git)\b/, reason: "penghapusan direktori proteksi (.guardian-angel atau .git) diblokir" },
  { id: "block:git-clean-ignored", re: /(^|[\s;|&(])git\s+clean\b[^\n]*\s-[^\n]*[xX]/, reason: "git clean dengan flag -x/-X menghapus ignored files termasuk store dan diblokir" },
  { id: "block:mkfs", re: /(^|[\s;|&(])mkfs(\.[a-z0-9]+)?([\s;)|]|$)/, reason: "mkfs memformat filesystem dan diblokir" },
  { id: "block:dd-device", re: /\bdd\b[^\n]*\bof=\/dev\//, reason: "dd menulis langsung ke block device dan diblokir" },
  { id: "block:fork-bomb", re: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:/, reason: "fork bomb diblokir" },
  { id: "block:network-pipe", re: /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh|dash|ksh)\b/, reason: "pipe dari network ke shell diblokir" },
  { id: "block:find-delete", re: /\bfind\b[^\n]*\s-delete\b/, reason: "find -delete menghapus banyak target tanpa bisa di-undo" },
  { id: "block:shred", re: /(^|[\s;|&(])shred([\s;)|]|$)/, reason: "shred menghapus data secara permanen dan diblokir" },
];

const ASK_PATTERNS: Array<{ id: string; re: RegExp; reason: string }> = [
  { id: "ask:sudo", re: /(^|[\s;|&(])sudo([\s;)|]|$)/, reason: "sudo memerlukan persetujuan" },
  { id: "ask:git-push", re: /(^|[\s;|&(])git\s+push\b/, reason: "git push memerlukan persetujuan" },
  { id: "ask:git-clean", re: /(^|[\s;|&(])git\s+clean\b/, reason: "git clean menghapus file yang tidak terlacak dan memerlukan persetujuan" },
  { id: "ask:chmod-recursive", re: /(^|[\s;|&(])ch(mod|own)\s+-R\b/, reason: "perubahan permission rekursif memerlukan persetujuan" },
  { id: "ask:kill-all", re: /(^|[\s;|&(])kill\s+-9\s+-1([\s;)|]|$)/, reason: "membunuh semua proses memerlukan persetujuan" },
  { id: "ask:docker-prune", re: /(^|[\s;|&(])docker\s+system\s+prune\b/, reason: "docker system prune memerlukan persetujuan" },
];

const RM_ALLOWED_FLAGS = new Set([
  "-f", "-r", "-rf", "-fr", "-R", "--force", "--recursive", "--",
]);

/**
 * Interpreters that execute a code payload passed inline on the command line.
 * The guard cannot inspect such payload deterministically, so it must never
 * allow it silently — the Atria-Dawn pentest wiped a database through a
 * base64 `executescript` payload with verdict `allow` and zero confirmation.
 * Flags are lowercase; program names are matched case-insensitively.
 */
const INTERPRETER_EVAL_FLAGS: Record<string, Set<string>> = {
  node: new Set(["-e", "--eval", "-p", "--print", "-pe"]),
  bun: new Set(["-e", "--eval", "-p", "--print"]),
  perl: new Set(["-e", "-E"]),
  ruby: new Set(["-e"]),
  php: new Set(["-r", "-R"]),
  lua: new Set(["-e"]),
  rscript: new Set(["-e"]),
  osascript: new Set(["-e"]),
};

const PYTHON_PROGRAM = /^python\d*(\.\d+)?$/;

/** Mentions of the protected store inside inline interpreter code. */
const PROTECTED_ENTRY_RE = /\.(?:guardian-angel|git)\b/;

/** Catastrophic shell escape inside inline interpreter code (quote-tolerant). */
const INTERPRETER_DESTRUCTIVE_RE =
  /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*\s+\/(?:[\s;)|'"&]|$)/;

/**
 * Return the inline code payload when a segment invokes an interpreter with
 * one (`python3 -c "..."`, `node -e '...'`, `deno eval '...'`), else null.
 * Launchers are stripped first so `env python3 -c ...` is still detected.
 */
function inlineCodePayload(rawTokens: string[]): string | null {
  const { tokens } = stripLaunchers(rawTokens);
  if (tokens.length === 0) return null;

  const program = stripQuotes(tokens[0].split("/").pop() ?? tokens[0])
    .replace(/^[()]+|[()]+$/g, "")
    .toLowerCase();
  if (program === "deno") {
    if (stripQuotes(tokens[1] ?? "") !== "eval") return null;
    let i = 2;
    while (i < tokens.length && stripQuotes(tokens[i]).startsWith("-")) i += 1;
    const payload = tokens[i] !== undefined ? unquote(tokens[i]) : "";
    return payload.length > 0 ? payload : null;
  }

  const isPython = PYTHON_PROGRAM.test(program);
  const evalFlags = INTERPRETER_EVAL_FLAGS[program];
  if (!isPython && !evalFlags) return null;

  for (let i = 1; i < tokens.length; i += 1) {
    const rawFlag = stripQuotes(tokens[i]).toLowerCase();
    const eqIndex = rawFlag.indexOf("=");
    const flagName = eqIndex > 0 ? rawFlag.slice(0, eqIndex) : rawFlag;
    const isEvalFlag = isPython ? flagName === "-c" : evalFlags.has(flagName);
    if (!isEvalFlag) continue;
    if (eqIndex > 0) {
      const payload = rawFlag.slice(eqIndex + 1);
      return payload.length > 0 ? payload : null;
    }
    if (tokens[i + 1] === undefined) return null;
    const payload = unquote(tokens[i + 1]);
    return payload.length > 0 ? payload : null;
  }
  return null;
}

/**
 * Inline interpreter code cannot be inspected: ask by default, and block when
 * the payload names a protected entry — same tier as every other store-write
 * rule (echo redirection, cp, sed -i, ...). Rule id keeps the `block:protected`
 * prefix so global policy cannot downgrade it (see guard.ts).
 */
function classifyInterpreterCode(segments: string[]): GuardResult | null {
  for (const segment of segments) {
    const payload = inlineCodePayload(tokenize(segment));
    if (payload === null) continue;
    if (PROTECTED_ENTRY_RE.test(payload)) {
      return {
        verdict: "block",
        reason: `kode interpreter menyentuh area yang dilindungi (${payload.slice(0, 60)})`,
        ruleId: "block:protected-interpreter",
      };
    }
    if (INTERPRETER_DESTRUCTIVE_RE.test(payload)) {
      return {
        verdict: "block",
        reason: "kode interpreter menjalankan penghapusan root filesystem dan diblokir",
        ruleId: "block:interpreter-destructive",
      };
    }
    return {
      verdict: "ask",
      reason: "kode interpreter inline tidak dapat diperiksa; persetujuan diperlukan",
      ruleId: "ask:interpreter-inline",
    };
  }
  return null;
}


const RM_UNSAFE_CHARS = /[*?[\]$`(){}~]/;

/** Shells that can carry a payload in `-c`. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * Launchers that run another command. `nice`, `timeout`, `env` and friends
 * take their own flags before the real command starts.
 */
const LAUNCHERS = new Set([
  "nice", "nohup", "timeout", "env", "stdbuf", "ionice", "setsid",
  "command", "builtin", "exec", "time", "xargs",
]);

/** Command substitution: `$(...)` and backticks (global match). */
const SUBSTITUTION = /(?:[\$<>]\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`)/g;

/** Strip quotes and backslashes from command words and tokens. */
export function stripQuotes(token: string): string {
  return token.replace(/^\$['"]/, "").replace(/['"\\]/g, "");
}

const LAUNCHER_VAL_FLAGS = new Set([
  "-n", "-c", "-u", "-C", "--chdir", "-I", "-d", "-i", "-o", "-e", "-s",
]);

/**
 * Strip a leading launcher and its flags so the real command becomes visible.
 * Returns the remaining tokens and a flag indicating whether launcher depth was exceeded.
 */
function stripLaunchers(tokens: string[]): { tokens: string[]; hitLimit: boolean } {
  let rest = tokens;
  let guard = 0;

  while (rest.length > 0 && guard < 10) {
    guard += 1;
    const rawHead = rest[0];
    const head = stripQuotes(rawHead);

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      rest = rest.slice(1);
      continue;
    }

    if (LAUNCHERS.has(head)) {
      rest = rest.slice(1);
      while (rest.length > 0) {
        const flagToken = stripQuotes(rest[0]);
        if (flagToken.startsWith("--chdir=")) {
          rest = rest.slice(1);
          continue;
        }
        if (LAUNCHER_VAL_FLAGS.has(flagToken) && rest.length > 1 && !rest[1].startsWith("-")) {
          rest = rest.slice(2);
          continue;
        }
        if (flagToken.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(flagToken)) {
          rest = rest.slice(1);
          continue;
        }
        break;
      }
      if (head === "timeout" && rest.length > 0 && /^[0-9]/.test(stripQuotes(rest[0]))) {
        rest = rest.slice(1);
      }
      continue;
    }

    if (head === "sudo") {
      rest = rest.slice(1);
      while (rest.length > 0 && rest[0].startsWith("-")) rest = rest.slice(1);
      continue;
    }

    break;
  }

  const remainingHead = rest.length > 0 ? stripQuotes(rest[0]) : "";
  const hitLimit =
    guard >= 10 &&
    (LAUNCHERS.has(remainingHead) ||
      remainingHead === "sudo" ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(remainingHead));

  return { tokens: rest, hitLimit };
}

/**
 * Extract bare subshell groups `( ... )` from a segment.
 *
 * Quote-aware on purpose: in `echo "at ($(date)) done"` the outer parentheses
 * are literal characters being echoed, while `$(date)` is the only live
 * substitution — and that one is handled by the SUBSTITUTION pass. Treating the
 * literal pair as a subshell would push `$(date)` into command position and
 * produce a spurious `ask:variable-command`.
 *
 * Arithmetic expansion `$(( ... ))` is skipped for the same reason: it evaluates
 * numbers, never a command word.
 */
function extractParenGroups(str: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    // `$((` opens arithmetic expansion, not a subshell.
    if (ch === "(" && str[i - 1] === "(" && str[i - 2] === "$") {
      // Skip to the matching `))`.
      let d = 2;
      let j = i + 1;
      while (j < str.length && d > 0) {
        if (str[j] === "(") d++;
        else if (str[j] === ")") d--;
        j++;
      }
      i = j - 1;
      continue;
    }

    if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ")" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        const inner = str.slice(start, i).trim();
        if (inner) {
          groups.push(inner);
          if (inner.includes("(")) {
            groups.push(...extractParenGroups(inner));
          }
        }
        start = -1;
      }
    }
  }
  return groups;
}

/**
 * Unwrap all levels of indirection in a segment: `bash -c "..."`, `eval "..."`,
 * `sh -c '...'`, parenthesized subshell commands `(...)`, and all `$(...)`/backtick payloads.
 * Returns all inner commands found.
 */
function unwrapAll(segment: string): string[] {
  const inners: string[] = [];
  const trimmed = segment.trim();

  for (const group of extractParenGroups(trimmed)) {
    inners.push(group);
  }

  const tokens = tokenize(segment);

  if (tokens.length > 0) {
    const { tokens: head } = stripLaunchers(tokens);
    if (head.length > 0) {
      const rawProg = head[0].split("/").pop() ?? head[0];
      const program = stripQuotes(rawProg).replace(/^[()]+|[()]+$/g, "");
      if (SHELLS.has(program)) {
        const flagIndex = head.findIndex((token) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(stripQuotes(token)));
        if (flagIndex !== -1 && head.length > flagIndex + 1) {
          const payload = unquote(head[flagIndex + 1]);
          if (payload.trim()) inners.push(payload.trim());
          const rest = unquote(head.slice(flagIndex + 1).join(" "));
          if (rest.trim() && rest.trim() !== payload.trim()) inners.push(rest.trim());
        }
        const hereIndex = head.findIndex((token) => token.startsWith("<<<"));
        if (hereIndex !== -1) {
          const raw = head[hereIndex] === "<<<" ? head.slice(hereIndex + 1).join(" ") : head[hereIndex].slice(3);
          if (raw.trim()) inners.push(unquote(raw.trim()));
        }
      } else if (program === "eval" && head.length > 1) {
        const first = unquote(head[1]).trim();
        if (first && !/^\$\(|^`/.test(first)) inners.push(first);
        const full = head.slice(1).map(unquote).join(" ").trim();
        if (full && full !== first && !/^\$\(|^`/.test(full)) inners.push(full);
      }
    }
  }

  for (const m of segment.matchAll(SUBSTITUTION)) {
    const payload = m[1] ?? m[2];
    if (payload && payload.trim()) {
      inners.push(payload.trim());
    }
  }

  return inners;
}

/** Split a shell command into segments on unquoted separators. */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\" && quote !== "'") { current += ch; escaped = true; continue; }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { current += ch; quote = ch; continue; }
    if (ch === "|" || ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&") {
      if (command[i + 1] === "&") {
        segments.push(current);
        current = "";
        i += 1;
        continue;
      }
      if (command[i + 1] === ">" || (i > 0 && command[i - 1] === ">")) {
        current += ch;
        continue;
      }
      segments.push(current);
      current = "";
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

/**
 * Replace a quoted heredoc body with a placeholder.
 *
 * `<< 'EOF'` and `<< "EOF"` disable expansion: bash copies the body verbatim
 * and never parses it as shell. Scanning that text as live commands produced
 * false positives for ordinary "write a test file that mentions `>`" work.
 * The delimiter line itself is kept so the redirect target still classifies.
 *
 * Unquoted delimiters (`<< EOF`) DO expand, so those bodies are left intact
 * and stay subject to every rule.
 */
function neutralizeQuotedHeredoc(command: string): string {
  const HEREDOC = /(<<-?\s*)(['"])([A-Za-z_][A-Za-z0-9_]*)\2[^\n]*\n([\s\S]*?)\n\3(?=\s|$)/g;
  return command.replace(HEREDOC, (_match, intro: string, quote: string, name: string) => {
    return `${intro}${quote}${name}${quote} __heredoc_body__\n${name}`;
  });
}

/**
 * Neutralise backticks that bash treats as literal because a backslash
 * escapes them.
 *
 * `` \` `` is a literal backtick in every quoting context, so
 * `git commit -m "explain \`rm -rf\`"` never runs a command substitution and
 * must not be scanned for one. Only an ODD number of preceding backslashes
 * escapes the backtick: `"\\`id`"` (two backslashes) yields a literal
 * backslash followed by a LIVE substitution, so even runs stay untouched.
 *
 * Replacing the backtick with `_` keeps the surrounding text intact, so
 * ordinary command words, quoting and protected-path scanning are unaffected.
 */
function maskEscapedBackticks(command: string): string {
  let out = "";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch !== "`") {
      out += ch;
      continue;
    }
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && command[j] === "\\"; j -= 1) backslashes += 1;
    out += backslashes % 2 === 1 ? "_" : ch;
  }
  return out;
}

/**
 * Mask expansion characters that bash treats as literal inside `'...'`.
 *
 * Only `$` and `` ` `` are neutralised — quote characters and backslashes stay
 * intact so quote-split command words (`r'm'`, `d'd'd`) still normalise
 * correctly. Bash performs no expansion inside single quotes, so
 * `sed -n '/start/,$p'` (where `$` means "last line") and `awk '{print $1}'`
 * were being read as dynamic targets and blocked. Double quotes still expand
 * and are deliberately left untouched.
 */
/**
 * Replace the *contents* of every quoted span with an inert placeholder.
 *
 * `BLOCK_PATTERNS` and `ASK_PATTERNS` are text regexes. Running them on a
 * command that still contains quoted text made ordinary work fail: a commit
 * message describing `rm -rf /`, a `grep -rn "use shred"`, or an
 * `echo "never run mkfs"` all matched the destructive pattern even though the
 * quoted text is data that never executes. Masking the payload keeps the
 * surrounding shell syntax (so `git push`, real redirects, and real `rm` still
 * match) while removing the false positives.
 *
 * Delimiters are preserved so offsets and quote-split words (`r'm'`) survive.
 */
function maskQuotedPayloads(command: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      out += quote === null ? ch : "_";
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      out += ch;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        out += ch;
      } else {
        out += "_";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }

  return out;
}

function maskSingleQuoted(command: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      out += ch;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
        out += ch;
      } else if (ch === "$" || ch === "`") {
        out += "_";
      } else {
        out += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }

  return out;
}

/** True when a `sed` invocation actually writes (`-i` / `--in-place`). */
function sedWritesInPlace(args: string[]): boolean {
  return args.some(
    (t) =>
      t === "-i" ||
      t.startsWith("-i") ||
      t === "--in-place" ||
      t.startsWith("--in-place="),
  );
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

function checkDelegatedRm(rawTokens: string[], program: string): GuardResult | null {
  const execIndex = rawTokens.findIndex((t) => t === "-exec" || t === "-execdir");
  if (execIndex !== -1) {
    const executed = rawTokens.slice(execIndex + 1).map(unquote);
    const verb = executed[0]?.split("/").pop() ?? executed[0];
    if (verb === "rm" || verb === "unlink" || verb === "shred") {
      return {
        verdict: "block",
        reason: "find -exec rm tidak dapat di-undo otomatis; jalankan ga trash <path> per target",
        ruleId: "block:rm-find-exec",
      };
    }
    if (SHELLS.has(verb)) {
      return {
        verdict: "ask",
        reason: "find -exec menjalankan shell memerlukan persetujuan",
        ruleId: "ask:find-exec-shell",
      };
    }
  }

  const isXargs = program === "xargs" || rawTokens.some((t) => basenameOf(stripQuotes(t)) === "xargs");
  if (isXargs) {
    const hasRm = rawTokens.some((t) => {
      const b = basenameOf(stripQuotes(t));
      return b === "rm" || b === "unlink" || b === "shred";
    });
    if (hasRm) {
      return {
        verdict: "block",
        reason: "xargs rm mengambil target dari stdin dan tidak dapat diverifikasi; jalankan ga trash <path> per target",
        ruleId: "block:rm-xargs",
      };
    }
  }

  return null;
}

function parseRmOperands(tokens: string[]): { operands: string[]; error?: GuardResult } {
  const operands: string[] = [];
  let endOfOptions = false;
  for (const rawToken of tokens.slice(1)) {
    const token = stripQuotes(rawToken);
    if (!endOfOptions && token === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && token.startsWith("-")) {
      if (!RM_ALLOWED_FLAGS.has(token)) {
        return {
          operands: [],
          error: {
            verdict: "block",
            reason: `rm dengan flag tidak dikenal (${rawToken}); gunakan ga trash <path> per target`,
            ruleId: "block:rm-unknown-flag",
          },
        };
      }
      continue;
    }
    operands.push(rawToken);
  }
  return { operands };
}

function classifySingleRmOperand(rawOperand: string, workspace: string): GuardResult {
  const stripped = unquote(rawOperand);

  if (stripped === "~" || stripped.startsWith("~/")) {
    return {
      verdict: "block",
      reason: "penghapusan home (rm -rf ~) diblokir",
      ruleId: "block:rm-home",
    };
  }

  if (RM_UNSAFE_CHARS.test(stripped)) {
    return {
      verdict: "block",
      reason: `rm target kompleks (${rawOperand}) tidak dapat di-parse dengan aman; jalankan ga trash <path> per target`,
      ruleId: "block:rm-complex-target",
    };
  }

  const target = resolveLexical(workspace, stripped);

  if (target === "/" || stripped === "/") {
    return {
      verdict: "block",
      reason: "penghapusan root (rm -rf /) diblokir",
      ruleId: "block:rm-root",
    };
  }

  if (target === homedir()) {
    return {
      verdict: "block",
      reason: "penghapusan home (rm -rf ~) diblokir",
      ruleId: "block:rm-home",
    };
  }

  const inside = isInsideWorkspace(workspace, target) || isInsideWorkspacePhysical(workspace, target);
  if (!inside) {
    return {
      verdict: "block",
      reason: `trash hanya mencakup workspace; ${target} berada di luar workspace`,
      ruleId: "block:rm-outside",
    };
  }

  const effectiveTarget = isInsideWorkspace(workspace, target)
    ? target
    : resolvePhysical(workspace, target);

  if (isProtectedPath(workspace, effectiveTarget)) {
    return {
      verdict: "block",
      reason: protectedReason(effectiveTarget),
      ruleId: "block:rm-protected",
    };
  }

  return {
    verdict: "allow",
    reason: "rewritten to trash",
    replacement: { kind: "trash", path: effectiveTarget },
    ruleId: "rewrite:rm-trash",
  };
}

function classifyRm(segment: string, workspace: string): GuardResult | null {
  const rawTokens = tokenize(segment);
  const program = stripQuotes(rawTokens[0]?.split("/").pop() ?? rawTokens[0] ?? "").replace(/^[()]+|[()]+$/g, "");

  const delegated = checkDelegatedRm(rawTokens, program);
  if (delegated) return delegated;

  const { tokens, hitLimit } = stripLaunchers(rawTokens);
  if (hitLimit) {
    return {
      verdict: "ask",
      reason: "rantai launcher terlalu dalam (melebihi batas)",
      ruleId: "ask:launcher-depth",
    };
  }
  const progName = stripQuotes(tokens[0]?.split("/").pop() ?? tokens[0] ?? "").replace(/^[()]+|[()]+$/g, "");
  if (progName !== "rm") return null;

  const { operands, error } = parseRmOperands(tokens);
  if (error) return error;

  if (operands.length === 0) {
    return { verdict: "ask", reason: "rm tanpa operand memerlukan persetujuan", ruleId: "ask:rm-no-operand" };
  }
  if (operands.length > 1) {
    return {
      verdict: "block",
      reason: "rm dengan banyak target tidak dapat di-undo otomatis; jalankan ga trash <path> per target",
      ruleId: "block:rm-multi-target",
    };
  }

  return classifySingleRmOperand(operands[0], workspace);
}

const SEVERITY: Record<"allow" | "ask" | "block", number> = { allow: 0, ask: 1, block: 2 };

function stricter(a: GuardResult, b: GuardResult): GuardResult {
  return SEVERITY[b.verdict] > SEVERITY[a.verdict] ? b : a;
}

/** Commands whose arguments are written to (or renamed onto) the target path. */
const WRITE_VERBS = new Set([
  "tee", "cp", "mv", "install", "ln", "truncate", "dd", "sed", "perl",
  "chmod", "chown", "touch", "mkdir", "rmdir", "unlink", "rm", "rsync",
  "tar", "unzip", "patch", "shred",
]);

/**
 * Verbs whose write targets `extractVerbTargets` can identify precisely, so
 * non-target arguments (a sed script, chown's owner spec, tar's input list) can
 * safely be skipped. Every other write verb keeps the conservative scan over
 * all arguments, because mis-identifying a target there would let a protected
 * path through (e.g. `ln -sf x .git/config`).
 */
const PRECISE_TARGET_VERBS = new Set([
  "tee", "cp", "mv", "install", "truncate", "dd", "sed",
]);

function readTargetToken(
  command: string,
  start: number,
): { target: string; end: number; quoted: boolean } {
  let j = start;
  while (j < command.length && (command[j] === ">" || command[j] === "|" || command[j] === "&")) {
    j += 1;
  }
  while (j < command.length && /\s/.test(command[j])) {
    j += 1;
  }

  let target = "";
  let tQuote: '"' | "'" | null = null;
  let parenDepth = 0;
  let inBacktick = false;
  let sawQuoted = false;

  while (j < command.length) {
    const tch = command[j];
    if (tQuote !== null) {
      // Quote characters are dropped rather than kept: a `(` or `)` inside
      // `"report (final).md"` is a literal filename character, not a subshell.
      // Keeping the quotes made the dynamic-target check fire on valid names.
      if (tch === tQuote) {
        tQuote = null;
        sawQuoted = true;
      } else {
        target += tch;
      }
    } else if (tch === '"' || tch === "'") {
      tQuote = tch;
      sawQuoted = true;
    } else if (tch === "`") {
      inBacktick = !inBacktick;
      target += tch;
    } else if (tch === "(" && target.endsWith("$")) {
      parenDepth += 1;
      target += tch;
    } else if (tch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      target += tch;
    } else if (parenDepth === 0 && !inBacktick && /[\s;&|<>)]/.test(tch)) {
      break;
    } else {
      target += tch;
    }
    j += 1;
  }
  // `sawQuoted` marks the whole target as literal: no expansion or operator
  // can hide inside it, so callers must not treat `(` `)` `<` as dynamic.
  return { target: target.trim(), end: j, quoted: sawQuoted };
}

/** A redirection target plus the operator that produced it. */
type RedirectTarget = { target: string; append: boolean; quoted: boolean };

/**
 * Extract redirection targets from a command string.
 *
 * `append` distinguishes `>>` from `>`: appending to a log never destroys the
 * existing contents, so treating it as an overwrite made `echo x >> build.log`
 * prompt on every build.
 */
function extractUnquotedRedirects(command: string): RedirectTarget[] {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const targets: RedirectTarget[] = [];

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ">") {
      const append = command[i + 1] === ">";
      const { target, end, quoted } = readTargetToken(command, i + 1);
      if (target.length > 0) targets.push({ target, append, quoted });
      i = end - 1;
    }
  }

  return targets;
}

/**
 * The guard must protect its own state. `write`/`edit` are checked by path in
 * `classify`, but bash can reach the same files through redirection or a
 * write-capable verb. This closes that route so the agent cannot forge
 * approvals or erase the audit trail with a shell command.
 */
function classifyProtectedWrite(
  command: string,
  workspace: string,
  cwdMap?: Map<string, string>,
): GuardResult | null {
  const blocked = (path: string): GuardResult => ({
    verdict: "block",
    reason: protectedReason(path),
    ruleId: "block:protected-bash-write",
  });

  const segments = splitSegments(command);
  for (const segment of segments) {
    const cwd = cwdMap?.get(segment) ?? workspace;

    for (const raw of extractUnquotedRedirects(segment)) {
      // A fully quoted target is literal: `> "report (final).md"` creates a
      // file with parentheses in its name and runs nothing.
      if (!raw.quoted && /[$`<>()]/.test(raw.target)) {
        return {
          verdict: "block",
          reason: `pengalihan ke target dinamis (${raw.target}) berisiko merusak store dan diblokir`,
          ruleId: "block:dynamic-redirect",
        };
      }
      const clean = raw.target.replace(/['"\\]/g, "");
      const target = resolveLexical(cwd, clean);
      if (isProtectedPath(workspace, target) || isProtectedPath(workspace, resolvePhysical(workspace, target))) {
        return blocked(target);
      }
    }

    const tokens = tokenize(segment).map(unquote);
    const verbIndex = tokens.findIndex((token) =>
      WRITE_VERBS.has(stripQuotes(basenameOf(token)).replace(/^[()]+|[()]+$/g, "")),
    );
    if (verbIndex === -1) continue;

    const verbName = stripQuotes(basenameOf(tokens[verbIndex])).replace(/^[()]+|[()]+$/g, "");
    const verbArgs = tokens.slice(verbIndex + 1);

    // `sed` only writes with -i/--in-place. Treating every `sed` as a writer
    // blocked read-only pipelines (`... | sed -n '1,10p'`) and even reading the
    // audit log, which the README promises stays allowed.
    if (verbName === "sed" && !sedWritesInPlace(verbArgs)) continue;

    // Prefer precise target extraction so non-target arguments (the sed script,
    // chown's owner spec) are not mistaken for paths. Verbs without a precise
    // extractor keep the conservative all-arguments scan: `ln -sf x .git/config`
    // must still be caught.
    const extracted = extractVerbTargets(verbName, verbArgs);
    const precise = PRECISE_TARGET_VERBS.has(verbName);
    const writeTargets = precise ? extracted.targets : verbArgs;

    // A verb that also takes read operands (cp/mv source, tar input list) can
    // hide the store in a non-target argument: `cp x $(echo .git/config)`.
    // Scan the remaining arguments for a *static* protected path, but do not
    // apply the dynamic-target rule to them — `cp $(pwd)/a b` is a source, and
    // blocking it broke the most common Makefile idiom.
    if (precise) {
      const targetSet = new Set(writeTargets);
      for (const rawToken of verbArgs) {
        if (targetSet.has(rawToken)) continue;
        const token = unquote(rawToken).replace(/^[()]+|[()]+$/g, "").replace(/['"\\]/g, "");
        if (!token || token.startsWith("-") || /[$`<>()]/.test(token)) continue;
        const target = resolveLexical(cwd, token);
        if (isProtectedPath(workspace, target) || isProtectedPath(workspace, resolvePhysical(workspace, target))) {
          return blocked(target);
        }
      }
    }

    for (const rawToken of writeTargets) {
      let token = rawToken;
      if (token.startsWith("of=")) token = token.slice(3);
      else if (token.startsWith("--output=")) token = token.slice(9);
      token = unquote(token).replace(/^[()]+|[()]+$/g, "").replace(/['"\\]/g, "");
      if (token.startsWith("-") || /^(?:[0-9]+)?>>?|^(?:[0-9]+)?<|^&>/.test(token)) continue;
      // Only `$` and backticks expand. A bare parenthesis surviving unquoting
      // came from a quoted literal (`sed -i 's/a(b)/c/' f.ts`, `cp x "b (1).json"`),
      // so it is part of the filename, not a subshell.
      if (/[$`]/.test(token)) {
        return {
          verdict: "block",
          reason: `argumen penulisan dinamis (${token}) berisiko merusak store dan diblokir`,
          ruleId: "block:dynamic-write-verb",
        };
      }
      const target = resolveLexical(cwd, token);
      if (isProtectedPath(workspace, target) || isProtectedPath(workspace, resolvePhysical(workspace, target))) {
        return blocked(target);
      }
    }
  }

  return null;
}

function basenameOf(token: string): string {
  const index = token.lastIndexOf("/");
  return index === -1 ? token : token.slice(index + 1);
}

const SYSTEM_SINKS = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

function isSink(target: string): boolean {
  return SYSTEM_SINKS.has(target) || /^&?[0-9]+$/.test(target);
}

const WRITE_OVERWRITE_VERBS = new Set([
  "cp", "mv", "install", "tee", "sed", "truncate", "dd",
]);

function extractSedTargets(args: string[]): string[] {
  const hasInPlace = args.some(
    (t) =>
      t === "-i" ||
      t.startsWith("-i") ||
      t === "--in-place" ||
      t.startsWith("--in-place="),
  );
  if (!hasInPlace) return [];

  const nonFlags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-i") {
      if (
        i + 1 < args.length &&
        (args[i + 1] === "''" || args[i + 1] === '""' || args[i + 1].startsWith("."))
      ) {
        i++;
      }
      continue;
    }
    if (a === "-e" || a === "-f") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    nonFlags.push(a);
  }
  const hasExplicitScript = args.some((t) => t === "-e" || t === "-f");
  return hasExplicitScript ? nonFlags : nonFlags.slice(1);
}

function extractTruncateTargets(args: string[]): string[] {
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-s" || a === "--size" || a === "-r" || a === "--reference") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    targets.push(a);
  }
  return targets;
}

function extractCpMvTargets(args: string[]): { targets: string[]; srcPaths?: string[] } {
  const targetDirIdx = args.findIndex((t) => t === "-t" || t === "--target-directory");
  if (targetDirIdx !== -1 && targetDirIdx + 1 < args.length) {
    const nonFlags = args.filter((t, idx) => !t.startsWith("-") && idx !== targetDirIdx + 1);
    return { targets: [args[targetDirIdx + 1]], srcPaths: nonFlags };
  }
  const targetDirEq = args.find((t) => t.startsWith("--target-directory="));
  if (targetDirEq) {
    const nonFlags = args.filter((t) => !t.startsWith("-"));
    return { targets: [targetDirEq.slice("--target-directory=".length)], srcPaths: nonFlags };
  }
  const nonFlags = args.filter((t) => !t.startsWith("-"));
  if (nonFlags.length >= 2) {
    return { targets: [nonFlags[nonFlags.length - 1]], srcPaths: nonFlags.slice(0, -1) };
  }
  return { targets: [] };
}

function extractVerbTargets(verb: string, args: string[]): { targets: string[]; srcPaths?: string[] } {
  if (verb === "dd") {
    const ofToken = args.find((t) => t.startsWith("of="));
    return { targets: ofToken ? [unquote(ofToken.slice(3)).replace(/['"\\]/g, "")] : [] };
  }
  if (verb === "sed") return { targets: extractSedTargets(args) };
  if (verb === "truncate") return { targets: extractTruncateTargets(args) };
  if (verb === "tee") return { targets: args.filter((t) => !t.startsWith("-")) };
  if (verb === "cp" || verb === "mv" || verb === "install") return extractCpMvTargets(args);
  return { targets: [] };
}

function checkTargetOverwrite(
  workspace: string,
  targetPath: string,
  srcPaths?: string[],
  cwd: string = workspace,
  quoted = false,
): GuardResult | null {
  if (!targetPath) return null;
  const clean = unquote(targetPath).replace(/['"\\]/g, "");
  if (!clean || isSink(clean)) return null;

  // A fully quoted target is a literal filename: `(` `)` `$` `<` `>` inside it
  // are characters, not shell operators. Only unquoted targets can expand.
  if (!quoted && /[$`<>()]/.test(clean)) {
    return {
      verdict: "ask",
      reason: `menulis ke target dinamis: ${clean}`,
      ruleId: "ask:dynamic-write",
    };
  }

  const target = resolveLexical(cwd, clean);

  if (!isInsideWorkspace(workspace, target) || !isInsideWorkspacePhysical(workspace, clean)) {
    return {
      verdict: "ask",
      reason: `menulis di luar workspace: ${target}`,
      ruleId: "ask:write-outside",
    };
  }

  let effective = target;
  let targetIsDirectory = false;
  try {
    targetIsDirectory = existsSync(target) && statSync(target).isDirectory();
    if (targetIsDirectory && srcPaths && srcPaths.length > 0) {
      // `cp a.ts dir/` writes `dir/a.ts`. Only that file can be overwritten;
      // the directory itself is not a victim. If no candidate exists yet the
      // copy creates new files, so nothing is overwritten.
      let resolvedCandidate = false;
      for (const sp of srcPaths) {
        const candidate = resolve(target, basenameOf(sp));
        if (existsSync(candidate)) {
          effective = candidate;
          resolvedCandidate = true;
          break;
        }
      }
      if (!resolvedCandidate) return null;
    }
  } catch {}

  // Copying/moving into an existing directory is a normal, non-destructive
  // operation; only an actual file at the resolved path counts as overwrite.
  if (targetIsDirectory) return null;

  const exists =
    existsSync(effective) ||
    existsSync(resolvePhysical(workspace, clean));

  if (exists) {
    return {
      verdict: "ask",
      reason: `menimpa file yang sudah ada: ${effective}`,
      ruleId: "ask:overwrite",
    };
  }

  return null;
}

function classifyOverwrite(
  command: string,
  workspace: string,
  cwdMap?: Map<string, string>,
): GuardResult | null {
  const segments = splitSegments(command);

  for (const segment of segments) {
    const cwd = cwdMap?.get(segment) ?? workspace;

    for (const raw of extractUnquotedRedirects(segment)) {
      // Appending never destroys existing content, so `>>` must not raise an
      // overwrite prompt. Only `>` (truncate) is checked here.
      if (raw.append) continue;
      const res = checkTargetOverwrite(workspace, raw.target, undefined, cwd, raw.quoted);
      if (res) return res;
    }

    const tokens = tokenize(segment).map(unquote);
    const verbIndex = tokens.findIndex((token) =>
      WRITE_OVERWRITE_VERBS.has(stripQuotes(basenameOf(token))),
    );
    if (verbIndex === -1) continue;

    const verb = stripQuotes(basenameOf(tokens[verbIndex]));
    const args = tokens.slice(verbIndex + 1);
    const { targets, srcPaths } = extractVerbTargets(verb, args);

    for (const target of targets) {
      const res = checkTargetOverwrite(workspace, target, srcPaths, cwd);
      if (res) return res;
    }
  }

  return null;
}

const MAX_UNWRAP_DEPTH = 5;

function isSoleShellWrapper(segment: string): boolean {
  const trimmed = segment.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) return true;
  const tokens = tokenize(segment);
  if (tokens.length === 0) return false;
  const { tokens: head } = stripLaunchers(tokens);
  if (head.length < 2) return false;
  const program = stripQuotes(head[0].split("/").pop() ?? head[0]);
  if (SHELLS.has(program)) {
    return head.some((t) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(stripQuotes(t)));
  }
  return program === "eval";
}

function classifyUnwrapped(
  command: string,
  workspace: string,
  depth: number,
): GuardResult | null {
  if (depth >= MAX_UNWRAP_DEPTH) {
    return {
      verdict: "ask",
      reason: "eksekusi shell bertingkat melebihi batas unwrap",
      ruleId: "ask:wrapper-depth",
    };
  }
  const segments = splitSegments(command);
  for (const segment of segments) {
    for (const inner of unwrapAll(segment)) {
      const innerResult = classifyCommand(inner, workspace, depth + 1);
      if (innerResult.verdict !== "allow") {
        return { ...innerResult, ruleId: innerResult.ruleId ?? "block:wrapper" };
      }
      if (innerResult.replacement) {
        if (isSoleShellWrapper(segment) && segments.length === 1) {
          return innerResult;
        }
        return {
          verdict: "block",
          reason: "rm di dalam wrapper atau command substitution tidak dapat di-rewrite otomatis; jalankan ga trash <path> terpisah",
          ruleId: "block:rm-wrapper",
        };
      }
    }
  }
  return null;
}

function classifyRmSegments(
  segments: string[],
  workspace: string,
): { rmResult: GuardResult | null; rewriteable: boolean } {
  let rmResult: GuardResult | null = null;
  for (const segment of segments) {
    const res = classifyRm(segment, workspace);
    if (res) {
      rmResult = res;
      break;
    }
  }
  const rewriteable = rmResult?.replacement !== undefined && segments.length === 1;
  return { rmResult, rewriteable };
}

function trackEffectiveCwd(
  segments: string[],
  workspace: string,
): { cwdMap: Map<string, string>; error?: GuardResult } {
  const cwdMap = new Map<string, string>();
  let current = workspace;

  for (const segment of segments) {
    cwdMap.set(segment, current);
    const tokens = tokenize(segment);
    const { tokens: stripped, hitLimit } = stripLaunchers(tokens);
    if (hitLimit) {
      return {
        cwdMap,
        error: {
          verdict: "ask",
          reason: "rantai launcher terlalu dalam (melebihi batas)",
          ruleId: "ask:launcher-depth",
        },
      };
    }
    if (stripped.length === 0) continue;

    const prog = stripQuotes(basenameOf(stripped[0]));
    if (prog === "cd" || prog === "pushd") {
      let targetIdx = 1;
      while (targetIdx < stripped.length && stripped[targetIdx].startsWith("-")) {
        if (stripQuotes(stripped[targetIdx]) === "--") {
          targetIdx += 1;
          break;
        }
        targetIdx += 1;
      }
      const rawTarget = stripped[targetIdx] ?? "~";
      const cleanTarget = stripQuotes(rawTarget);
      if (/[$`<>()]/.test(cleanTarget)) {
        return {
          cwdMap,
          error: {
            verdict: "ask",
            reason: "berpindah ke direktori dinamis memerlukan persetujuan",
            ruleId: "ask:cd-dynamic",
          },
        };
      }
      const resolvedTarget = resolveLexical(current, cleanTarget);
      if (
        isProtectedPath(workspace, resolvedTarget) ||
        isProtectedPath(workspace, resolvePhysical(workspace, resolvedTarget))
      ) {
        return {
          cwdMap,
          error: {
            verdict: "block",
            reason: protectedReason(resolvedTarget),
            ruleId: "block:cd-protected",
          },
        };
      }
      current = resolvedTarget;
    }
  }

  return { cwdMap };
}

/**
 * Classify a shell command, unwrapping all levels of indirection.
 * Catches wrappers like `bash -c "rm -rf /"` and multi-substitution commands.
 */
function classifyCommand(
  command: string,
  workspace: string,
  depth: number,
): GuardResult {
  if (depth >= MAX_UNWRAP_DEPTH) {
    return {
      verdict: "ask",
      reason: "eksekusi shell bertingkat melebihi batas unwrap",
      ruleId: "ask:wrapper-depth",
    };
  }
  const normalized = neutralizeQuotedHeredoc(
    command.replace(/\$\{IFS\}|\$IFS\b/g, " "),
  );
  const masked = maskEscapedBackticks(maskSingleQuoted(normalized));
  // Pattern matching uses a variant where quoted *payload* is inert. Wrapper
  // unwrapping still runs on `masked` so `bash -c "rm -rf /"` keeps working.
  const patternTarget = maskQuotedPayloads(normalized);
  const segments = splitSegments(normalized);
  const { cwdMap, error: cwdError } = trackEffectiveCwd(segments, workspace);
  if (cwdError) return cwdError;

  const protectedWrite = classifyProtectedWrite(masked, workspace, cwdMap);
  if (protectedWrite) return protectedWrite;

  const interpreter = classifyInterpreterCode(segments);
  if (interpreter?.verdict === "block") return interpreter;

  // Patterns must run against `masked`, not `normalized`: `normalized` keeps
  // quote characters intact, so text inside a quoted argument (`git commit -m
  // "reject rm -rf /"`, `grep -rn "use shred"`) was scanned as live shell and
  // blocked work that never executes anything.
  for (const { id, re, reason } of BLOCK_PATTERNS) {
    if (re.test(patternTarget)) return { verdict: "block", reason, ruleId: id };
  }

  const sql = classifySql(normalized);
  if (sql && sql.verdict === "block") {
    return {
      verdict: "block",
      reason: sql.reason ?? "perintah SQL diblokir",
      ruleId: `sql:${sql.verdict}`,
    };
  }

  const wrapper = classifyUnwrapped(masked, workspace, depth);
  if (wrapper && wrapper.verdict === "block") return wrapper;

  for (const segment of segments) {
    const rawTokens = tokenize(segment);
    const { tokens, hitLimit } = stripLaunchers(rawTokens);
    if (hitLimit) {
      return {
        verdict: "ask",
        reason: "rantai launcher terlalu dalam (melebihi batas)",
        ruleId: "ask:launcher-depth",
      };
    }
    if (tokens.length > 0) {
      const head = tokens[0];
      if (!head.startsWith("$'") && !head.startsWith('$"')) {
        const cleanHead = stripQuotes(head);
        if (/^\$([A-Za-z_0-9@*#?]|{[^}]+}|\()|^`/.test(cleanHead)) {
          return {
            verdict: "ask",
            reason: `eksekusi perintah melalui variabel atau substitusi (${tokens[0]}) memerlukan persetujuan`,
            ruleId: "ask:variable-command",
          };
        }
      }
    }
  }

  const { rmResult, rewriteable } = classifyRmSegments(segments, workspace);
  const effectiveRm = wrapper?.replacement ? wrapper : rmResult;
  const isRewriteable = wrapper?.replacement ? true : rewriteable;

  const blockedRewrite: GuardResult | null =
    effectiveRm?.replacement && !isRewriteable
      ? {
          verdict: "block",
          reason: "rm yang dirangkai dengan perintah lain tidak dapat di-rewrite otomatis; jalankan ga trash <path> terpisah",
          ruleId: "block:rm-chained",
        }
      : null;

  let effective: GuardResult | null = blockedRewrite ?? effectiveRm;
  if (wrapper && wrapper.verdict === "ask") {
    effective = effective ? stricter(effective, wrapper) : wrapper;
  }
  if (sql && sql.verdict === "ask") {
    const sqlAsk: GuardResult = {
      verdict: "ask",
      reason: sql.reason ?? "perintah SQL memerlukan persetujuan",
      ruleId: `sql:${sql.verdict}`,
    };
    effective = effective ? stricter(effective, sqlAsk) : sqlAsk;
  }
  if (interpreter && interpreter.verdict === "ask") {
    effective = effective ? stricter(effective, interpreter) : interpreter;
  }

  for (const { id, re, reason } of ASK_PATTERNS) {
    if (re.test(patternTarget)) {
      if (!effective) return { verdict: "ask", reason, ruleId: id };
      const merged = stricter(effective, { verdict: "ask", reason, ruleId: id });
      if (merged.verdict === "ask" && effective.replacement && isRewriteable) {
        return { ...merged, replacement: effective.replacement };
      }
      return merged;
    }
  }

  const overwrite = classifyOverwrite(normalized, workspace, cwdMap);
  if (overwrite) return effective ? stricter(effective, overwrite) : overwrite;

  return effective ?? { verdict: "allow", reason: "default allow", ruleId: "allow:default" };
}

function classifyWriteTool(call: ToolCall, workspace: string): GuardResult {
  const rawPath = extractPath(call.input);
  if (!rawPath) {
    return {
      verdict: "ask",
      reason: "path tidak diketahui; persetujuan diperlukan",
      ruleId: "ask:unknown-path",
    };
  }

  const lexical = resolveLexical(workspace, rawPath);

  // The store must be immutable for the guarded agent: forging
  // approvals.json silently unlocks every ask-tier control, and writing
  // audit.jsonl lets the agent erase its own trail.
  if (isProtectedPath(workspace, lexical) || isProtectedPath(workspace, resolvePhysical(workspace, rawPath))) {
    return {
      verdict: "block",
      reason: protectedReason(lexical),
      ruleId: "block:protected-path",
    };
  }

  // A symlink inside the workspace can point outside it. The lexical check
  // alone would call that "inside the workspace" and allow the write.
  if (!isInsideWorkspacePhysical(workspace, rawPath)) {
    return {
      verdict: "ask",
      reason: `menulis di luar workspace: ${resolvePhysical(workspace, rawPath)}`,
      ruleId: "ask:write-outside",
    };
  }

  // The physical check above already proved the target resolves inside the
  // workspace, so this is an allow. Re-testing lexically would reject a
  // workspace spelled `/private/var/...` (what the harness reports) together
  // with a file path spelled `/var/...` (what the tool args carry) on macOS,
  // where `/var` is a symlink to `/private/var`.
  return { verdict: "allow", reason: "menulis di dalam workspace", ruleId: "allow:write-inside" };
}

/**
 * Pure classifier: maps an agent tool call to allow | ask | block.
 *
 * @param input - The tool call and workspace root
 * @returns GuardResult with verdict, reason, and optional rewrite replacement
 */
export function classify(input: ClassifierInput): GuardResult {
  const { call, workspace } = input;

  if (READ_ONLY_TOOLS.has(call.toolName)) {
    return { verdict: "allow", reason: "read-only tool" };
  }

  if (call.toolName === "write" || call.toolName === "edit" || call.toolName === "patch") {
    return classifyWriteTool(call, workspace);
  }

  const command = call.input.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return { verdict: "allow", reason: "default allow", ruleId: "allow:default" };
  }

  return classifyCommand(command, workspace, 0);
}
