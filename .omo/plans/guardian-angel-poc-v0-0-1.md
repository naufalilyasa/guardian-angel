# guardian-angel-poc-v0-0-1 - Work Plan

## TL;DR (For humans)

**Who this is for and what changes for them:** Anda yang memakai agent Senpi untuk pekerjaan nyata. Setelah POC, `rm` satu target otomatis masuk trash dan bisa dipulihkan, sementara perintah destruktif kompleks ditolak dengan alasan jelas.

**What you'll get:** Paket Bun `guardian-angel` v0.0.1 dengan core deterministik (classifier, trash, approvals, audit), adapter Senpi, CLI `ga`, dan test suite yang berjalan di VM terpisah.

**Why this approach:** Satu orchestrator `guard()` memegang semua keputusan allow/ask/block, adapter hanya menerjemahkan event. Ini mencegah logika persetujuan terduplikasi saat menambah harness lain nanti.

**What it will NOT do:** Tidak menyentuh MCP, OpenCode, Codex, atau Claude Code. Tidak menjadi sandbox atau security boundary. Tidak mem-parsing shell POSIX penuh dan tidak me-resolve symlink.

**Effort:** Large

**Risk:** Medium - parser shell dan containment path adalah area yang paling mudah salah; mitigasi lewat corpus redteam dan test sandbox.

**Decisions to sanity-check:** Restore lewat CLI `ga` (termasuk `ga trash <path>`); tier default untuk perintah tak dikenal = allow; test destructive di VM Lima, smoke adapter di host hanya di direktori `mkdtemp` sekali pakai (ADR 0008); retensi trash 24 jam; `ask` tanpa UI = block.

Your next move: plan ini siap dieksekusi lewat `/ulw-execute guardian-angel-poc-v0-0-1` setelah review selesai. Full execution detail follows below.

---

> TL;DR (machine): Large effort, medium risk; 12 implementation todos + 4 final verification tasks; Bun core + Senpi adapter + CLI + Lima VM test harness.

## Scope
### Affected user and ideal state

**Affected user:** pemilik mesin ini yang menjalankan agent Senpi/OMO untuk pekerjaan nyata dan tidak mau kehilangan file karena salah `rm` atau SQL destruktif. Hari ini tidak ada guard terpasang di Senpi; setelah POC, setiap tool call melewati guard deterministik dengan undo untuk `rm` target tunggal.

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | `rm` target tunggal yang bersih otomatis masuk trash dan bisa dipulihkan dengan satu perintah CLI | undo > permission; diferensiasi utama vs cc-safety-net |
| IS-2 | Perintah destruktif kompleks (`rm -rf /`, `DROP TABLE`, `curl \| bash`) ditolak dengan alasan jelas | kerusakan yang tidak bisa di-undo harus dicegah |
| IS-3 | `DELETE`/`UPDATE` SQL meminta persetujuan sekali per Scope, bukan tiap call | alur kerja tidak terganggu, tetap aman |
| IS-4 | User bisa menyesuaikan aturan tier lewat config tanpa bisa melonggarkan block bawaan | false positive pasti terjadi; config proyek tidak boleh jadi celah |
| IS-5 | Setiap keputusan block/ask tercatat di `audit.jsonl` per proyek | investigasi insiden dan tuning aturan |
| IS-6 | Tidak ada test yang menyentuh file pengguna di laptop | kepercayaan menjalankan test destruktif; smoke adapter hanya menyentuh file dummy di `mkdtemp` |
| GAP-1 | Belum ada kode sama sekali; repo hanya dokumen | tidak ada yang bisa dijalankan |
| GAP-2 | Tidak ada guard terpasang di Senpi/OMO | cc-safety-net hanya untuk OpenCode |
| GAP-3 | Tidak ada undo untuk `rm` di harness mana pun | checkpoint Claude tidak melacak bash |
| GAP-4 | Aturan SQL masih pola teks di plugin lama dan tidak teruji | destructive-guard.js bash-only |
| GAP-5 | Isolasi VM baru di atas kertas | ADR 0008 belum diverifikasi |

### Must have

- Core deterministik tanpa import harness; `cwd`/`workspace` eksplisit.
- Classifier bash + file path + SQL dengan tier allow/ask/block; perintah tak dikenal default `allow`.
- Trash rename satu volume, restore, gc, list; rewrite hybrid `rm`; `ga trash <path>` untuk replacement.
- Approvals per-Scope dengan TTL 24 jam; audit jsonl per proyek.
- Config tier `.guardian-angel/config.json` + config global `$XDG_CONFIG_HOME/guardian-angel/config.json`; block bawaan tidak bisa diturunkan config proyek.
- Adapter Senpi `pi.on("tool_call")` dengan `sessionId` dari `ctx.sessionManager.getSessionId()`; CLI `ga` untuk trash/restore/list/gc/status.
- Seluruh test berjalan di VM Lima; canary + mount read-only diverifikasi.
- Redteam corpus awal dengan ekspektasi tier per kasus.

