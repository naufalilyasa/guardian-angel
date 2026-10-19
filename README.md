# Guardian Angel — Guard Deterministik & Undo Berbasis Trash untuk Coding Agent

Guardian Angel adalah sistem pengawas (guard) deterministik sebelum tool call dieksekusi oleh coding agent, dilengkapi **mekanisme undo berbasis trash** sebagai jaring pengaman utama. 

Mendukung **OpenCode 1.19.3** dan **Senpi / OMO Native**.

> **Bukan sandbox OS, bukan security boundary.** Dirancang untuk mencegah kesalahan fatal agen (prompt injection oportunistik, halusinasi refactoring, penghapusan data, dan overwrite). Keputusan bersifat fail-closed untuk pola destruktif dan dilengkapi audit log terstruktur.

---

## Fitur Utama

- 🔄 **Undo & Restorasi Byte-Identik**: Perintah `rm` target tunggal di-rewrite secara otomatis menjadi `ga trash <path>` (O(1) rename tanpa duplikasi data). Dapat dipulihkan sewaktu-waktu dengan `ga restore --last` (terverifikasi integritas hash SHA-256).
- 🗄️ **Cakupan SQL Deterministik**: Menahan perintah SQL destruktif (`DROP`, `TRUNCATE`, `ALTER`) baik via CLI client (`psql`, `mysql`, `sqlite3`), flag multipayload (`-c`, `-e`), input redirection, maupun heredoc.
- 🛡️ **Pencegahan Overwrite Berkas Eksisting**: Mendeteksi penimpaan file yang sudah ada di disk melalui redirection (`>`, `>>`, `>|`, `2>`), `cat /dev/null >`, `tee`, `cp`, `mv`, `install`, `sed -i`, `truncate`, dan `dd of=`.
- 🔒 **Proteksi Imutabilitas Store**: Direktori internal `.guardian-angel/` (audit, approvals, trash) dan repositori `.git/` kebal terhadap manipulasi, penulisan, penghapusan, atau penimpaan langsung maupun lewat symlink dan compound `cd`.
- ⏱️ **Persetujuan Granular 24 Jam**: Approval di-scope ketat per `workspace \0 session \0 path \0 ruleId`. Menyetujui `git push` tidak akan pernah membuka izin untuk `sudo`, `chmod -R`, atau `docker prune`.
- 🕵️ **Redaksi Rahasia Otomatis**: Audit log (`audit.jsonl`) secara otomatis menyamarkan token sensitif (Bearer, API keys, password database `-p`, kredensial URL, dan secret keys).
- 🧩 **Anti-Evasion Parser**: Menangani wrapper shell bertingkat (`bash -c`, `eval`, `$(...)`, `<(...)`, `>(...)`, backticks, subshell majemuk), launcher flags (`env`, `nice`, `timeout`), bare shell variable indirection (`$CMD`, `${CMD}`), quote-splitting (`r'm'`, `d'd'`), serta compound directory traversal (`cd`, `pushd`).

---

## Arsitektur

```
           [ Coding Agent (OpenCode / Senpi) ]
                          │
                          ▼ (tool call: bash, write, edit, patch)
        ┌───────────────────────────────────┐
        │       Adapter Interception        │
        │  • OpenCode: tool.execute.before  │
        │  • Senpi:    pi.on("tool_call")   │
        └─────────────────┬─────────────────┘
                          │
                          ▼
        ┌───────────────────────────────────┐
        │        src/core/ (Pure ESM)       │
        │  • classifier.ts (Regex & Parser) │ ──► allow | ask | block
        │  • sql.ts        (SQL Statements) │ ──► rewrite:rm-trash
        │  • paths.ts      (Physical/Symlnk)│
        │  • protected.ts  (Store Defense)  │
        │  • policy.ts     (Layered Rules)  │
        └─────────┬─────────────────────────┘
                  │
        ┌─────────┴─────────────────────────┐
        ▼                                   ▼
 [ Ask: IPC / UI Dialog ]         [ Rewrite / Block / Allow ]
  • OpenCode: ui.DialogConfirm     • ga trash (Undoable)
  • Senpi:    ctx.ui.confirm       • Throw error (Blocked)
  • 24h Approval Memory            • Audit log (audit.jsonl)
```

> **Aturan Emas**: Modul `src/core/` adalah modul murni (pure deterministic) tanpa dependensi runtime harness.

---

## Klasifikasi Tier

| Tier | Contoh Perintah | Perilaku Guard |
|------|-----------------|----------------|
| **allow** | `ls`, `git status`, kompilasi build, baca berkas, penulisan berkas baru | Langsung dieksekusi |
| **ask** | Menimpa file eksisting (`>`), `git push`, `sudo`, `DELETE`/`UPDATE` SQL, tulis keluar workspace | Menampilkan dialog konfirmasi interaktif; diingat 24 jam per-rule |
| **block** | `rm -rf /`, `rm -rf ~`, `mkfs`, `curl \| bash`, `DROP`/`TRUNCATE` SQL, manipulasi `.guardian-angel/**` atau `.git/**` | Ditolak seketika, fail-closed, tidak dapat di-override oleh project |

---

## Integrasi OpenCode (v1.19.3)

Guardian Angel menyediakan integrasi modular untuk OpenCode:

