---
slug: guardian-angel-poc-v0-0-1
status: reviewed-approved
intent: clear
review_required: true
plan_path: .omo/plans/guardian-angel-poc-v0-0-1.md
plan_sha256: 967ce7a974f74c38c812a4a0f0461a09ea1d5b74431cc4e5070c0c6f04d7bc2a
review_round_id: round-3
review_round_limit: 5
round_status: approved
pending-action: none - plan approved and ready for /ulw-execute
review:
  plan_reviewer:
    status: approved
    workspace_root: /Users/ctp-itdev2/Documents/my-project/guardian-angel
    runtime_home: null
    target: .omo/plans/guardian-angel-poc-v0-0-1.md
    round_id: round-3
    plan_sha256: 967ce7a974f74c38c812a4a0f0461a09ea1d5b74431cc4e5070c0c6f04d7bc2a
    launch_id: launch-3
    session: st_01a149b5
    result: OKAY - approved with 3 non-blocking notes
approach: POC v0.0.1 berisi core deterministik (classifier + trash + approvals + audit) dan satu adapter Senpi yang di-load via `-e`, dengan test suite di VM Lima. Tanpa MCP, tanpa OpenCode, tanpa LLM advisor. Semua keputusan arsitektur mengikuti ADR 0001-0012 yang sudah disetujui.
---

# Draft: guardian-angel-poc-v0-0-1

## Affected user and ideal state

**Affected user:** pemilik mesin ini yang menjalankan agent Senpi/OMO untuk pekerjaan nyata (proyek Laravel, dashboard, dsb.) dan tidak mau kehilangan file karena salah `rm` atau SQL destruktif.

| id | property of the ideal state | reason |
|---|---|---|
| IS-1 | `rm` target tunggal yang bersih otomatis masuk trash dan bisa dipulihkan dengan satu perintah | undo > permission; ini diferensiasi utama |
| IS-2 | Perintah destruktif kompleks (`rm -rf /`, `DROP TABLE`, `curl \| bash`) ditolak dengan alasan jelas | mencegah kerusakan yang tidak bisa di-undo |
| IS-3 | `DELETE`/`UPDATE` SQL meminta persetujuan sekali per Scope, bukan tiap call | alur kerja tidak terganggu, tetap aman |
| IS-4 | User bisa menyesuaikan aturan tier lewat config tanpa bisa melonggarkan block bawaan | false positive pasti terjadi; config proyek tidak boleh jadi celah |
| IS-5 | Setiap keputusan block/ask tercatat di audit.jsonl per proyek | investigasi insiden dan tuning aturan |
| IS-6 | Tidak ada test yang menyentuh file nyata di laptop | kepercayaan untuk menjalankan test destructive |

**Gap rows (hari ini):**

| id | gap | reason | closed by |
|---|---|---|---|
| GAP-1 | Belum ada kode sama sekali; README hanya spec | repo greenfield | T1-T9 |
| GAP-2 | Tidak ada guard terpasang di Senpi/OMO | cc-safety-net hanya OpenCode | T7 |
| GAP-3 | Belum ada undo untuk `rm` di harness mana pun | checkpoint Claude tidak melacak bash | T4-T5 |
| GAP-4 | Aturan SQL masih pola teks di plugin lama, tidak teruji | destructive-guard.js bash-only | T3, T9 |
| GAP-5 | Test destructive belum punya isolasi VM | ADR 0008 baru di atas kertas | T0, T8 |

## Components (topology ledger)

| id | outcome | status | evidence |
|---|---|---|---|
| C1 | Core classifier deterministik (allow/ask/block) | active | README, ADR 0005 |
| C2 | Trash + restore + gc (rename satu volume) | active | ADR 0003, 0006 |
| C3 | Approvals per-proyek + audit jsonl | active | ADR 0010, README store |
| C4 | Adapter Senpi `pi.on("tool_call")` | active | docs/extensions.md:63-78 |
| C5 | VM test runner (Lima) | active | ADR 0008, vm/guardian.yaml |
| C6 | Redteam corpus | active | README, plan Fase 5 |
| C7 | MCP interception | deferred | ADR 0011 |
| C8 | OpenCode v1 adapter | deferred | ADR 0012 |

## Findings (cited)

- F1: `pi.on("tool_call", handler)` menerima `{toolName, input, toolCallId, parentToolCallId?}` dan mengembalikan `{block:true, reason}`; `event.input` mutable tanpa re-validasi. `dist/core/extensions/types.d.ts:1453-1573`.
- F2: `ctx.ui.confirm(title,message,opts)` tersedia; `ExtensionContext.cwd` memberi workspace root. `types.d.ts:354-366`, `:121-126`.
- F3: Bash input punya `command: string` (`dist/core/tools/bash.d.ts:65`).
- F4: Package `@code-yeongyu/senpi` v2026.10.16 mengekspor tipe dari `dist/index.d.ts`; adapter bisa di-load via `-e ./src/adapters/senpi.ts` (docs/extensions.md quick start).
- F5: `bun test` tersedia di host (probe 1 pass) dan akan dipasang di VM.
- F6: `vm/guardian.yaml` memakai `virtiofs` + `writable:false`; test hanya di `/tmp` VM (ADR 0008).
- F7: `cc-safety-net` dan `destructive-guard.js` adalah prior art yang tidak menutupi undo/ask per-scope.