### Must NOT have (guardrails, anti-slop, scope boundaries)

- MCP interception, adapter OpenCode/Codex/Claude, LLM advisor, CoW snapshot, Windows.
- Symlink resolution (`fs.realpath`) dan parser shell POSIX penuh.
- UI TUI custom, dashboard, telemetry, auto-publish npm.
- Menjalankan test destruktif terhadap file pengguna di host macOS; smoke adapter hanya di `mkdtemp` sekali pakai dengan file dummy (ADR 0008).
- Menurunkan tier `block` bawaan dari config proyek.
- Menambah dependency runtime; devDependencies `@code-yeongyu/senpi@2026.10.16` (types-only) dan `typebox` diperbolehkan untuk typecheck.
- Copy+delete fallback saat rename EXDEV, resolusi symlink, dan parser SQL penuh.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: **TDD** dengan `bun:test`; test ditulis bersamaan tiap todo (implementation + test = satu todo).
- Semua test dijalankan di VM Lima lewat `scripts/test-in-vm.sh`; host macOS tidak pernah menjalankan test destruktif. Satu-satunya eksekusi di host adalah smoke adapter T9 di direktori `mkdtemp` sekali pakai yang hanya berisi file dummy.
- Setiap test filesystem memakai `mkdtemp` + `assertInSandbox(path)` fail-closed + canary file di luar root.
- Evidence: `.omo/evidence/task-<N>-guardian-angel-poc-v0-0-1.md` (di luar ulw-loop).
- Verifikasi isolasi: di dalam VM, `touch /mnt/guardian-angel/.ga-write-probe` harus gagal (mount read-only); canary `/tmp/ga-canary` utuh setelah test.

## Execution strategy
### Parallel execution waves

- **Wave 1 (fondasi, serial gate):** T1 — scaffold + tipe + path containment.
- **Wave 2 (paralel, 5 todo):** T2 classifier bash/file, T3 SQL ruleset, T4 policy config, T5 store+trash, T6 approvals+audit — semuanya hanya bergantung pada T1.
- **Wave 3 (serial gate):** T7 `guard()` orchestrator — menyatukan kelima modul Wave 2.
- **Wave 4 (paralel, 3 todo):** T8 CLI `ga`, T9 adapter Senpi, T10 VM harness + canary.
- **Wave 5 (serial):** T11 redteam corpus.
- **Wave 6 (serial):** T12 docs + versi 0.0.1 (butuh corpus T11 final).

Catatan: Wave 1, 3 adalah gerbang serial karena tipe/interface harus stabil sebelum modul paralel dan orchestrator menyatukan semuanya. Wave lain 3-5 todo agar aman diparalelkan.

### Dependency matrix

| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| T1 | - | T2-T12 | - |
| T2 | T1 | T7, T11 | T3, T4, T5, T6 |
| T3 | T1 | T7, T11 | T2, T4, T5, T6 |
| T4 | T1 | T7, T11 | T2, T3, T5, T6 |
| T5 | T1 | T7, T8 | T2, T3, T4, T6 |
| T6 | T1 | T7 | T2, T3, T4, T5 |
| T7 | T2-T6 | T8, T9, T11 | - |
| T8 | T5, T7 | T12 | T9, T10 |
| T9 | T7 | T12 | T8, T10 |
| T10 | T1 | T11, T12 | T8, T9 |
| T11 | T2-T10 | T12 | - |
| T12 | T8-T11 | - | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Scaffold Bun package, tipe inti, dan path containment
  What to do / Must NOT do: Buat `package.json` (private, `"type":"module"`, `bin: {"ga":"./src/cli/ga.ts"}`, scripts `test`/`typecheck`/`ga`), `tsconfig.json` (strict, `moduleResolution: bundler`, target ES2022), `.gitignore` root (`node_modules/`, `.omo/evidence/`, `.guardian-angel/`), `src/core/types.ts` (`Tier`, `ToolCall`, `Scope`, `PolicyRule`, `PolicyConfig`, `GuardResult`, `GuardDeps`, `ApprovalStore`, `AuditSink`), `src/core/paths.ts` (`resolveLexical(workspace, input)`, `isInsideWorkspace`, `assertInSandbox`). Definisikan bentuk persis: `ToolCall = {toolName:"bash"|"write"|"edit"; input: Record<string, unknown>}`; `GuardResult = {verdict: Tier; reason?: string; replacement?: {kind:"trash"; path: string}}`; `Scope = {workspace: string; sessionId: string; scopePath: string}`; `GuardDeps = {workspace: string; sessionId: string; confirm(title: string, message: string): Promise<boolean>; now(): number; policy: PolicyConfig; approvals: ApprovalStore; audit: AuditSink}`. `src/index.ts` hanya mengekspor tipe + `paths` (T7 menambahkan `classify`/`guard`). Tambahkan devDependencies `@code-yeongyu/senpi@2026.10.16` (types-only; adapter di-load Senpi saat runtime) dan `typebox`; JANGAN menambah dependency runtime. Inisialisasi repo: jalankan `git init` bila `.git` belum ada, buat `.gitignore` root berisi `node_modules/`, `.omo/evidence/`, `.guardian-angel/`, lalu commit awal `chore: initial commit` sebelum commit T1. JANGAN membuat `classify`/`guard` stub yang di-export sebelum implementasi.
  Closes: GAP-1
  Parallelization: Wave 1 | Blocked by: - | Blocks: T2-T12
  References (executor has NO interview context - be exhaustive): `README.md` (Arsitektur, Store); `CONTEXT.md` (Core, Adapter, Verdict, Tier, Scope); `docs/adr/0003-trash-di-volume-workspace.md`; `docs/adr/0007-test-di-sandbox.md`; `docs/plan.md` Fase 0-1; `vm/guardian.yaml`; `scripts/test-in-vm.sh`; `~/.bun/install/global/node_modules/@code-yeongyu/senpi/package.json` (exports/types), `dist/core/extensions/types.d.ts:354-368` (`ExtensionContext`).
  Acceptance criteria (agent-executable): `git rev-parse --is-inside-work-tree` true dan `git status --short` bersih setelah commit T1; `bunx tsc --noEmit` lulus; `bun test test/paths.test.ts` hijau di VM; `bun -e 'import("./src/index.ts")' tidak error.
  QA scenarios (name the exact tool + invocation): happy - `scripts/test-in-vm.sh` menjalankan `bunx tsc --noEmit && bun test` dan semua hijau; failure - `isInsideWorkspace("../etc/passwd")` false, `assertInSandbox` melempar, dan `resolveLexical("/ws", "/ws/../etc")` menghasilkan `/etc` dengan containment false. Evidence `.omo/evidence/task-1-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `chore(scaffold): bun package, core types, path containment`
  Recommended task executor category: `quick` - scaffold mekanis, satu file tipe + satu util.

