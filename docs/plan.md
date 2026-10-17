# Rencana eksekusi Fase 1 — Senpi/OMO Native

Prinsip: core deterministik tanpa import harness; undo > permission; semua test di sandbox sekali pakai (ADR 0007).

## Fase 0 — Scaffold

- `package.json` private (bun), `tsconfig.json`, struktur `src/core`, `src/adapters`, `test/`
- VM Lima: `vm/guardian.yaml` + `scripts/test-in-vm.sh` (repo di-mount read-only)
- Gate: `bun test` hijau **di dalam VM** (laptop tidak dipakai untuk test)

## Fase 1 — Core classifier

- `types.ts`: Tier, Verdict, Scope, PolicyConfig
- `classifier.ts`: tokenizer + resolver path + rules file/bash + ruleset SQL
  - allow: read-only, tulis dalam workspace
  - ask: DELETE/UPDATE SQL, tulis luar workspace, `git push`
  - block: `rm -rf` root/home, `mkfs`, `curl | bash`, DROP/TRUNCATE, fork bomb
- Acceptance: unit test allow/ask/block + resolusi path leksikal

## Fase 2 — Trash + undo

- `trash.ts`: safeDelete (rename dalam volume), restore, gc, listTrash
- Enforcement: path containment, operasi HANYA di dalam workspace root
- Store `<workspace>/.guardian-angel/trash` + auto-.gitignore
- Acceptance: sandbox test dengan canary di luar root tidak tersentuh; restore mengembalikan file utuh

## Fase 3 — Approvals + audit

- `approvals.json` per proyek (Scope = path + sesi, TTL, cabut manual)
- `audit.jsonl` untuk setiap Verdict block/ask
- Acceptance: Scope sama tidak ditanya dua kali; audit bertambah sesuai keputusan

## Fase 4 — Adapter Senpi
- `senpi.ts`: `pi.on("tool_call")` → classify → block `{block:true,reason}` / ask `ctx.ui.confirm` / rewrite hybrid `rm`
- Fail policy hybrid saat classifier error (ADR 0004)
- Dev: `senpi -e ./src/adapters/senpi.ts`; install: `~/.omo/agent/extensions/`
- Acceptance: uji nyata di Senpi — `rm` target tunggal → file masuk trash + restore works; `rm` kompleks → block; `DROP TABLE` → block

## Fase 5 — OpenCode v1 + pre-LLM opsional

- `src/adapters/opencode.ts` terhadap v1 (1.19.3): `tool.execute.before` (block via throw, mutate args) + pemetaan ke permission config native
- Pre-LLM: `experimental.chat.system.transform` / `experimental.chat.messages.transform` — hanya audit + penanda sesi, bukan jalur block
- Config tier `.guardian-angel/config.json` (ADR 0010)
- Acceptance: redteam corpus sama lulus di OpenCode v1; pre-LLM gagal tidak memblokir tool call

## Fase 6 — Redteam

- Corpus: ANSI-C quoting, `$()`, pipe, eval, sudo, `find -delete`, base64
- Setiap kasus: expected tier + catatan jujur bila bypass
- Acceptance: corpus jalan di CI; semua ekspektasi terpenuhi atau didokumentasikan sebagai bypass yang disadari

## Non-goals Fase 1

MCP interception, adapter Codex/Claude Code, OpenCode v2, LLM advisor, CoW snapshot, Windows.

## Syarat keras test (ADR 0007, ADR 0008)

- Runner: VM Lima (`scripts/test-in-vm.sh`); repo di-mount read-only; host macOS tidak pernah menjalankan test destruktif
- Di dalam VM: `mkdtemp` per test; env `GA_*` di-override
- `assertInSandbox(path)` fail-closed sebelum operasi destruktif
- Canary file di temp dir terpisah diverifikasi tidak tersentuh
- Tidak pernah menyentuh `$HOME`, repo nyata, atau workspace pengguna
