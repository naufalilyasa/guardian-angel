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
- 💬 **Dialog Konfirmasi Bergaya Native OpenCode**: Render inline langsung di atas prompt chip tanpa modal overlay, menggunakan OpenTUI Solid (`┃` border, tanpa input search box). Dilengkapi navigasi panah `↑`/`↓`/`j`/`k`, shortcut angka `1. Deny` / `2. Allow`, `Enter` untuk konfirmasi, dan `Esc` untuk tolak (fail-closed).
- ⏸️ **Jeda Eksekusi Indefinite & Notifikasi Desktop**: Agen berhenti total saat menunggu persetujuan (tidak timeout prematur) disertai notifikasi desktop OS (macOS/Linux) dan chime audio TUI.
- 🕵️ **Redaksi Rahasia & Pencatatan Rule ID**: Audit log (`audit.jsonl`) mencatat field `ruleId` eksplisit pada setiap keputusan dan menyamarkan token sensitif (Bearer, API keys, password database `-p`, kredensial URL, dan secret keys).
- 🧩 **Anti-Evasion Parser**: Menangani wrapper shell bertingkat (`bash -c`, `eval`, `$(...)`, `<(...)`, `>(...)`, backticks, subshell majemuk), launcher flags (`env`, `nice`, `timeout`), bare shell variable indirection (`$CMD`, `${CMD}`), quote-splitting (`r'm'`, `d'd'`), ANSI-C quoting (`$'\x72\x6d'`, `$'\162\155'`, `$'\u0072'`), serta compound directory traversal (`cd`, `pushd`, `env -C`).
- 🤖 **LLM Security Advisor (Advisory-Only)**: Saat perintah masuk ke tier `ask`, LLM advisor memberi *second opinion* berbasis konten — badge risiko (`🟢 Safe` / `🟡 Caution` / `🔴 Dangerous`), ringkasan dampak, dan status reversibilitas — yang ditampilkan non-blocking di dalam dialog konfirmasi. Advisor membaca isi file yang sedang ditulis (bukan hanya path), tidak pernah memiliki tools, dan **tidak pernah** mengeksekusi atau auto-approve apapun. Dilengkapi pertahanan anti prompt-injection 4-lapis.

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
         │  • script-gate.ts (Script Audit)  │ ──► rewrite:rm-trash
         │  • sql.ts        (SQL Statements) │
         │  • paths.ts      (Physical/Symlnk)│
         │  • protected.ts  (Store Defense)  │
         │  • policy.ts     (Layered Rules)  │
         │  • advisor.ts    (LLM Prompts)    │
         └─────────┬─────────────────────────┘
                   │
          ┌─────────┴─────────────────────────┐
          ▼                                   ▼
   [ Ask: IPC / UI Dialog ]         [ Rewrite / Block / Allow ]
    • OpenCode: Inline Question UI    • ga trash (Undoable)
      (OpenTUI Solid above prompt)    • Throw error (Blocked)
    • Senpi:    ctx.ui.confirm        • Audit log (audit.jsonl + ruleId)
    • LLM Advisor card (non-blocking) • Indefinite pause & OS notification
    • 24h Approval Memory
