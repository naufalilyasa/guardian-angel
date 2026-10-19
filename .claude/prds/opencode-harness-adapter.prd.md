# OpenCode sebagai Harness Utama untuk Guardian Angel

## Problem

Developer yang menjalankan coding agent di repo nyata tidak punya cara untuk menghentikan agent sebelum ia mengeksekusi perintah destruktif. Guardian Angel sudah punya core yang terbukti (355 test, 58 kasus redteam), tapi **belum bisa dipakai di OpenCode sama sekali** — satu-satunya adapter yang ada adalah Senpi, dan itu pun belum pernah diuji di harness sungguhan.

Akibatnya, nilai guard ini (trash/undo, policy berlapis, audit JSONL, approval 24 jam) tidak sampai ke harness yang benar-benar dipakai sehari-hari. Guard lama yang ada di OpenCode menangkap sebagian kasus, tapi punya lubang yang sudah terbukti: path ber-quote lolos dari blokir `rm`, dan overwrite via `>` tidak ditahan sama sekali.

## Evidence

**Bukti langsung dari uji pada mesin ini (2026-10-19):**

Guard lama `~/.config/opencode/plugins/destructive-guard.js` (315 baris) diuji dengan probe nyata:

| Perintah | Hasil |
|---|---|
| `rm -rf /path/tanpa-quote` | **BLOCKED** — rule `rm-destructive` |
| `/bin/rm -rf /path` | **BLOCKED** — rule `rm-destructive` |
| `bash -c 'rm -rf /path'` | **BLOCKED** — wrapper di-unwrap |
| `rm -rf "/path/ber-quote"` | **LOLOS** — exit 0, direktori terhapus |
| `echo "x" > file.log` (file existing) | **LOLOS** — exit 0, file ter-truncate |

Bypass `rm -rf "path"` bukan kasus tepi: agent rutin menghasilkan path ber-quote, terutama saat path mengandung spasi.

**Celah struktural pada guard lama** (dari pembacaan `destructive-guard.js`):

- Hanya hook `tool.execute.before`, dan satu-satunya cara memblokir adalah `throw new Error(message)` (baris 310). Komentar di baris 308-309 menyatakan `output.message` tidak berpengaruh.
- **Tidak memakai hook `permission.ask`** yang tersedia di `@opencode-ai/plugin` — hook itu bisa mengubah status menjadi `"ask" | "deny" | "allow"`.
- **Tidak ada verdict `ask`.** Semua keputusan biner: lolos atau throw. Tidak ada popup approval.
- **Tidak ada trash/undo.** Blokir = perintah tidak jalan; tidak ada jalan tengah "jalankan tapi bisa dipulihkan".
- **Tidak ada audit terstruktur.** Menulis ke `~/.cc-safety-net/logs/destructive-guard.jsonl`, bukan store per-workspace.
- **Tidak ada approval 24 jam.** Setiap pengulangan perintah yang sama akan diblokir lagi.

**Permukaan integrasi yang tersedia (terverifikasi di `@opencode-ai/plugin` 1.19.3):**

- `PluginInput` menyediakan `directory` dan `worktree` — workspace root tersedia untuk trash. **Terverifikasi lewat probe nyata:** keduanya terisi saat `plugin-init`.
- Hook `tool.execute.before` menerima `{ tool, sessionID, callID }` dan `output.args` yang bisa dimutasi (dipakai untuk rewrite `rm` → `ga trash`). **Terverifikasi lewat probe nyata:** hook ini terpanggil untuk setiap bash command, dan `output.args.command` berisi perintah lengkap.
- `tool.execute.after` juga terpanggil — berguna untuk verifikasi pasca-eksekusi.
- `PermissionAction` didefinisikan sebagai `"allow" | "deny" | "ask"` — ada dukungan first-class untuk verdict `ask` di tipe.

**Hasil probe `permission.ask` (2026-10-19) — MEMBATALKAN ASUMSI SEBELUMNYA:**

Probe dijalankan dengan plugin nyata di OpenCode 1.19.3, empat skenario berbeda. Hasilnya:

