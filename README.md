# guardian-angel — guard + undo untuk Senpi/OMO Native

Guard deterministik sebelum tool call dieksekusi, dengan **undo berbasis trash** sebagai jaring pengaman utama. Fase 1 menargetkan Senpi/OMO Native.

**Bukan sandbox, bukan security boundary.** Menargetkan kesalahan agent + prompt injection oportunistik. Saat classifier error: pola destruktif fail-closed, sisanya fail-open + log.

**Status: POC v0.0.1** — core, adapter Senpi, CLI, dan test suite sudah berjalan. Lihat "Batas POC" di bawah untuk yang belum ada.

## Posisi

Guard bawaan Senpi (permission system) adalah confirmation policy per-call tanpa undo. `cc-safety-net` punya adapter pi yang block-only: tanpa undo, tanpa tier ask native, tanpa cakupan SQL.

guardian-angel mengisi ruang yang kosong:

- **Undo/trash** untuk aksi destruktif
- **Cakupan SQL** (SELECT allow, DROP/TRUNCATE/ALTER block, DELETE/UPDATE ask)
- **Approval per-Scope** (path + sesi), bukan per-call

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
│ src/core/        │  DETERMINISTIK (pure code, tanpa LLM di jalur keputusan)
│ classifier.ts    │  → allow | ask (per Scope) | block (hard)
│ sql.ts           │  ruleset SQL per-client
│ policy.ts        │  config tier + builtin block yang tidak bisa diturunkan
│ trash.ts         │  undo via trash (rename O(1), satu volume workspace)
│ approvals.ts     │  approval per-proyek + TTL 24 jam
│ audit.ts         │  audit.jsonl + redaksi secret
│ guard.ts         │  orkestrator: policy → classify → ask/block/rewrite → audit
└──────────────────┘
```

Aturan emas: **core tidak pernah import code harness**.

## Tier

| Tier   | Contoh | Perilaku |
|--------|--------|----------|
| allow  | `ls`, `cat`, `git status`, tulis di workspace, perintah tak dikenal | langsung jalan |
| ask    | `DELETE`/`UPDATE` SQL, tulis di luar workspace, `git push`, `sudo` | approval per Scope, sekali saja |
| block  | `rm -rf /`, `mkfs`, `curl \| bash`, `DROP`/`TRUNCATE`/`ALTER` | ditolak, tidak bisa override |

Default untuk perintah bash yang tidak cocok aturan apa pun adalah **allow** — guard ini menargetkan kesalahan, bukan menggantikan permission system.

## Undo (hybrid)

- `rm` target tunggal yang terparse bersih → di-rewrite menjadi `ga trash <path>` (O(1), tanpa copy data).
- `rm` kompleks (glob, substitusi, pipe, multi-target) → block + panduan `ga trash <path>` per target.
- `restore()` mengembalikan; `gc()` menghapus item lebih tua dari 24 jam.

## CLI `ga`

```bash
bun run ga trash <path>     # pindahkan ke trash, cetak id
bun run ga restore --last   # pulihkan item terbaru
bun run ga restore <id>     # pulihkan item tertentu
bun run ga list             # isi trash
bun run ga gc               # hapus item > 24 jam
bun run ga status           # ringkasan store
```

Workspace resolution: `--workspace <path>` > `$GA_WORKSPACE` > `cwd`.

## Store

```
<workspace>/.guardian-angel/
  trash/<id>/          payload + meta.json (rename, satu volume)
  approvals.json       approval per-proyek (TTL 24 jam)
  audit.jsonl          setiap keputusan block/ask/rewrite
```

Direktori ini di-.gitignore otomatis.

## Memasang adapter di Senpi

```bash
# dev / coba cepat
senpi -e ./src/adapters/senpi.ts

# pemakaian harian: salin atau symlink ke direktori auto-discovery
~/.senpi/agent/extensions/
```

Adapter memetakan:

- `block` → `{ block: true, reason }`
- `ask` → `ctx.ui.confirm`; tanpa UI (`hasUI=false`) → block (fail-closed)
- `replacement` → `event.input.command` dimutasi menjadi `bun run <pkg>/src/cli/ga.ts trash <path>`

## Config tier

`.guardian-angel/config.json`:

```json
{
  "rules": [
    { "match": { "tool": "bash", "command": "git push*" }, "tier": "ask", "reason": "remote write" }
  ]
}
```

- Precedence: builtin < global (`$XDG_CONFIG_HOME/guardian-angel/config.json`) < project.
- Dalam satu layer, **last match wins**; pola `*` di-anchor.
- **Project tidak bisa menurunkan `block` bawaan** — hanya config global user yang boleh.
- Config invalid diabaikan + warning, tidak membuat guard crash.

## Test: di VM terpisah, bukan di laptop

```bash
scripts/test-in-vm.sh
```

Script ini:

1. memastikan VM Lima hidup,
2. memverifikasi mount repo **read-only** (`touch` harus gagal),
3. menyalin repo ke `/tmp/ga` di dalam VM,
4. menjalankan `tsc --noEmit` dan `bun test`,
5. memverifikasi canary `/tmp/ga-canary` tidak tersentuh.

macOS tidak pernah menjalankan test destruktif. Satu-satunya eksekusi di host adalah smoke adapter non-destruktif (`rm ./dummy.txt` di `mkdtemp`).

## Batas POC (jujur)

- Bukan parser shell POSIX penuh. ANSI-C quoting, base64/eval, interpreter payload (`python3 -c`), `xargs`, `ssh`, dan path absolut (`/bin/rm`) **belum** tertangkap — semuanya tercatat sebagai `KNOWN BYPASS` di `test/fixtures/redteam.jsonl`.
- `resolvePath` leksikal; symlink di **komponen path** ditolak fail-closed, tetapi symlink bukan sandbox.
- Deteksi SQL berbasis pola; `-f/--file` dan redirect file selalu `ask` karena classifier murni tidak membaca file. Bukan pengganti DB guard.
- Trash harus satu volume dengan workspace (EXDEV → error jelas, tanpa fallback copy+delete).
- MCP interception, adapter OpenCode/Codex/Claude, LLM advisor, CoW snapshot, dan Windows belum ada.
- Asumsi single-process: `approvals.json` tidak memakai lock lintas proses.

## Peta jalan

1. ✅ Core (classifier + SQL + policy + trash + approvals + audit + guard) + adapter Senpi + CLI + redteam corpus
2. Adapter OpenCode v1 + pre-LLM interception opsional
3. Adapter harness lain (Codex, Claude Code)
