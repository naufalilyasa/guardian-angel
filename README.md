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
| block  | `rm -rf /`, `mkfs`, `curl \| bash`, `DROP`/`TRUNCATE`/`ALTER`, tulis ke `.guardian-angel/**` atau `.git/**` | ditolak, tidak bisa override |

Default untuk perintah bash yang tidak cocok aturan apa pun adalah **allow** — guard ini menargetkan kesalahan, bukan menggantikan permission system.

**Scope approval** = `workspace \0 session \0 path \0 rule`. Satu approval hanya berlaku untuk rule yang menghasilkannya: menyetujui `git push` tidak ikut menyetujui `sudo`, `chmod -R`, atau `docker prune`. Sebelumnya scope hanya `workspace \0 session \0 path`, sehingga satu approval membuka semua perintah `ask`.

**Store tidak bisa diubah agen.** `.guardian-angel/` (audit, approvals, trash) dan `.git/` ditolak untuk `write`, `edit`, redirection (`>`/`>>`), verb penulis (`tee`, `cp`, `mv`, `truncate`, `ln`, `sed -i`, …), `rm`, dan `ga trash`. Membaca store tetap `allow`.

**Residual:** lapisan ini adalah pertahanan berlapis, bukan isolasi. Bila agen mengeksekusi interpreter yang belum tertangkap classifier (`python3 -c`, base64 — lihat `KNOWN BYPASS` di corpus redteam) ia masih bisa menulis `approvals.json` secara langsung. Karena secret apa pun yang bisa dibaca agen juga bisa dipalsukan, penulisan store yang sebenarnya harus dicegah di level OS (user terpisah, mount read-only, atau sandbox), bukan di dalam proses yang sama.

**Wrapper di-unwrap.** `bash -c "…"`, `sh -c`, `zsh -c`, `eval "…"`, `$(…)` dan backtick ditembus sampai 5 level, lalu isinya diklasifikasi ulang. Launcher (`nice`, `timeout`, `nohup`, `env`, `command`, …) transparan terhadap aturan `rm`. `xargs rm` dan `find -exec rm` selalu `block` karena daftar targetnya tidak dapat diperiksa.

## Undo (hybrid)

- `rm` target tunggal yang terparse bersih **dan merupakan seluruh command** → di-rewrite menjadi `ga trash <path>` (O(1), tanpa copy data).
- `rm` yang dirangkai (`rm x && npm test`, `cd sub && rm x`, pipe, redirection) → block. Rewrite hanya mengganti string command, jadi merangkai akan menghilangkan perintah lain atau me-resolve path relatif ke direktori yang salah.
- `rm` kompleks (glob, substitusi, multi-target) → block + panduan `ga trash <path>` per target.
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

- Bukan parser shell POSIX penuh. Masih `KNOWN BYPASS` (tercatat di `test/fixtures/redteam.jsonl`): ANSI-C quoting, base64 yang di-decode lalu di-pipe, interpreter payload (`python3 -c`), dan `ssh`. `bash -c`, `eval`, `$(…)`, `<(...)`, `>(...)`, `xargs`, `find -exec`, path absolut (`/bin/rm`), subshell `(...)`, env-assignment prefixes, bare `&` chaining, quote-split command words (`r'm'`, `d'd'`), pelacakan compound `cd`, ekspansi tilde (`~`), dan eksekusi command via variabel (`$CMD`, `${CMD}`) sudah ditangani.
- `write`/`edit` memakai resolusi fisik: symlink di komponen path yang sudah ada diikuti, dan target yang keluar workspace menjadi `ask` (bukan `allow`). `rm`/`ga trash` menolak symlink secara fail-closed. Symlink tetap bukan sandbox.
- Deteksi SQL berbasis pola; **semua** payload (`-e`/`-c`/`--execute`, berulang) diklasifikasi dan diambil yang terberat, tapi `-f/--file` dan redirect file selalu `ask` karena classifier murni tidak membaca file. Bukan pengganti DB guard.
- Trash harus satu volume dengan workspace (EXDEV → error jelas, tanpa fallback copy+delete).
- MCP interception, adapter Codex/Claude, LLM advisor, CoW snapshot, dan Windows belum ada.
- Asumsi single-process: `approvals.json` tidak memakai lock lintas proses.

## Adapter OpenCode v1

Guardian Angel menyediakan integrasi untuk **OpenCode 1.19.3**:

- **Server Plugin** (`src/adapters/opencode/server.ts`): Memakai hook `tool.execute.before` untuk menghentikan perintah destruktif sebelum dieksekusi, merestrukturisasi perintah `rm` menjadi `ga trash`, serta meneruskan perintah `ask` ke TUI bridge.
- **TUI Plugin** (`src/adapters/opencode/tui.ts`): Menampilkan dialog konfirmasi native `ui.DialogConfirm` di antarmuka TUI OpenCode dan mencatat persetujuan 24 jam per-rule.
- **File-IPC Bridge** (`src/adapters/opencode/ipc.ts`): Pertukaran request/response antar-proses dengan timeout fail-closed dan heartbeat deteksi status TUI.
- **Verifikasi Smoke Test**:
  - `bun test test/smoke-20-cases.test.ts` — 20 kasus destruktif (quoted path `rm`, overwrite `>`, SQL DROP, wrappers, chained, path tampering).
  - `bun run test:smoke` (`scripts/test-opencode-smoke.ts`) — Uji end-to-end langsung dengan CLI OpenCode dan agen aktif di sandbox disposable dengan verifikasi integritas canary.

### Pemasangan di OpenCode

1. **Server Plugin**: Daftarkan di `.opencode/plugin/guardian.js` atau `opencode.json`:
   ```js
   import { GuardianAngelServer } from "guardian-angel-poc/opencode-server";
   export default GuardianAngelServer;
   ```
2. **TUI Plugin**: Daftarkan di `tui.json`:
   ```json
   {
     "plugin": ["guardian-angel-poc/opencode-tui"]
   }
   ```

## Peta jalan

1. ✅ Core (classifier + SQL + policy + trash + approvals + audit + guard) + adapter Senpi + CLI + redteam corpus
2. ✅ Adapter OpenCode v1 (Server Plugin + TUI Plugin DialogConfirm + File-IPC Bridge + 20-case smoke test)
3. Adapter harness lain (Codex, Claude Code)
