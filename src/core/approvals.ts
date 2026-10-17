import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalStore, Scope } from "./types.ts";

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const STORE_VERSION = 1;

type ApprovalEntry = {
  grantedAt: number;
  expiresAt: number;
  reason?: string;
};

type ApprovalFile = {
  version: 1;
  entries: Record<string, ApprovalEntry>;
};

export type ApprovalListEntry = { key: string; expiresAt: number };

export type ApprovalStoreWithList = ApprovalStore & {
  list(now: number): ApprovalListEntry[];
};

export function scopeKey(scope: Scope): string {
  return `${scope.workspace}\0${scope.sessionId}\0${scope.scopePath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is ApprovalEntry {
  return (
    isRecord(value) &&
    typeof value.grantedAt === "number" &&
    typeof value.expiresAt === "number" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

function emptyFile(): ApprovalFile {
  return { version: STORE_VERSION, entries: {} };
}

/**
 * Parse the on-disk approvals file. Corrupt JSON or a schema mismatch is
 * treated as empty so the user is re-asked; the bad file is left untouched
 * for inspection.
 */
function parseFile(raw: string): ApprovalFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyFile();
  }

  if (!isRecord(parsed) || parsed.version !== STORE_VERSION) {
    return emptyFile();
  }
  if (!isRecord(parsed.entries)) {
    return emptyFile();
  }

  const entries: Record<string, ApprovalEntry> = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    if (isEntry(value)) entries[key] = value;
  }
  return { version: STORE_VERSION, entries };
}

export function createApprovalStore(opts: {
  workspace: string;
}): ApprovalStoreWithList {
  const dir = join(opts.workspace, ".guardian-angel");
  const file = join(dir, "approvals.json");
  const tmpFile = `${file}.tmp`;

  function read(): ApprovalFile {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return emptyFile();
    }
    return parseFile(raw);
  }

  function write(data: ApprovalFile): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpFile, JSON.stringify(data), "utf8");
    renameSync(tmpFile, file);
  }

  return {
    check(scope: Scope, now: number): boolean {
      const entry = read().entries[scopeKey(scope)];
      return entry !== undefined && now < entry.expiresAt;
    },

    grant(scope: Scope, now: number, reason?: string): void {
      const data = read();
      const entry: ApprovalEntry = {
        grantedAt: now,
        expiresAt: now + APPROVAL_TTL_MS,
      };
      if (reason !== undefined) entry.reason = reason;
      data.entries[scopeKey(scope)] = entry;
      write(data);
    },

    revoke(scope: Scope): void {
      const data = read();
      delete data.entries[scopeKey(scope)];
      write(data);
    },

    gc(now: number): number {
      const data = read();
      let removed = 0;
      for (const [key, entry] of Object.entries(data.entries)) {
        if (!(now < entry.expiresAt)) {
          delete data.entries[key];
          removed += 1;
        }
      }
      if (removed > 0) write(data);
      return removed;
    },

    list(now: number): ApprovalListEntry[] {
      const data = read();
      return Object.entries(data.entries)
        .filter(([, entry]) => now < entry.expiresAt)
        .map(([key, entry]) => ({ key, expiresAt: entry.expiresAt }));
    },
  };
}