- [x] 2. Classifier bash + file path (allow/ask/block)
  What to do / Must NOT do: Implementasi `src/core/classifier.ts` murni (tanpa fs): normalisasi tool (`bash`, `write`, `edit`; `read`/`grep`/`find`/`ls` → allow), tier default `allow` untuk perintah bash yang tidak cocok aturan apa pun (guard menargetkan kesalahan, bukan permission system). Rules bash: block `rm -rf /`, `rm -rf ~`, `mkfs*`, `dd of=/dev/*`, fork bomb, `curl`/`wget` pipe ke `sh`/`bash`; ask `sudo`, `git push`, `chmod -R` di luar workspace; `rm` bersih (hanya flag `-f`/`-r`/`-rf`/`-fr`, tepat satu operand literal tanpa glob `*?[`, tanpa `$`/backtick/quote-substitusi) di dalam workspace → `replacement:{kind:"trash", path:<absolute>}`; `rm` kompleks (glob, substitusi, pipe, multi-target, `find -delete`) → block dengan alasan dan panduan `ga trash <path>` per target; `rm` target di luar workspace atau workspace root → block (trash hanya mencakup workspace). Rules file path: `write`/`edit` di luar workspace → ask; di dalam → allow. Tokenizer segmen (`|`, `&&`, `||`, `;`, newline) untuk mendeteksi pipe. Kembalikan `Verdict` + `reason` + `replacement?`. JANGAN menyentuh fs, jangan mengeksekusi perintah, jangan import Senpi, jangan menganggap semua perintah tak dikenal sebagai ask.
  Closes: GAP-1, GAP-2
  Parallelization: Wave 2 | Blocked by: T1 | Blocks: T7, T11
  References: `README.md` Tier; `docs/adr/0005-threat-model.md`; `docs/adr/0006-rewrite-hybrid-rm.md`; `docs/plan.md` Fase 1; `~/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/core/extensions/types.d.ts:1447-1466` (Bash/Write/Edit input); `dist/core/tools/bash.d.ts:7-11` (`command`); `dist/core/tools/write.d.ts:6-9` (`path`); `dist/core/tools/edit.d.ts:7-12` (`path`).
  Acceptance criteria (agent-executable): `bun test test/classifier.test.ts` hijau dengan minimal 25 kasus tabel allow/ask/block; `bunx tsc --noEmit` lulus.
  QA scenarios (name the exact tool + invocation): happy - `bun test test/classifier.test.ts` semua lulus; failure - `rm -rf /` → `block`; `rm ./build` → `{kind:"trash", path:"<ws>/build"}`; `rm -rf /tmp/x` (di luar workspace) → `block`; `rm *.log` → `block`. Evidence `.omo/evidence/task-2-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `feat(classifier): bash and file-path tiers`
  Recommended task executor category: `unspecified-high` - aturan multi-kasus dan parsing segmen.

- [x] 3. Ruleset SQL (SELECT allow, DROP/TRUNCATE block, DELETE/UPDATE ask)
  What to do / Must NOT do: Implementasi `src/core/sql.ts` + integrasi ke classifier: deteksi SQL pada client `mysql`/`mariadb`/`psql`/`sqlite3`/`mongosh`; payload dari `-e`/`--execute` (mysql/mariadb), `-c`/`--command` (psql), positional SQL (sqlite3), `--eval` (mongosh), stdin pipe (`echo "DROP ..." | mysql`), heredoc, dan redirect dari file (`mysql < file.sql`). Pipe/heredoc bisa dibaca dari teks perintah; redirect file TIDAK bisa dibaca classifier murni (tanpa fs) sehingga selalu `ask` dengan reason "SQL dari file tidak dapat diperiksa". `bash -c` adalah shell, bukan payload SQL. SELECT/SHOW/DESCRIBE/EXPLAIN/PRAGMA → allow; DROP/TRUNCATE/ALTER → block; DELETE/UPDATE → ask (termasuk tanpa WHERE, dengan reason khusus); statement SQL lain yang terdeteksi → ask "unclassified SQL"; query tak terparse → ask. JANGAN membuat parser SQL penuh; jangan mengeksekusi query; `-f/--file` dan mysqldump di luar scope POC.
  Closes: GAP-4
  Parallelization: Wave 2 | Blocked by: T1 | Blocks: T7, T11
  References: `README.md` Tier; `docs/adr/0005-threat-model.md`; `docs/plan.md` Fase 1; `~/.cc-safety-net/logs/destructive-guard.jsonl` (152 denial; 79 relevan: db-eval-flag 41, db-stdin-pipe 16, sql-alter 10, sql-drop 5, sql-truncate 7).
  Acceptance criteria (agent-executable): `bun test test/sql.test.ts` hijau dengan minimal 15 kasus; semua kasus log nyata (db-eval-flag, db-stdin-pipe, sql-alter, sql-drop, sql-truncate) punya ekspektasi tier.
  QA scenarios (name the exact tool + invocation): happy - `bun test test/sql.test.ts`; failure - `mysql -e "DROP DATABASE prod"` → block, `mysql -e "SELECT 1"` → allow, `psql -c "DELETE FROM users"` → ask. Evidence `.omo/evidence/task-3-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `feat(classifier): sql tier rules`
  Recommended task executor category: `unspecified-high` - regex SQL + integrasi parser.