## Decisions (settled)

- D1: Senpi-only fase 1 (ADR 0002).
- D2: Trash store di `<workspace>/.guardian-angel/` (ADR 0003).
- D3: Fail policy hybrid (ADR 0004).
- D4: Threat model mistakes + opportunistic injection (ADR 0005).
- D5: Rewrite hybrid rm (ADR 0006).
- D6: Test di VM Lima (ADR 0008).
- D7: Config tier, block tidak bisa diturunkan config proyek (ADR 0010).
- D8: POC v0.0.1 = core + adapter Senpi + redteam, tanpa MCP/OpenCode (scope user).

## Scope IN

- Core classifier: bash + file path + SQL; tier allow/ask/block; path containment.
- Trash: safeDelete/restore/gc/list; rewrite hybrid `rm`.
- Approvals per-proyek dengan TTL; audit jsonl.
- Adapter Senpi: `tool_call` → block/ask/rewrite.
- Config `.guardian-angel/config.json`.
- VM Lima test runner + sandbox assertions + canary.
- Redteam corpus awal.

## Scope OUT (Must NOT have)

- MCP interception, OpenCode adapter, Codex/Claude adapter.
- LLM advisor, CoW snapshot, Windows.
- UI TUI custom, dashboard, telemetry.
- Symlink resolution, full POSIX parser.
- Auto-publish npm.

## Open questions

- Q-A: Permission model untuk `ask` saat mode non-interaktif (RPC/print) — default: block dengan alasan (fail-closed) karena `ctx.ui.confirm` tidak tersedia tanpa UI. (assumption, reversible)
- Q-B: Format nama file trash — default `<timestamp>-<basename>-<short-hash>` agar unik dan mudah dibaca. (assumption, reversible)
- Q-C: Retention default — 24 jam (README) vs 7 hari; default 24 jam sesuai README. (assumption, reversible)

## Open assumptions (announced defaults)

| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| Interface restore POC | CLI `ga` (`restore --last`, `--list`, `--gc`) | bisa dipakai tanpa Senpi | ya |
| Verifikasi isolasi | Lima VM sungguhan di POC | membuktikan, bukan mengklaim | ya |
| Strategi commit | commit per todo | rollback per langkah | ya |
| `ask` tanpa UI (RPC/print) | block + alasan (fail-closed) | confirm tidak tersedia | ya |
| Retention trash | 24 jam | sesuai README | ya |
| Nama file trash | `<timestamp>-<basename>-<short-hash>` | unik & terbaca | ya |
| Arsitektur | modular monolith, core-owned `guard()` | satu rumah ask/audit/fail policy | ya |

## Approval gate

status: approved (2026-10-17, user replied "approve")

Approach: core-owned `guard()` + adapter Senpi tipis + CLI `ga` + VM Lima.
Plan written; plan-consultant spawn blocked by harness gate (plan-gate not open in this session); plan-reviewer attempted and also blocked. Self-review performed instead:
- All 6 IS rows have delivering todos and QA scenarios (Success criteria table).
- All 5 GAP rows closed by at least one todo (GAP-1 T1/T2/T4/T6/T7/T12; GAP-2 T2/T7/T9/T11; GAP-3 T5/T8/T9; GAP-4 T3/T7/T11; GAP-5 T10/T12).
- Structural check: 8 template headers in order, 12 `- [ ] N.` rows column-zero, 4 `- [ ] F<n>.` rows, 12 executor-category lines, no leftover placeholders.
- Residual risk noted: `bun test` di VM belum pernah dijalankan; T10 adalah gate verifikasi isolasi pertama.

## Review convergence ledger

| round | plan_sha256 (prefix) | verdict | accepted blockers | notes |
| --- | --- | --- | --- | --- |
| round-2 | 50318338 | changes_requested | B1 T9 host smoke menjalankan `rm -rf /` di host (melanggar Must NOT/ADR 0008/IS-6); B2 Wave 5 paralel bertentangan dengan matrix T11→T12; B3 repo tanpa `.git`/`.gitignore` sehingga commit-per-todo dan `git status` bersih mustahil | ketiga blocker diperbaiki: smoke host hanya rewrite `rm ./dummy.txt` di `mkdtemp`, block diuji fake `pi`/`ctx`; Wave 5/6 serial; T1 menambahkan `git init` + `.gitignore` root |

| round-3 | 967ce7a9 | approved | — | 3 notes non-blocking (lihat di bawah) |

Non-blocking notes dari round-3 (TIDAK diubah ke plan; menjadi koreksi saat eksekusi):
- N1: T3 mengintegrasikan SQL ke `classifier.ts` sedangkan T2 (paralel) membuat file yang sama — executor menyerialkan T2→T3 bila terjadi konflik tulis, atau mengekstrak hook `classifySql` yang diimpor T2.
- N2: `ToolCall` di T1 hanya mendeklarasikan `bash|write|edit`; T2 juga menangani `read|grep|find|ls` sebagai allow — executor memperluas union saat implementasi T2.
- N3: frasa T9 "JANGAN mengimpor core ke harness" dibaca terbalik; maksudnya core tidak boleh mengimpor harness — executor mengikuti Aturan emas README.

Ledger freeze setelah round pertama: ronde berikutnya hanya memverifikasi blocker yang diterima, regresi akibat perbaikan, dan temuan baru yang lolos `blocker_eligibility`.