1. **Server Plugin** (`src/adapters/opencode/server.ts`):
   - Mencegat eksekusi melalui hook `tool.execute.before`.
   - Memetakan tool OpenCode (`bash`, `write`, `edit`, `patch`).
   - Mengalihkan perintah `rm` menjadi perintah `ga trash`.
   - Mengirim permintaan konfirmasi `ask` ke TUI bridge atau fail-closed di mode headless.
   - Dilengkapi cache penolakan 30 detik untuk mencegah popup berulang saat agen me-retry perintah.

2. **TUI Plugin** (`src/adapters/opencode/tui.ts`):
   - Menampilkan modal native `ui.DialogConfirm` di antarmuka TUI OpenCode.
   - Mengirim sinyal heartbeat aktif setiap 2 detik.

3. **File-IPC Bridge** (`src/adapters/opencode/ipc.ts`):
   - Komunikasi antar-proses aman di `/tmp/guardian-angel-ipc-<user>` (mode `0o700`).
   - Dilengkapi cryptographic nonce acak dan izin berkas ketat (`0o600`).

### Pemasangan di OpenCode

Tambahkan plugin server di project `.opencode/plugin/guardian.js` atau `opencode.json`:
```js
import { GuardianAngelServer } from "guardian-angel-poc/opencode-server";
export default GuardianAngelServer;
export { GuardianAngelServer };
```

Daftarkan TUI plugin di `tui.json`:
```json
{
  "plugin": [
    "guardian-angel-poc/opencode-tui"
  ]
}
```

---

## Integrasi Senpi / OMO Native

Daftarkan adapter di ekstensi Senpi:
```bash
# Menjalankan langsung dengan Senpi
senpi -e ./src/adapters/senpi.ts

# Atau letakkan di direktori auto-discovery
~/.senpi/agent/extensions/
```

Adapter memetakan:
- `block` → `{ block: true, reason }`
- `ask` → `ctx.ui.confirm` (fail-closed jika `hasUI === false`)
- `rewrite` → mutasi `event.input.command` in-place ke `bun run <pkg>/src/cli/ga.ts trash <path>`.

---

## CLI `ga` (Trash & Undo Management)

Guardian Angel menyediakan antarmuka CLI mandiri:

```bash
bun run ga trash <path>     # Memindahkan file/folder ke trash dan mencetak ID
bun run ga restore --last   # Memulihkan item terbaru yang dihapus
bun run ga restore <id>     # Memulihkan item spesifik berdasarkan ID
bun run ga list             # Menampilkan daftar berkas di dalam trash
bun run ga gc               # Membersihkan item yang lebih tua dari 24 jam
bun run ga status           # Menampilkan ringkasan audit log dan isi store
```

---

## Struktur Direktori Store

Setiap workspace yang dilindungi memiliki direktori lokal:

```
<workspace>/.guardian-angel/
├── trash/
│   └── <id>/
│       ├── payload          # Berkas/direktori asli yang dipindahkan
│       └── meta.json        # Path asal, timestamp penghapusan, SHA-256
├── approvals.json           # Cache persetujuan user per-rule (TTL 24 jam)
├── audit.jsonl              # Catatan lengkap setiap keputusan (block/ask/rewrite)
└── config.json              # Konfigurasi custom policy per-proyek (opsional)
```
*(Direktori ini otomatis ditambahkan ke `.gitignore`)*

---

## Pengujian & Verifikasi

### 1. Unit & Integration Test Suite
```bash
bun test
```
*437 test passing / 0 fail / 967 expect calls / 15 test files.*

### 2. Destructive 20-Case Smoke Suite
Menguji 20 skenario destruktif nyata (quoted path `rm`, overwrite `>`, SQL multi-payload DROP, wrappers, path traversal, git clean):
```bash
bun test test/smoke-20-cases.test.ts
```

### 3. Live Smoke Test OpenCode
Menjalankan agen OpenCode nyata di dalam disposable sandbox dengan canary file:
```bash
bun run test:smoke
# atau
bun run scripts/test-opencode-smoke.ts
```

### 4. Live Redteam & Comprehensive Pentest
Menjalankan adversarial probe otomatis terhadap LLM (misal `deepseek-v4.1-flash`) untuk mendeteksi potensi bypass:
```bash
bun run scripts/run-redteam-live.ts
bun run scripts/run-comprehensive-pentest.ts
```

### 5. Isolasi VM Linux (Lima)
Verifikasi lingkungan ext4 mount read-only terisolasi:
```bash
./scripts/test-in-vm.sh
```

---

## Batasan POC (Known Residuals)

Sesuai prinsip transparansi keamanan, batas kemampuan guard didokumentasikan secara terbuka di `test/fixtures/redteam.jsonl`:
- **Bukan Sandbox OS**: Eksekusi runtime interpreter tingkat tinggi (`python3 -c "import os; os.remove(...)"`, `node -e "..."`) mengeksekusi payload di level runtime interpreter dan memerlukan isolasi container/OS user terpisah.
- **Base64 Pipe ke Shell**: Perintah seperti `echo <base64> | base64 -d | sh` mengevaluasi string di runtime shell.
- **SSH Remoting**: Perintah yang dieksekusi di remote host lewat `ssh user@host "rm -rf /"` berada di luar jangkauan hook lokal.
- **Volume Tunggal Trash**: Mekanisme `ga trash` menggunakan `fs.renameSync` atomic O(1); jika target berada di filesystem/mount device berbeda (`EXDEV`), operasi ditolak secara fail-closed tanpa fallback copy+delete.

---

## Lisensi

MIT
