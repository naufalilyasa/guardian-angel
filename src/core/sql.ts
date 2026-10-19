export type SqlVerdict = { verdict: "allow" | "ask" | "block"; reason?: string };

const CLIENTS = new Set(["mysql", "mariadb", "psql", "sqlite3", "mongosh"]);

const ALLOW_KEYWORDS = new Set([
  "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "PRAGMA",
]);
const BLOCK_KEYWORDS = new Set(["DROP", "TRUNCATE", "ALTER"]);
const ASK_KEYWORDS = new Set(["DELETE", "UPDATE"]);
const OTHER_KEYWORDS = new Set([
  "INSERT", "CREATE", "REPLACE", "GRANT", "REVOKE", "CALL", "MERGE", "VACUUM",
]);

const SQL_KEYWORDS = new Set([
  ...ALLOW_KEYWORDS,
  ...BLOCK_KEYWORDS,
  ...ASK_KEYWORDS,
  ...OTHER_KEYWORDS,
]);

const SEVERITY: Record<SqlVerdict["verdict"], number> = { allow: 0, ask: 1, block: 2 };

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

function normalizeEscapes(sql: string): string {
  return sql.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function firstKeyword(sql: string): string | null {
  const cleaned = stripComments(normalizeEscapes(sql)).trim();
  if (cleaned.length === 0) return null;
  const match = cleaned.match(/^[A-Za-z]+/);
  return match ? match[0].toUpperCase() : null;
}

function hasWhereClause(sql: string): boolean {
  return /\bWHERE\b/i.test(stripComments(normalizeEscapes(sql)));
}

function classifyStatement(sql: string): SqlVerdict {
  const keyword = firstKeyword(sql);
  if (keyword === null) {
    return { verdict: "ask", reason: "query tidak dapat diparse" };
  }
  if (ALLOW_KEYWORDS.has(keyword)) {
    return { verdict: "allow", reason: `${keyword} read-only` };
  }
  if (BLOCK_KEYWORDS.has(keyword)) {
    return { verdict: "block", reason: `${keyword} diblokir` };
  }
  if (ASK_KEYWORDS.has(keyword)) {
    if (!hasWhereClause(sql)) {
      return { verdict: "ask", reason: `${keyword} tanpa WHERE memerlukan persetujuan` };
    }
    return { verdict: "ask", reason: `${keyword} memerlukan persetujuan` };
  }
  if (OTHER_KEYWORDS.has(keyword)) {
    return { verdict: "ask", reason: "unclassified SQL" };
  }
  return { verdict: "ask", reason: "unclassified SQL" };
}

function classifyPayload(sql: string): SqlVerdict {
  const statements = sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (statements.length === 0) {
    return { verdict: "ask", reason: "query tidak dapat diparse" };
  }

  let worst: SqlVerdict | null = null;
  for (const statement of statements) {
    const result = classifyStatement(statement);
    if (worst === null || SEVERITY[result.verdict] > SEVERITY[worst.verdict]) {
      worst = result;
    }
  }
  return worst ?? { verdict: "ask", reason: "query tidak dapat diparse" };
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

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escaped) {
      current += ch === "n" || ch === "t" ? "\\" + ch : ch;
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
    if (/\s/.test(ch)) {
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

function findClient(tokens: string[]): { index: number; client: string } | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const base = tokens[i].split("/").pop() ?? tokens[i];
    if (CLIENTS.has(base)) return { index: i, client: base };
  }
  return null;
}

type Payloads = {
  sql: string[];
  fromFile: boolean;
  /** True when the client was invoked with more than one inline payload. */
  multiple: boolean;
};

/**
 * Collect *every* inline payload, not just the first one. A client accepts
 * repeated `-e`/`-c`/`--execute` flags and runs them in order, so stopping at
 * the first would let `psql -c "SELECT 1" -c "DROP TABLE t"` look harmless.
 */
function payloadFromArgs(client: string, args: string[]): Payloads {
  const equalsFlags = new Set(["-e", "--execute", "-c", "--command", "--eval"]);
  const sql: string[] = [];
  let fromFile = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const eqIndex = arg.indexOf("=");

    if (arg.startsWith("--") && eqIndex > 0) {
      const flag = arg.slice(0, eqIndex);
      if (equalsFlags.has(flag)) {
        sql.push(unquote(arg.slice(eqIndex + 1)));
        continue;
      }
    }
    if (equalsFlags.has(arg) && i + 1 < args.length) {
      sql.push(unquote(args[i + 1]));
      i += 1;
      continue;
    }
    if (arg === "<") {
      fromFile = true;
      if (i + 1 < args.length) i += 1;
      continue;
    }
    if (arg === "-f" || arg === "--file") {
      fromFile = true;
      if (i + 1 < args.length) i += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      fromFile = true;
    }
  }

  if (sql.length === 0 && client === "sqlite3") {
    const positional = args.filter((a) => !a.startsWith("-") && a !== "<");
    for (const candidate of positional) {
      const text = unquote(candidate);
      const keyword = firstKeyword(text);
      if (keyword !== null && SQL_KEYWORDS.has(keyword)) {
        sql.push(text);
        break;
      }
    }
  }

  return { sql, fromFile, multiple: sql.length > 1 };
}

/** Classify every payload and return the most severe verdict. */
function classifyAll(payloads: Payloads): SqlVerdict {
  if (payloads.fromFile) {
    return { verdict: "ask", reason: "SQL dari file tidak dapat diperiksa" };
  }
  if (payloads.sql.length === 0) {
    return { verdict: "ask", reason: "query tidak dapat diparse" };
  }

  let worst: SqlVerdict | null = null;
  for (const payload of payloads.sql) {
    const result = classifyPayload(payload);
    if (worst === null || SEVERITY[result.verdict] > SEVERITY[worst.verdict]) {
      worst = result;
    }
  }

  if (worst === null) {
    return { verdict: "ask", reason: "query tidak dapat diparse" };
  }

  // Several payloads means the caller is chaining statements; never let that
  // shape fall through as a plain allow even when every part reads as safe.
  if (payloads.multiple && SEVERITY[worst.verdict] < SEVERITY.ask) {
    return { verdict: "ask", reason: "beberapa payload SQL memerlukan persetujuan" };
  }
  return worst;
}

function heredocPayload(command: string): string | null {
  const match = command.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?([\s\S]*?)\n\1\b/);
  return match ? match[2] : null;
}

export function classifySql(command: string): SqlVerdict | null {
  if (typeof command !== "string" || command.trim().length === 0) return null;

  const pipeIndex = command.indexOf("|");
  if (pipeIndex > 0) {
    const left = command.slice(0, pipeIndex);
    const right = command.slice(pipeIndex + 1);
    const rightTokens = tokenize(right);
    const client = findClient(rightTokens);
    if (client) {
      const leftTokens = tokenize(left);
      const payload = leftTokens.filter((t) => t !== "echo").map(unquote).join(" ");
      if (payload.trim().length > 0) return classifyPayload(payload);
      return { verdict: "ask", reason: "query tidak dapat diparse" };
    }
  }

  const heredoc = heredocPayload(command);
  if (heredoc !== null && /\b(mysql|mariadb|psql|sqlite3|mongosh)\b/.test(command)) {
    return classifyPayload(heredoc);
  }

  const tokens = tokenize(command);
  const found = findClient(tokens);
  if (!found) return null;

  const args = tokens.slice(found.index + 1);
  return classifyAll(payloadFromArgs(found.client, args));
}
