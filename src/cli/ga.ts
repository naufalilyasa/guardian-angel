#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gc, listTrash, restore, safeDelete, TRASH_TTL_MS } from "../core/trash.ts";
import { auditFile, ensureStore } from "../core/store.ts";
import { createApprovalStore } from "../core/approvals.ts";

const USAGE = `guardian-angel CLI

Usage:
  ga trash <path>        pindahkan file/folder ke trash
  ga restore --last      pulihkan item terbaru
  ga restore <id>        pulihkan item berdasarkan id
  ga list                tampilkan isi trash
  ga gc                  hapus item lebih tua dari 24 jam
  ga status              ringkasan store

Global:
  --workspace <path>     workspace root (default: $GA_WORKSPACE atau cwd)
`;

function fail(message: string): never {
  process.stderr.write(`ga: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): { workspace: string; args: string[] } {
  let workspace = process.env.GA_WORKSPACE ?? process.cwd();
  const args: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--workspace") {
      const value = argv[i + 1];
      if (!value) fail("--workspace memerlukan path");
      workspace = value;
      i += 1;
      continue;
    }
    if (argv[i].startsWith("--workspace=")) {
      workspace = argv[i].slice("--workspace=".length);
      continue;
    }
    args.push(argv[i]);
  }

  return { workspace: resolve(workspace), args };
}

function cmdTrash(workspace: string, args: string[]): void {
  const target = args[0];
  if (!target) fail("ga trash memerlukan <path>");
  if (!existsSync(resolve(workspace, target))) fail(`tidak ditemukan: ${target}`);

  const id = safeDelete(workspace, target);
  process.stdout.write(`${id}\n`);
}

function cmdRestore(workspace: string, args: string[]): void {
  const arg = args[0];
  if (!arg) fail("ga restore memerlukan <id> atau --last");

  let id = arg;
  if (arg === "--last") {
    const [latest] = listTrash(workspace);
    if (!latest) fail("trash kosong");
    id = latest.id;
  }

  const restored = restore(workspace, id);
  process.stdout.write(`dipulihkan: ${restored}\n`);
}

function cmdList(workspace: string): void {
  const entries = listTrash(workspace);
  if (entries.length === 0) {
    process.stdout.write("trash kosong\n");
    return;
  }
  for (const entry of entries) {
    process.stdout.write(`${entry.id}\t${entry.kind}\t${entry.deletedAt}\t${entry.originalPath}\n`);
  }
}

function cmdGc(workspace: string): void {
  const removed = gc(workspace);
  process.stdout.write(`dihapus: ${removed}\n`);
}

function cmdStatus(workspace: string): void {
  ensureStore(workspace);
  const approvals = createApprovalStore({ workspace });
  const trashCount = listTrash(workspace).length;

  process.stdout.write(`workspace: ${workspace}\n`);
  process.stdout.write(`trash: ${trashCount} item\n`);
  process.stdout.write(`approvals: ${approvals.list(Date.now()).length} aktif\n`);
  process.stdout.write(`audit: ${auditFile(workspace)}\n`);
  process.stdout.write(`ttl: ${TRASH_TTL_MS} ms\n`);
}

function main(): void {
  const { workspace, args } = parseArgs(process.argv.slice(2));
  const command = args[0];
  const rest = args.slice(1);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    fail(`workspace tidak valid: ${workspace}`);
  }

  switch (command) {
    case "trash":
      cmdTrash(workspace, rest);
      break;
    case "restore":
      cmdRestore(workspace, rest);
      break;
    case "list":
      cmdList(workspace);
      break;
    case "gc":
      cmdGc(workspace);
      break;
    case "status":
      cmdStatus(workspace);
      break;
    default:
      fail(`perintah tidak dikenal: ${command}\n\n${USAGE}`);
  }
}

main();