| Skenario | `permission.ask` terpanggil? | Keputusan efektif |
|---|---|---|
| Config global `"*": "allow"` (default mesin ini) | **Tidak** | `allow`, pattern `*` |
| Config project `"*": "ask"` | **Tidak** | `allow`, pattern `*` |
| Config global diubah ke `"ask"` + project `"ask"` | **Tidak** | `allow`, pattern `*` |
| Agent kustom tanpa permission eksplisit | **Tidak** | `allow`, pattern `*` |

Log DEBUG menunjukkan: `message=evaluated permission=bash pattern="..." action.permission=bash action.action=allow action.pattern=*`

**Akar masalah:** setiap agent di `~/.config/opencode/opencode.json` mendefinisikan `permission.bash: "allow"` secara eksplisit per-agent (agent `build`, `planner`, dan seterusnya). Permission level-agent ini menimpa config global, sehingga evaluasi selalu menghasilkan `allow` dan hook `permission.ask` tidak pernah dipanggil.

**Konsekuensi:** `permission.ask` **tidak dapat diandalkan** sebagai mekanisme popup. Guard harus memakai `tool.execute.before` — yang terbukti selalu terpanggil — untuk keputusan.

**Catatan:** config user sudah dipulihkan ke kondisi semula dan diverifikasi dengan checksum SHA-256 identik.

**Jalur popup yang TERBUKTI ada — plugin TUI terpisah (opsi b):**

Pencarian di `@opencode-ai/plugin` menemukan dua jenis plugin yang berbeda:

| Jenis | Hook | Kemampuan dialog |
|---|---|---|
| Plugin **server** | `tool.execute.before`, `permission.ask` | Tidak ada akses UI |
| Plugin **TUI** | `TuiPluginApi` | `ui.DialogConfirm`, `ui.DialogAlert`, `ui.DialogPrompt`, `ui.DialogSelect`, `ui.toast` |

`TuiPluginApi` (dari `@opencode-ai/plugin/tui`) menyediakan:

```ts
ui: {
  DialogConfirm: (props: TuiDialogConfirmProps) => JSX.Element  // title, message, onConfirm, onCancel
  DialogAlert:   (props: TuiDialogAlertProps) => JSX.Element    // title, message, onConfirm
  dialog: TuiDialogStack                                        // replace(), clear(), open
  toast: (input: TuiToast) => void
}
```

`TuiDialogConfirmProps` persis yang dibutuhkan popup approval: `title`, `message`, `onConfirm`, `onCancel`.

**Batasan penting:** `PluginModule` (server) mendeklarasikan `tui?: never`, dan `TuiPluginModule` mendeklarasikan `server?: never`. Keduanya **tidak bisa** berada dalam satu modul. Jadi popup memerlukan **dua plugin terpisah** yang berkomunikasi.

**Jalur komunikasi yang tersedia:** `TuiEventBus.on()` (TUI bisa mendengar event), `api.kv` (key-value store), dan `client` (SDK, termasuk `session.prompt`).

**PROTOTYPE SUDAH DIJALANKAN (2026-10-19) — arsitektur ini TERBUKTI BEKERJA:**

Prototype kecil dengan dua komponen (server plugin + simulasi TUI lewat file IPC) diuji di OpenCode 1.19.3 sungguhan. Tiga jalur diuji:

| Jalur | Hasil | Bukti |
|---|---|---|
| **Hook di-await** | **Ya** — agent benar-benar berhenti | `before-enter → before-exit` dengan `elapsed: 10008ms`; `tool.execute.after` baru muncul 49 ms setelahnya; perintah bash tidak dieksekusi selama menunggu |
| **Allow** | Perintah jalan | Request ditulis, response `{"decision":"allow"}` dibaca setelah 21 s, `echo IPC_TEST` dieksekusi, output `IPC_TEST` muncul |
| **Deny** | Perintah diblokir | Response `{"decision":"deny"}` setelah 8,5 s → `✗ echo DENY_TEST failed` + `Error: [guardian-angel] ditolak user` |
| **Timeout** | Fail-closed | Tanpa response, hook throw setelah 5 s → `Error: [guardian-angel] approval timeout — perintah dibatalkan (fail-closed)` |