- [x] 4. Policy loader + config tier (block tidak bisa diturunkan)
  What to do / Must NOT do: Implementasi `src/core/policy.ts`: muat project `<workspace>/.guardian-angel/config.json` dan global `$XDG_CONFIG_HOME/guardian-angel/config.json` (fallback `~/.config/guardian-angel/config.json`), validasi schema `{rules:[{match:{tool?,command?,path?},tier,reason?}]}`; precedence builtin < global < project; dalam satu layer last-match-wins; project tidak bisa menurunkan tier `block` bawaan (boleh menaikkan), global boleh menurunkan; layer invalid diabaikan + audit warning, bukan crash. Match memakai wildcard `*` anchored, case-sensitive, bukan regex. JANGAN membaca `process.cwd()` di core; `workspace` selalu parameter.
  Closes: GAP-1, GAP-2
  Parallelization: Wave 2 | Blocked by: T1 | Blocks: T7, T11
  References: `docs/adr/0010-configurable-tiers.md`; `docs/pre-llm-and-config.md` (contoh config); `CONTEXT.md` (Tier, Verdict).
  Acceptance criteria (agent-executable): `bun test test/policy.test.ts` hijau: config proyek mencoba `block`→`allow` tetap `block`; config global boleh menurunkan; last-match-wins benar; config invalid diabaikan dengan warning.
  QA scenarios (name the exact tool + invocation): happy - `bun test test/policy.test.ts`; failure - project config `{tier:"allow"}` untuk rule block bawaan menghasilkan `block`; global config `{tier:"allow"}` menurunkan block. Evidence `.omo/evidence/task-4-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `feat(policy): configurable tiers with protected block`
  Recommended task executor category: `unspecified-low` - satu modul loader + precedence.

- [x] 5. Store layout, trash, restore, gc, list
  What to do / Must NOT do: Implementasi `src/core/store.ts` (path `.guardian-angel/{trash,approvals.json,audit.jsonl}`, auto-`.gitignore` idempotent: buat `<workspace>/.gitignore` bila belum ada, tambahkan baris `.guardian-angel/` sekali) dan `src/core/trash.ts`: `safeDelete(workspace, path)` → id `<timestamp>-<basename>-<hash8>`, pindahkan ke `trash/<id>/` dengan `meta.json` (`originalPath`, `deletedAt`, `kind`), return id; `restore(workspace, id)` menolak overwrite bila path asli sudah ada (error jelas, tidak menimpa), membuat parent dir, rename balik, hapus entry; `gc(workspace, now)` menghapus entry lebih tua dari 24 jam (`TRASH_TTL_MS` konstan) dan return jumlah; `listTrash(workspace)` urut terbaru. Enforcement: semua path harus di dalam workspace dan bukan workspace root (pakai `paths.ts`); tolak symlink fail-closed; rename EXDEV → error jelas, TANPA copy+delete fallback; JANGAN resolve symlink di v0.0.1.
  Closes: GAP-3
  Parallelization: Wave 2 | Blocked by: T1 | Blocks: T7, T8
  References: `docs/adr/0003-trash-di-volume-workspace.md`; `docs/adr/0006-rewrite-hybrid-rm.md`; `docs/adr/0007-test-di-sandbox.md`; `README.md` Store; `CONTEXT.md` Trash/Undo.
  Acceptance criteria (agent-executable): `bun test test/trash.test.ts` hijau di VM: file dummy di `mkdtemp` terpindah, restore mengembalikan isi identik, restore menolak overwrite, gc menghapus yang lebih tua dari 24 jam, path di luar workspace/root/symlink ditolak.
  QA scenarios (name the exact tool + invocation): happy - `bun test test/trash.test.ts`; failure - `safeDelete(ws, "/etc/hosts")` melempar; restore ke path yang sudah ada melempar; canary file di luar root tetap ada setelah test. Evidence `.omo/evidence/task-5-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `feat(trash): rename-based delete, restore, gc`
  Recommended task executor category: `deep-low` - containment + rename + restore punya banyak edge case.

