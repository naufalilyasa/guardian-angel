# guardian-angel — guard + undo untuk Senpi/OMO Native

Guard deterministik sebelum tool call dieksekusi, dengan **undo berbasis trash** sebagai jaring pengaman utama. Fase 1 menargetkan Senpi/OMO Native; harness lain menyusul setelah core terbukti.

**Bukan sandbox, bukan security boundary.** Menargetkan kesalahan agent + prompt injection oportunistik. Saat classifier error: pola destruktif fail-closed, sisanya fail-open + log.

## Posisi

Guard bawaan Senpi (permission system) adalah confirmation policy per-call tanpa undo. `cc-safety-net` punya adapter pi yang block-only: tanpa undo, tanpa tier ask native, tanpa cakupan SQL.

guardian-angel mengisi ruang yang kosong:

- **Undo/trash** untuk aksi destruktif (checkpoint Claude Code pun tidak melacak file yang diubah lewat bash)
- **Cakupan SQL** (SELECT allow, DROP/TRUNCATE block, DELETE/UPDATE ask)
- **Approval per-Scope** (path + sesi), bukan per-call

Yang **bukan** target: menang di akurasi parsing shell. Obfuscation ditangani best-effort dan dicatat di corpus redteam.

## Arsitektur

```
Agent tool call (Senpi)
      │
      ▼
┌──────────────────┐
│ src/adapters/    │  pi.on("tool_call") — choke point tunggal (pre-execution)
│ senpi.ts         │  block keras · ask via ctx.ui.confirm · rewrite hybrid rm
└────────┬─────────┘
         ▼
┌──────────────────┐
│ src/core/        │  DETERMINISTIK (pure code, mikrodetik, tanpa LLM di jalur keputusan)
│ classifier.ts    │  → allow | ask (per Scope) | block (hard)
│ trash.ts         │  undo via trash (rename O(1), satu volume workspace)
│ approvals.ts     │  approval per-proyek + TTL
│ audit.ts         │  audit.jsonl
└──────────────────┘
```

Aturan emas: core tidak pernah import code harness.

## Tier

| Tier   | Contoh | Perilaku |
|--------|--------|----------|
| allow  | `ls`, `cat`, `git status`, tulis di workspace | langsung jalan |
| ask    | `DELETE`/`UPDATE` SQL, tulis di luar workspace, `git push` | approval per Scope, sekali saja |
| block  | `rm -rf /`, `mkfs`, `curl \| bash`, `DROP TABLE`, `TRUNCATE` | ditolak, tidak bisa override |

Catatan: `ask` dipetakan per-harness. Senpi punya `ctx.ui.confirm` native; harness lain nanti memakai primitif terkuat yang tersedia.

## Undo (hybrid)

- `rm` target tunggal yang terparse bersih → di-rewrite ke pemindahan Trash (O(1), tanpa copy data).
- `rm` kompleks (glob, substitusi, pipe) → block + perintah pengganti siap-tempel.
- `restore()` mengembalikan; `gc()` expire otomatis.

## Store

```
<workspace>/.guardian-angel/
  trash/          file terhapus (satu volume dengan workspace → bebas EXDEV)
  approvals.json  approval per-proyek (TTL, bisa dicabut manual)
  audit.jsonl     setiap Verdict block/ask
```

Direktori ini di-.gitignore otomatis.

## Struktur

```
src/
  core/
    types.ts       Tier, Verdict, Scope, PolicyConfig
    classifier.ts  tokenizer + resolver path + rules file/bash + ruleset SQL
    trash.ts       safeDelete / restore / gc / listTrash
    approvals.ts   Scope + TTL
    audit.ts       jsonl writer
  adapters/
    senpi.ts       extension pi.on("tool_call") — block / ask / rewrite hybrid
  index.ts         public exports
test/
  classifier.test.ts  allow/ask/block + resolusi path
  sandbox.test.ts     guard + trash di sandbox sekali pakai (canary files)
  redteam.test.ts     bypass attempts: obfuscation, eval, pipe, sudo
```

## Test: di VM terpisah, bukan di laptop

Test berjalan di **VM Lima** (Ubuntu, ext4): repo di-mount **read-only** via virtiofs, salinan kerja hanya di `/tmp` VM yang menguap saat VM dimatikan. macOS tidak pernah menjalankan test destruktif.

```bash
scripts/test-in-vm.sh
```

Start pertama mengunduh image Ubuntu (~1GB) dan meng-install Bun di dalam VM; run berikutnya cepat.

Di dalam VM tetap berlaku sandbox sekali pakai: `mkdtemp` per test, `assertInSandbox(path)` fail-closed sebelum operasi destruktif, canary file, env `GA_*` di-override. Semua target `rm` di test adalah file dummy yang dibuat test itu sendiri, bukan file pengguna.

## Config tier

`.guardian-angel/config.json` — aturan `{ match, tier, reason }`, last-match-wins. User bisa menambah/menimpa aturan. Aturan `block` bawaan tidak bisa diturunkan lewat config proyek (hanya config global user).

## Pre-LLM interception (opsional)

Senpi: `context`, `context_with_system`, `before_provider_request`. OpenCode v1: `experimental.chat.system.transform`, `experimental.chat.messages.transform`. Temuan pre-LLM hanya menaikkan kewaspadaan + audit; keputusan destruktif tetap di choke point pre-tool-call.

## Keterbatasan yang disadari (jujur)

- Bukan parser shell POSIX penuh: ANSI-C quoting (`$'\x72\x6d'`), process substitution, dan arithmetic expansion belum di-handle → masuk corpus redteam, bukan dianggap aman.
- `resolvePath` leksikal saja; symlink belum di-resolve.
- Deteksi SQL berbasis pola dasar; bukan pengganti DB guard (tetap pakai transaksi + privilege DB).
- Trash harus satu volume dengan workspace (EXDEV); fallback copy+delete belum ada.
- MCP interception ditunda ke fase 2.

## Peta jalan

1. Core (classifier + trash + approvals + audit) + adapter Senpi + sandbox/redteam tests
2. Adapter OpenCode v1 (termasuk pemetaan ke permission config native) + pre-LLM interception opsional; v2 ditunda
3. Adapter harness lain (Codex, Claude Code)