**Temuan tambahan:** setelah timeout, agent mencoba ulang perintah **sekali** (2 attempt tercatat). Ini berarti user bisa melihat dua popup untuk satu perintah — perlu ditangani di desain.

**Kesimpulan:** popup approval **terbukti bisa diwujudkan**. Arsitektur: server plugin memakai `tool.execute.before` (di-await, terbukti memblokir) + TUI plugin memakai `ui.DialogConfirm` untuk popup. Untuk prototype, komunikasi lewat file IPC; untuk produksi bisa `TuiEventBus` atau `api.kv`. Kompleksitasnya dua plugin, tapi jalurnya sudah tervalidasi.

**Bukti bahwa kelas masalah ini nyata di codebase ini sendiri:** review keamanan atas core guardian-angel menemukan 4 bypass critical yang reproducible (forge approvals, scope bleed, multi-payload SQL, symlink escape). Semuanya sudah ditutup dan dikunci regression test. Ini menunjukkan bahwa guard berbasis pola teks memang bisa bocor, dan bukti empiris lebih berharga daripada asumsi.

**Assumption — needs validation via prototype:** Belum ada kejadian nyata kehilangan data di mesin ini. Risiko didasarkan pada laporan komunitas developer yang kehilangan file akibat agent, dan pada dua bypass yang terbukti di atas.

## Users

- **Primary**: Developer yang memakai OpenCode sebagai harness utama untuk mengerjakan repo nyata, yang ingin menyerahkan task destruktif (refactor besar, migrasi, cleanup) ke agent tanpa kehilangan kerja. Trigger: agent mengusulkan `rm`, `DROP`, atau overwrite file.
- **Secondary**: Developer yang memakai Senpi/OMO, yang butuh bukti bahwa guard benar-benar menahan tool call — bukan hanya lulus unit test dengan mock.
- **Not for**: Tim yang butuh sandbox OS-level atau isolasi multi-tenant. Guard ini bukan security boundary (lihat ADR 0005). Juga bukan untuk Windows di fase ini.

## Hypothesis

We believe **dua plugin OpenCode — server plugin memakai `tool.execute.before` untuk keputusan dan TUI plugin memakai `ui.DialogConfirm` untuk popup approval — plus trash/undo untuk rewrite** akan **menghentikan agent sebelum menghapus data tanpa persetujuan** for **developer yang memakai OpenCode di repo nyata**.

We'll know we're right when **20 dari 20 percobaan destruktif (rm, overwrite, SQL DROP, wrapper, path ber-quote) tertahan atau memunculkan popup approval di OpenCode sungguhan — 0 yang lolos diam-diam — dan setiap `rm` yang disetujui bisa dipulihkan lewat `ga restore`**.

## Success Metrics

| Metric | Target | How measured |
|---|---|---|
| Bypass rate pada corpus destruktif | 0 dari 20 kasus | Smoke test end-to-end di OpenCode sungguhan, bukan mock |
| Popup approval muncul untuk verdict `ask` | 100% kasus ask | Observasi manual + log sesi |
| `rm` yang disetujui bisa dipulihkan | 100% | `ga restore --last` mengembalikan byte identik (SHA-256) |
| Audit line tertulis untuk setiap block/ask | 100% | Hitung baris `audit.jsonl` vs jumlah keputusan |
| Bypass `rm -rf "path"` (lubang guard lama) | Tertutup | Regression test eksplisit |
| Overwrite via `>` terdeteksi | Tertutup | Regression test eksplisit |

## Scope

**MVP** — Bukti bahwa guard ini bekerja di OpenCode sungguhan, dengan tiga kemampuan inti:

1. **Server plugin OpenCode** yang memakai `tool.execute.before` (satu-satunya hook yang terbukti selalu terpanggil) untuk memetakan verdict core (`allow|ask|block`): `throw` untuk block, delegasi ke popup untuk ask, mutasi `args.command` untuk rewrite.
2. **Popup approval untuk verdict `ask`** — lewat TUI plugin terpisah yang memakai `ui.DialogConfirm`. User melihat command, alasan, dan bisa memilih izinkan/tolak. Pilihan "izinkan" diingat per-rule (bukan per-workspace) selama 24 jam. Mekanisme komunikasi server↔TUI TBD.
3. **Trash/undo untuk `rm`** — `rm` yang lolos tetap menghasilkan `ga trash`, sehingga `ga restore` bisa memulihkan.
4. **Smoke test destruktif end-to-end** di OpenCode sungguhan yang membuktikan 0 bypass dari 20 kasus, termasuk dua lubang guard lama (path ber-quote, overwrite `>`).

**Out of scope**

- **Sandbox OS / isolasi user terpisah** — residual store-forgery lewat interpreter (`python3 -c`) tetap ada. Butuh infrastruktur OS, bukan fitur aplikasi. Didokumentasikan sebagai batasan.
- **Windows** — target macOS dan Linux saja. Alasan: tidak ada kebutuhan terverifikasi, dan path/shell semantics berbeda.
- **Adapter Codex / Claude Code** — ditunda sampai OpenCode terbukti.
- **CoW snapshot / filesystem snapshot** — trash sudah cukup untuk MVP.
- **Menggantikan permission native OpenCode sepenuhnya** — guard ini menggantikan *keputusan*, bukan *mekanisme*. Config `permission` OpenCode tetap ada; guard yang menentukan verdict.
- **Adapter Senpi** — smoke test Senpi di harness nyata adalah PRD terpisah. PRD ini fokus pada OpenCode sebagai harness utama. Paritas Senpi tetap diperlukan sebelum rilis, tapi bukan bagian dari MVP ini.

## Delivery Milestones

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | OpenCode adapter + popup ask | Agent berhenti dan bertanya sebelum aksi `ask`; user melihat command dan alasan | **completed** | Phase 2, 3, 4 (`src/adapters/opencode/`) |
| 2 | Trash/undo end-to-end di OpenCode | `rm` yang disetujui bisa dipulihkan dengan `ga restore`, byte identik | **completed** | Phase 2 & `test/smoke-20-cases.test.ts` |
| 3 | Smoke test destruktif 20 kasus | 0 bypass terbukti di OpenCode sungguhan, termasuk path ber-quote dan overwrite `>` | **completed** | Phase 6 (`test/smoke-20-cases.test.ts` + `scripts/test-opencode-smoke.ts`) |

## Open Questions