- [x] 6. Approvals per-Scope + audit jsonl
  What to do / Must NOT do: Implementasi `src/core/approvals.ts`: Scope key = `${workspace}\0${sessionId}\0${scopePath}`; `scopePath` = path target ternormalisasi untuk `write`/`edit`, workspace root untuk `bash`/SQL. `approvals.json` schema `{version:1, entries:{"<key>":{grantedAt,expiresAt,reason?}}}`; TTL 24 jam; `grant`, `check`, `revoke`, `gc`; tulis atomik temp+rename; file korup → anggap kosong + audit warning (re-ask, bukan crash); asumsi single-process tanpa lock lintas proses. `src/core/audit.ts`: `appendAudit(workspace, entry)` menambah satu baris JSON ke `audit.jsonl` (`{ts,sessionId,tool,tier,reason,scopeKey?,command?}`), append-only; redaksi nilai setelah `password=`, `passwd=`, `token=`, `secret=`, `api_key=` dan flag `--password`. JANGAN menyimpan approval global lintas proyek.
  Closes: GAP-1
  Parallelization: Wave 2 | Blocked by: T1 | Blocks: T7
  References: `docs/adr/0010-configurable-tiers.md`; `README.md` Store; `CONTEXT.md` Scope/Approval; `docs/plan.md` Fase 3.
  Acceptance criteria (agent-executable): `bun test test/approvals.test.ts test/audit.test.ts` hijau: Scope sama tidak ditanya dua kali, TTL kedaluwarsa, audit bertambah 1 baris per keputusan, secret `password=...` teredaksi, approvals.json korup tidak crash.
  QA scenarios (name the exact tool + invocation): happy - test di VM; failure - approval kedaluwarsa memicu ask lagi; file `approvals.json` berisi `{` tidak membuat guard crash. Evidence `.omo/evidence/task-6-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `feat(approvals): per-scope approvals and audit log`
  Recommended task executor category: `unspecified-low` - dua modul kecil dengan file json.

- [x] 7. Orchestrator `guard()` dengan fail policy hybrid
  What to do / Must NOT do: Implementasi `src/core/guard.ts`: `guard(call, deps)` → `GuardResult`, dengan `deps: GuardDeps` persis dari T1. Alur: normalize → policy+classify → `block` (audit) → `ask` (hitung scopeKey; `approvals.check` true → allow; false → `deps.confirm(title, message)`; grant + audit; ditolak → block + audit) → `allow` (tanpa audit) / `replacement` (audit `rewrite`). Fail policy: exception classifier → bila command cocok pola destruktif known (`rm -rf /`, `rm -rf ~`, `mkfs`, `DROP`, `TRUNCATE`, `curl|sh`) → block + audit; selain itu allow + audit `classifier_error`. JANGAN menaruh logika ask/audit di adapter; jangan memanggil fs langsung dari guard selain lewat store/audit.
  Closes: GAP-1, GAP-2, GAP-4
  Parallelization: Wave 3 | Blocked by: T2-T6 | Blocks: T8, T9, T11
  References: `docs/adr/0004-fail-policy-hybrid.md`; `docs/adr/0005-threat-model.md`; `CONTEXT.md` (Verdict, Scope); draft `## Decisions` D1-D8; `src/core/types.ts` (T1).
  Acceptance criteria (agent-executable): `bun test test/guard.test.ts` hijau dengan fake `confirm` port: block tidak memanggil confirm; ask memanggil confirm sekali lalu grant; call kedua pada Scope sama tidak memanggil confirm; allow tidak menulis audit kecuali rewrite; classifier throw pada `rm -rf /` → block; throw pada `ls` → allow + audit.
  QA scenarios (name the exact tool + invocation): happy - `bun test test/guard.test.ts`; failure - `confirm` menolak → block + audit, tidak ada grant. Evidence `.omo/evidence/task-7-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `feat(core): guard orchestrator with hybrid fail policy`
  Recommended task executor category: `deep-high` - menyatukan 5 modul dengan kontrak keputusan yang tidak boleh salah.

- [x] 8. CLI `ga` (restore, list, gc, status)
  What to do / Must NOT do: Implementasi `src/cli/ga.ts` (shebang `#!/usr/bin/env bun`) + `package.json` `bin: {"ga":"./src/cli/ga.ts"}`, script `"ga": "bun run src/cli/ga.ts"`: `ga trash <path>`, `ga restore --last`, `ga restore <id>`, `ga list`, `ga gc`, `ga status`. Resolusi workspace: flag `--workspace <path>` > env `GA_WORKSPACE` > `process.cwd()` (hanya CLI yang boleh memakai cwd). `ga trash` mencetak id; `ga status` mencetak workspace, jumlah trash, jumlah approval, path audit, TTL. Output manusiawi; exit 0 sukses, 1 user error. JANGAN menambah subcommand di luar daftar; jangan menaruh logika keputusan di CLI.
  Closes: GAP-3
  Parallelization: Wave 4 | Blocked by: T5, T6 | Blocks: T12
  References: `README.md` (Undo, Store); `docs/plan.md` Fase 2; `CONTEXT.md` Trash/Undo; `src/core/trash.ts` (T5); `src/core/approvals.ts` (T6).
  Acceptance criteria (agent-executable): di VM, `bun run ga trash <dummy>` memindahkan file dan mencetak id; `bun run ga list` menampilkan item; `bun run ga restore --last` mengembalikan file; `bun run ga gc` keluar 0; `bun run ga status` mencetak 4 field.
  QA scenarios (name the exact tool + invocation): happy - `scripts/test-cli-in-vm.sh` (dibuat di todo ini; menyalin repo ke VM lalu menjalankan urutan trash/list/restore/status); failure - `ga restore id-tidak-ada` exit 1 dengan pesan; `ga restore` saat path asli ada exit 1 tanpa overwrite. Evidence `.omo/evidence/task-8-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `feat(cli): ga restore/list/gc/status`
  Recommended task executor category: `quick` - CLI tipis di atas core yang sudah ada.

- [x] 9. Adapter Senpi `pi.on("tool_call")`
  What to do / Must NOT do: Implementasi `src/adapters/senpi.ts` default export `(pi: ExtensionAPI) => { pi.on("tool_call", handler) }`; import `type { ExtensionAPI, ToolCallEvent, ToolCallEventResult }` dari `@code-yeongyu/senpi` (devDependency, erased at runtime). Handler: `sessionId = ctx.sessionManager.getSessionId()`, `workspace = ctx.cwd`; normalisasi `{toolName,input}` → `guard(call, deps)`; `block` → `{block:true, reason}`; `ask` → port confirm `(title,message) => ctx.ui.confirm(title,message)` (jika `!ctx.hasUI` → block fail-closed); `replacement` → render `bun run <pkgRoot>/src/cli/ga.ts trash <shell-quoted path>` dan mutasi `event.input.command` in-place; `pkgRoot = path.resolve(import.meta.dir, "../..")`. JANGAN mengimpor core ke harness; jangan melakukan I/O sendiri di luar port; jangan mengubah input non-bash.
  Closes: GAP-2, GAP-3
  Parallelization: Wave 4 | Blocked by: T7 | Blocks: T12
  References: `~/.bun/install/global/node_modules/@code-yeongyu/senpi/docs/extensions.md:70-78` (contoh resmi); `dist/core/extensions/types.d.ts:354-368` (`ctx.cwd`, `hasUI`, `sessionManager`), `:120-130` (`ui.confirm`), `:1436-1489` (`ToolCallEvent`), `:1594-1603` (`ToolCallEventResult`); `dist/core/session-manager.d.ts:269,368-371` (`getSessionId`); `dist/core/tools/bash.d.ts:7-11`; `docs/adr/0006-rewrite-hybrid-rm.md`; `docs/adr/0008-test-runner-vm-lima.md` (smoke host di direktori sekali pakai).
  Acceptance criteria (agent-executable): `bunx tsc --noEmit` lulus; `bun test test/adapter.test.ts` dengan fake `pi`/`ctx` hijau untuk block/ask/rewrite/`hasUI=false`; smoke nyata di host macOS HANYA untuk jalur rewrite non-destruktif: `senpi -e ./src/adapters/senpi.ts -p "Use the bash tool to run: rm ./dummy.txt"` di workspace `mkdtemp` berisi `dummy.txt` → file pindah ke `.guardian-angel/trash/`; canary di luar workspace utuh. JANGAN pernah mengirim prompt `rm -rf /` atau perintah destruktif lain ke Senpi nyata di host; jalur block diuji eksklusif lewat fake `pi`/`ctx` di `test/adapter.test.ts` dan (bila diinginkan) smoke terpisah di dalam VM Lima.
  QA scenarios (name the exact tool + invocation): happy - `bun test test/adapter.test.ts` + smoke `senpi -e ... -p ...` di `mkdtemp`; failure - `hasUI=false` pada tier ask → `{block:true}`; canary utuh. Evidence `.omo/evidence/task-9-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `feat(adapter): senpi tool_call guard`
  Recommended task executor category: `unspecified-high` - adapter + pemetaan UI/rewrite.