```

> **Aturan Emas**: Modul `src/core/` adalah modul murni (pure deterministic) tanpa dependensi runtime harness.

---

## Klasifikasi Tier

| Tier | Contoh Perintah | Perilaku Guard |
|------|-----------------|----------------|
| **allow** | `ls`, `git status`, kompilasi build, baca berkas, penulisan berkas baru | Langsung dieksekusi |
| **ask** | Menimpa file eksisting (`>`), `git push`, `sudo`, `DELETE`/`UPDATE` SQL, tulis keluar workspace, interpreter inline (`python3 -c`), pipe ke shell, script tak terbaca | Menampilkan dialog konfirmasi interaktif + kartu LLM advisor; diingat 24 jam per-rule |
| **block** | `rm -rf /`, `rm -rf ~`, `mkfs`, `curl \| bash`, `DROP`/`TRUNCATE` SQL, manipulasi `.guardian-angel/**` atau `.git/**` | Ditolak seketika, fail-closed, tidak dapat di-override oleh project |

---

## Integrasi OpenCode (v1.19.3)

Guardian Angel menyediakan integrasi modular untuk OpenCode:

1. **Server Plugin** (`src/adapters/opencode/server.ts`):
   - Mencegat eksekusi melalui hook `tool.execute.before`.
   - Memetakan tool OpenCode (`bash`, `write`, `edit`, `patch`).
   - Mengalihkan perintah `rm` menjadi perintah `ga trash`.
   - Mengirim permintaan konfirmasi `ask` ke TUI bridge dengan timeout indefinite (agen berhenti total sampai diputuskan), atau fail-closed seketika di mode headless.
   - Dilengkapi cache penolakan 30 detik untuk mencegah popup berulang saat agen me-retry perintah.

2. **TUI Plugin** (`src/adapters/opencode/tui.ts` & `src/adapters/opencode/question-dialog.tsx`):
   - Merender dialog konfirmasi inline langsung di atas prompt chip (`session_prompt` slot) tanpa modal overlay.
   - Dibangun dengan OpenTUI Solid meniru tampilan native question OpenCode (`┃` border, header, command, reason, dan pilihan bernomor).
   - Tanpa input search box ("Type your own answer").
   - Navigasi keyboard terintegrasi mode `"question"` dan keymap layer OpenCode (`↑`/`↓`/`k`/`j` untuk memilih opsi, shortcut `1` / `2`, `Enter` untuk konfirmasi, dan `Esc` untuk tolak fail-closed).
   - Memancarkan notifikasi desktop (macOS Ping notification / Linux `notify-send`) dan chime audio TUI `question`.
   - Mengirim sinyal heartbeat aktif setiap 2 detik dan terisolasi per-workspace/sesi.

3. **File-IPC Bridge** (`src/adapters/opencode/ipc.ts`):
   - Komunikasi antar-proses aman di `/tmp/guardian-angel-ipc-<user>/<workspace-hash>` (mode `0o700`).
   - Dilengkapi cryptographic nonce acak dan izin berkas ketat (`0o600`).

### LLM Security Advisor (`src/core/advisor.ts` & `src/adapters/opencode/advisor-client.ts`)

Saat sebuah tool call masuk ke tier `ask`, Guardian Angel secara **non-blocking** memanggil LLM untuk memberi analisis risiko berbasis konten sebelum pengguna menekan `1. Deny` / `2. Allow`. Dialog dirender seketika (tanpa menunggu LLM), dan kartu advisor terisi ketika model selesai menjawab.

**Yang ditampilkan:**
- Badge risiko: `🟢 Safe` / `🟡 Caution` / `🔴 Dangerous`
- Ringkasan dampak satu-kalimat, status reversibilitas, dan daftar resource yang disentuh
- Tombol `r` untuk re-query jika provider error atau timeout

**Membaca isi, bukan cuma path:** untuk tool `write`/`edit`/`patch`, advisor menerima **konten yang sedang ditulis** (bukan file yang sudah ada di disk), sehingga payload destruktif di dalam file terlihat oleh model dan oleh pengguna di dialog.

**Pertahanan Anti Prompt-Injection 4 Lapis:**
1. **Data-Instruction Boundary** — perintah/file tak terpercaja dibungkus dalam tag `<untrusted_command>` / `<untrusted_file>` yang dideklarasikan inert; percobaan menutup tag dari dalam di-escape (`&lt;/untrusted_command&gt;`).
2. **Toolless Invocation** — LLM dipanggil dengan `tools: {}`; model tidak punya tools, filesystem, atau akses eksekusi apapun.
3. **Host-Controlled Ingestion** — host (bukan LLM) yang membaca file, menolak binary (NUL byte), dan membatasi ukuran 64 KB dengan label truncation.
4. **Strict Structured Output** —respons harus parse menjadi JSON valid (`risk_level`, `summary`, `is_reversible`, `affected_resources`); jika tidak, kartu menampilkan error, bukan verdict palsu.

**Penting: advisor adalah penasihat, bukan pengambil keputusan.** Advisor **tidak pernah** auto-allow atau mengubah verdict. Otoritas 100% tetap pada pengguna yang menekan `1. Deny` / `2. Allow`. Verdict advisor dicatat ke `audit.jsonl` pada field `advisor` untuk forensik.

**Konfigurasi model** (opsional, di `.guardian-angel/config.json`):
```json
{
  "llm_advisor": {
    "model": "9router/ag/gemini-3.8-flash-high"
  }
}
```
Precedence: argumen eksplisit > config project > config global (`$XDG_CONFIG_HOME/guardian-angel/config.json`) > default.

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

Specifier `guardian-angel-poc/opencode-server` dan `guardian-angel-poc/opencode-tui` juga tersedia dalam bentuk singkat: `guardian-angel-poc`, `guardian-angel-poc/server`, dan `guardian-angel-poc/tui` (semuanya menunjuk ke modul yang sama).

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
*653 test passing / 0 fail / 1486 expect calls / 24 test files.*

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
- **Kode Interpreter Inline Kini Gated**: Hasil pentest Atria-Dawn membuktikan `python3 -c "..."` (termasuk payload base64 `executescript`) sempat lolos dengan verdict `allow` tanpa konfirmasi — melalui itu agent bisa menghapus store, audit, dan database. Kini payload interpreter inline (`python3 -c`, `node -e`, `bun -e`, `perl -e`, `ruby -e`, `php -r`, `deno eval`, `awk`, dsb.) wajib `ask` (tidak dapat diperiksa secara deterministik), dan `block` bila payload menyentuh area terlindungi (`.guardian-angel`/`.git`) atau memuat pola destruktif root. Interpreter yang dispatch command via `system()` (mis. `awk 'system("rm x")'`) juga di-scan.
- **Pipe ke Shell & Dynamic Substitution Kini Gated**: Perintah yang mem-pipe data ke shell interpreter (`echo <base64> | base64 -d | bash`, `cat script.sh | sh`, `find | xargs sh`) otomatis di-gate ke `ask:pipe-to-shell` / `ask:xargs-shell`. Substitusi dinamis dalam `eval "$(base64 -d ...)"` di-gate ke `ask:variable-command`. Command word ber-escape heksadesimal, oktal, maupun Unicode (`$'\x72\x6d'`, `$'\162\155'`, `$'\u0072'` — semua di-unescape dan diblokir sebagai `block:rm-root`.
- **SSH Remoting Kini Di-unwrap & Diinspeksi**: Perintah remote lewat `ssh [flags] host "command"` (termasuk via `sshpass`) di-unwrap dan diinspeksi secara rekursif (termasuk ssh bertingkat dan `-o ProxyCommand`). Jika remote command destruktif (`rm -rf /`, `DROP TABLE`) maka langsung `block`; jika mutatif maka `ask`; jika memuat remote `rm` maka di-gate `ask:remote-rm` (karena tidak ada `ga trash` di remote host); dan ssh interaktif tanpa remote command tetap `allow`.
- **Compound Command Multi-Segment Kini Diinspeksi**:_classifier sebelumnya hanya memeriksa perintah pertama dari sebuah compound (`cd /tmp; sqlite3 db "DROP TABLE users;"` lolos). Kini setiap segmen dipisahkan secara benar (`;`, `&&`, `||`, `&`, `|`) dan masing-msegmen diklasifikasi SQL ataupun script; verdict terberat menang. Pembuatan script dan eksekusinya dalam satu perintah (`printf '#!/bin/sh\n...' > x.sh; sh x.sh`) juga kini terdeteksi sebagai `block:script-destructive` / `ask:script-dynamically-generated`.
- **File Skrip Interpreter Kini Diinspeksi (Script Content Gate)**: Eksekusi file skrip (`python3 script.py`, `node server.js`, `bash build.sh`, `./script.py`, `source script.sh`, `. script.sh`) diinspeksi kontennya jika file ada di disk. `source`/`.` (POSIX dot builtin) sempat menjadi lubang — eksekusi script destruktif via `source evil.sh` lolos sebagai `allow:default`; kini keduanya melewati script-gate yang sama. Jika skrip mencoba memodifikasi store (`.guardian-angel`) atau `.git` maka langsung `block`; jika memuat perintah destruktif (`rm -rf /`, `shutil.rmtree('/')`, `DROP TABLE`) maka `block`; jika memuat eksekusi dinamis/obfuscated (`eval`, `exec`, base64 decoding) di luar direktori vendor/build maka `ask`; skrip di luar workspace atau file binary tidak terbaca `ask`; dan skrip bersih tetap `allow`. Approval di-scope per-file path (bukan per-workspace). Residual: skrip yang belum ada di disk saat parse, kewujudan dinonaktif (`test -f` digunakan untuk memverifikasi keberadaan) atau dengan konstruksi string dinamis ekstrim (`chr(46)+'guardian-angel'`) tetap memerlukan isolasi OS — script gate melihat static patterns saja.
- **Dukungan Cross-Volume Trash & Verifikasi Integritas SHA-256**: Mekanisme `ga trash` menggunakan `fs.renameSync` atomic O(1) sebagai fast-path; jika target berada di filesystem/mount device berbeda (`EXDEV`), guard secara otomatis fallback ke copy+verify+delete terverifikasi SHA-256 (file dan direktori). Metadata `meta.json` mencatat `sha256` dan `copied: true`. Saat `ga restore`, integritas payload diverifikasi ulang dengan hash sebelum dipulihkan, dan restore lintas-device juga mendukung fallback verifikasi hash yang sama. Jika verifikasi gagal di tahap mana pun, file asli tidak pernah dihapus.
- **Isolasi Store & Tripwire Integritas SHA-256 (Tier 1)**: Berkas store `.guardian-angel/approvals.json` dan `.guardian-angel/audit.jsonl` dilindungi ganda: (1) izin berkas pada sistem operasi di-lock mode read-only (`0o400`) saat diam, sehingga direct write via redirection (`>`), python `open('w')`, atau `node` langsung menghasilkan `EACCES: permission denied`; hanya mutasi sah oleh Guardian Angel yang membuka kunci (`0o600`) sesaat secara atomik. (2) Tripwire in-memory menyimpan saksi hash SHA-256 atas setiap status sah. Jika ada proses luar yang mengubah izin dan memodifikasi isi `approvals.json` di luar guard, tripwire seketika mendeteksi ketidakcocokan hash, membatalkan/mereset seluruh approval palsu menjadi kosong, dan menahan perintah kembali ke konfirmasi pengguna. Isolasi kernel penuh (user dedicated) dibahas di PRD `os-isolation-store.prd.md`.

### Residual yang Tetap (Honest Disclosure)

Guardian Angel adalah guard deterministik berbasis parsing, **bukan sandbox OS**. Vektor berikut tetap menjadi batas yang diakui secara terbuka dan terdokumentasi di corpus redteam:
- **Script Dunia Runtime**: kode yang melakukan fetch/perubahan path secara dinamis (mis. `requests.get` + dynamic import, `chr(46)+'guardian-angel'`) lolos dari regex. Script gate melihat static patterns saja. Inilah alasan Batas 5 (store `0o400` + tripwire) eksis sebagai backstop.
- **Base64/encoding pipe ke shell dengan receiver non-shell** tetap membutuhkan perhatian (sudah gated untuk shell receiver).
- **Skrip yang baru dibuat dan langsung dieksekusi dalam command yang sama** kini terdeteksi melalui path-match `fullCommand`, tetapi konstruksi yang sangat dinamis tetap lolos.
- **Tool selain `bash`/`write`/`edit`/`patch`** (mis. `task`, MCP tools) bersifat passthrough — hanya keempat tool itu yang dimetakan ke `ToolCall` saat ini.

---

## Lisensi

MIT