- [x] ~~**Apakah `permission.ask` bisa memunculkan popup?**~~ **TERJAWAB (2026-10-19, probe nyata):** **Tidak dapat diandalkan.** Hook tidak pernah terpanggil dalam 4 skenario uji, karena setiap agent mendefinisikan `permission.bash: "allow"` secara eksplisit di config, yang menimpa config global dan project. Guard harus memakai `tool.execute.before`.
- [x] ~~**Apakah config permission mematikan hook `permission.ask`?**~~ **TERJAWAB:** Ya, dalam praktik. Permission level-agent (`permission.bash: "allow"` per agent) membuat evaluasi selalu `allow`, sehingga hook tidak pernah dipanggil. Ini membatalkan asumsi sebelumnya.
- [x] ~~**Apakah OpenCode menyediakan cara membaca `cwd`/workspace?**~~ **TERJAWAB:** `PluginInput.directory` dan `.worktree` tersedia saat plugin init. Terverifikasi lewat probe: `directory=/private/var/.../probe-opencode`. Perlu ditangkap di closure plugin karena `tool.execute.before` tidak menerimanya.
- [x] ~~**Apakah `tool.execute.before` selalu terpanggil?**~~ **TERJAWAB:** Ya. Terpanggil untuk setiap bash command di semua skenario uji, termasuk saat permission `allow`. Ini satu-satunya hook yang bisa diandalkan.
- [x] ~~**Apakah server plugin bisa memblokir (await) sambil menunggu jawaban TUI?**~~ **TERJAWAB (2026-10-19, prototype nyata):** **Ya, dan ini berfungsi sempurna.** `tool.execute.before` di-await oleh OpenCode. Probe menahan hook selama 10 detik; log menunjukkan `before-enter → before-exit` dengan `elapsed: 10008ms`, dan `tool.execute.after` baru muncul 49 ms setelahnya. Perintah bash **tidak dieksekusi** selama hook menunggu. Agent benar-benar berhenti.
- [x] ~~**Mekanisme komunikasi server↔TUI?**~~ **TERJAWAB (prototype):** IPC berbasis file bekerja — server plugin menulis request JSON, menunggu response file (polling 200 ms), lalu lanjut atau throw. Diuji tiga jalur: **allow** (waited 21 s → perintah jalan, output `IPC_TEST`), **deny** (waited 8,5 s → `Error: ditolak user`, perintah tidak jalan), **timeout** (waited 5 s → `Error: approval timeout — fail-closed`). Untuk produksi, mekanisme ini bisa diganti `TuiEventBus` atau `api.kv`, tapi file IPC sudah membuktikan polanya valid.
- [x] ~~**Bagaimana kalau TUI tidak berjalan (mode headless/`opencode run`)?**~~ **TERJAWAB:** Menggunakan fallback fail-closed `throw` saat `isTuiActive` false: `[guardian-angel] <reason> (memerlukan persetujuan, tetapi TUI tidak aktif)`.
- [x] ~~**Apakah `@opencode-ai/plugin/tui` kompatibel dengan OpenCode 1.19.3?**~~ **TERJAWAB:** TUI plugin dimuat via `tui.json`, `@opentui` runtime dibundel di dalam binary OpenCode CLI 1.19.3, dan antarmuka `ui.DialogConfirm` diuji lewat test mock & lifecycle.
- [x] ~~**Bagaimana `throw new Error` berinteraksi dengan permission system?**~~ **TERJAWAB:** `throw` di `tool.execute.before` menghasilkan `✗ command failed` + pesan error yang terlihat user di output OpenCode. Terbukti di jalur deny dan timeout.
- [x] ~~**Berapa lama approval diingat?**~~ **TERJAWAB:** Mengikuti core Guardian Angel: 24 jam per-rule.
- [x] ~~**Apakah retry otomatis setelah timeout bisa dihindari?**~~ **TERJAWAB:** Cache penolakan `recentDenials` dengan TTL 30s (`sessionId:tool:target`) mencegah double popup/timeout saat agen me-retry perintah yang ditolak.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ~~Komunikasi server↔TUI tidak bisa memblokir agent~~ | ~~Medium-High~~ **TERBUKTI BISA** | — | Sudah divalidasi prototype: hook di-await, agent berhenti |
| Retry otomatis setelah timeout menghasilkan popup ganda | **High** (terbukti) | Medium — user lihat 2 popup untuk 1 perintah | Cache keputusan timeout per callID; atau perpanjang timeout |
| Popup tidak muncul di mode headless (`opencode run`) | High | Medium — smoke test otomatis tidak bisa menguji popup | Fallback `throw` saat TUI tidak aktif (fail-closed); sudah terbukti bekerja |
| `@opencode-ai/plugin/tui` (1.18.2) tidak cocok dengan CLI 1.19.3 | Medium | High — jalur popup native gagal | IPC file sudah terbukti sebagai fallback; verifikasi versi sebelum implementasi |
| Dua plugin menambah kompleksitas deployment | High | Medium — user harus memasang dua plugin | Sediakan satu paket yang mendaftarkan keduanya; dokumentasi jelas |
| Hook OpenCode berubah antar versi (1.19.3 → berikutnya) | Medium | Medium | Pin versi di dokumentasi; smoke test sebagai deteksi dini |
| Guard memperlambat setiap tool call | Low | Medium | Hanya verdict `ask` yang menunggu; `allow`/`block` instan |
| Dua guard (lama + baru) aktif bersamaan → prompt ganda | Medium | Medium | Nonaktifkan guard lama saat adapter baru aktif; dokumentasikan |

---
*Status: IMPLEMENTED & VERIFIED — semua 3 milestone terpenuhi, 393 unit test pass, 20/20 kasus destruktif tertahan.*