- [x] 10. VM test harness, sandbox assertions, canary, read-only proof
  What to do / Must NOT do: Lengkapi `scripts/test-in-vm.sh` + `test/helpers/sandbox.ts` (`makeSandbox`, `assertInSandbox`, `makeCanary`). Script: copy repo ke `/tmp/ga`, `bun install`, `bunx tsc --noEmit`, cek mount read-only (`if touch /mnt/guardian-angel/.ga-write-probe 2>/dev/null; then echo "mount is writable"; exit 1; else echo "read-only mount: OK"; fi`), buat canary `/tmp/ga-canary`, jalankan `bun test`, verifikasi canary, cetak `canary: intact`. JANGAN menjalankan test di host (kecuali smoke adapter T9 di `mkdtemp`).
  Closes: GAP-5
  Parallelization: Wave 4 | Blocked by: T1 | Blocks: T11, T12
  References: `docs/adr/0007-test-di-sandbox.md`; `docs/adr/0008-test-runner-vm-lima.md`; `docs/sandbox-verification.md`; `vm/guardian.yaml`; `scripts/test-in-vm.sh`.
  Acceptance criteria (agent-executable): `scripts/test-in-vm.sh` keluar 0; output memuat `read-only mount: OK`, `canary: intact`, dan hasil `bunx tsc --noEmit`; `git status` repo host bersih setelah run.
  QA scenarios (name the exact tool + invocation): happy - jalankan `scripts/test-in-vm.sh`; failure - bila mount writable, script exit non-zero dengan pesan `mount is writable`; canary berubah → exit non-zero `canary: modified`. Evidence `.omo/evidence/task-10-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `test(vm): sandbox harness and read-only proof`
  Recommended task executor category: `unspecified-low` - shell + helper test.

- [x] 11. Redteam corpus awal
  What to do / Must NOT do: Buat `test/redteam.test.ts` + `test/fixtures/redteam.jsonl`: minimal 30 kasus (ANSI-C quoting, `$()`, pipe, eval, sudo, `find -delete`, base64, SQL via pipe, path traversal). Setiap kasus punya `command`, `expectedTier`, `note` (bila bypass disadari). JANGAN mengeksekusi perintah; hanya assert Verdict.
  Closes: GAP-2, GAP-4
  Parallelization: Wave 5 | Blocked by: T2-T10 | Blocks: T12
  References: `README.md` Keterbatasan; `docs/adr/0005-threat-model.md`; `docs/plan.md` Fase 6; `~/.cc-safety-net/logs/destructive-guard.jsonl` (kasus nyata).
  Acceptance criteria (agent-executable): `bun test test/redteam.test.ts` hijau; setiap bypass yang diketahui ditandai `note` dan tidak membuat test gagal.
  QA scenarios (name the exact tool + invocation): happy - `bun test test/redteam.test.ts`; failure - kasus baru tanpa ekspektasi membuat test gagal. Evidence `.omo/evidence/task-11-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `test(redteam): initial bypass corpus`
  Recommended task executor category: `unspecified-high` - menyusun corpus dan ekspektasi.

- [x] 12. Docs, versi 0.0.1, dan verifikasi akhir
  What to do / Must NOT do: Update `README.md` (cara pakai `ga trash/restore/list/gc/status`, load adapter, default tier allow, perilaku SQL, retensi 24 jam, config global, smoke host `mkdtemp`), `package.json` version `0.0.1`, `docs/plan.md` status POC, dan `.omo/evidence/` ringkasan. JANGAN mengklaim fitur di luar POC (MCP/OpenCode/LLM advisor, `-f` SQL, copy+delete EXDEV).
  Closes: GAP-1, GAP-5
  Parallelization: Wave 6 | Blocked by: T8-T11 | Blocks: -
  References: `README.md`; `docs/plan.md`; `CONTEXT.md`; `docs/sandbox-verification.md`.
  Acceptance criteria (agent-executable): `bun test` hijau di VM; `bunx tsc --noEmit` lulus; README memuat perintah `ga` yang benar-benar ada di `package.json`; README tidak menyebut fitur Must NOT.
  QA scenarios (name the exact tool + invocation): happy - `scripts/test-in-vm.sh` + cek README vs `package.json`; failure - perintah README tidak ada → test dokumen gagal. Evidence `.omo/evidence/task-12-guardian-angel-poc-v0-0-1.md`
  Commit: Y | `docs(poc): usage and v0.0.1 status`
  Recommended task executor category: `writing` - dokumentasi dan konsistensi.

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit - verifikasi setiap todo `- [ ] N.` dieksekusi, tidak ada scope creep (tidak ada MCP/OpenCode/LLM advisor), dan semua file yang diklaim ada benar-benar ada. Evidence `.omo/evidence/f1-guardian-angel-poc-v0-0-1.md`
- [x] F2. Code quality review - `bunx tsc --noEmit` strict, tidak ada `any` tanpa alasan, core tidak mengimpor harness (grep `@code-yeongyu/senpi` hanya di `src/adapters/`), tidak ada `process.cwd()` di core. Evidence `.omo/evidence/f2-guardian-angel-poc-v0-0-1.md`
- [x] F3. Real manual QA - di VM: `scripts/test-in-vm.sh` hijau; `touch /mnt/guardian-angel/.ga-write-probe` gagal; `ga list`/`restore --last` bekerja pada file dummy; canary utuh. Evidence `.omo/evidence/f3-guardian-angel-poc-v0-0-1.md`
- [x] F4. Ideal-state fidelity - cek 1:1 setiap IS-1..IS-6 terhadap perilaku nyata di VM; setiap kekurangan menjadi todo baru `- [ ] N.`, bukan catatan. Evidence `.omo/evidence/f4-guardian-angel-poc-v0-0-1.md`

## Commit strategy

- Commit per todo setelah acceptance + QA hijau, format Conventional Commits (`feat(scope): ...`, `test(scope): ...`, `docs(scope): ...`).
- Tidak ada commit untuk file evidence (`.omo/evidence/` di-ignore).
- Bila todo gagal di tengah, perbaiki lalu amend commit todo tersebut; jangan menumpuk commit perbaikan.
- Sebelum F1-F4, jalankan `git status --short` dan pastikan hanya file yang direncanakan berubah.

## Success criteria

| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | T5, T7, T8, T9 | `rm ./build` → file di trash; `ga restore --last` mengembalikan | `.omo/evidence/task-8-guardian-angel-poc-v0-0-1.md` |
| IS-2 | T2, T3, T7, T9 | `rm -rf /`, `DROP TABLE`, `curl \| bash` → block dengan reason | `.omo/evidence/task-2-guardian-angel-poc-v0-0-1.md`, `task-3` |
| IS-3 | T3, T6, T7, T9 | `DELETE`/`UPDATE` → ask sekali per Scope; call kedua tidak bertanya | `.omo/evidence/task-6-guardian-angel-poc-v0-0-1.md` |
| IS-4 | T4, T7 | config proyek `block→allow` tetap block; config global boleh | `.omo/evidence/task-4-guardian-angel-poc-v0-0-1.md` |
| IS-5 | T6, T7 | setiap block/ask menambah satu baris `audit.jsonl` | `.omo/evidence/task-6-guardian-angel-poc-v0-0-1.md` |
| IS-6 | T9, T10, F3 | `touch /mnt/guardian-angel/...` gagal; canary utuh; smoke host hanya menyentuh `mkdtemp`; `git status` host bersih | `.omo/evidence/task-9-guardian-angel-poc-v0-0-1.md`, `task-10`, `f3` |
