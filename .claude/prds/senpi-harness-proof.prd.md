# Bukti Adapter Senpi di Harness Sungguhan

## Problem

Adapter Senpi sudah ada dan lulus 15 unit test, tapi **semuanya memakai `ExtensionContext` tiruan**. Tidak ada satu pun bukti bahwa adapter ini benar-benar dipanggil oleh Senpi, atau bahwa ia benar-benar menahan tool call destruktif saat harness berjalan.

Konsekuensinya: kalau signature hook Senpi berubah, atau adapter tidak ter-load sama sekali, **semua test tetap hijau**. Guard yang seharusnya melindungi justru tidak pernah aktif, dan tidak ada yang tahu.

## Evidence

**Bukti dari codebase:**

- `test/adapter.test.ts` mengonstruksi `ExtensionContext` manual dengan `as unknown as ExtensionContext` dan `ui.confirm` buatan sendiri. Ini menguji logika adapter, bukan integrasi.
- `senpi` **tidak terpasang** di mesin pengembangan (`which senpi` → tidak ditemukan). Paket `@code-yeongyu/senpi` hanya ada sebagai devDependency untuk tipe.
- `scripts/test-cli-in-vm.sh` menguji `ga trash` / `ga restore` / `ga status` / `ga gc` — CLI, bukan guard memblokir agent.
- README menyatakan adapter dipasang lewat `senpi -e ./src/adapters/senpi.ts` atau disalin ke `~/.senpi/agent/extensions/`, tapi langkah itu tidak pernah diverifikasi.

**Assumption — needs validation via prototype:** Belum diketahui apakah hook `ToolCallEvent` di Senpi 2026.10.16 masih kompatibel dengan yang dipakai adapter. Perlu dijalankan sungguhan.

## Users

- **Primary**: Developer yang memakai Senpi/OMO sebagai harness dan butuh jaminan bahwa guard benar-benar aktif sebelum menyerahkan task destruktif.
- **Secondary**: Maintainer yang perlu tahu kapan integrasi rusak (perubahan API hook) — saat ini tidak ada sinyal sama sekali.
- **Not for**: Pengguna OpenCode (lihat PRD OpenCode), atau pengguna yang butuh sandbox OS-level.

## Hypothesis

We believe **smoke test end-to-end yang menjalankan Senpi sungguhan dengan adapter terpasang** akan **membuktikan (atau membantah) bahwa guard menahan tool call destruktif** for **developer pengguna Senpi**.

We'll know we're right when **satu perintah destruktif yang dijalankan agent lewat Senpi ditolak sebelum eksekusi, dan satu `rm` yang disetujui bisa dipulihkan lewat `ga restore` — semuanya tanpa mock**.

## Success Metrics

| Metric | Target | How measured |
|---|---|---|
| Senpi benar-benar memuat adapter | Ter-load, terverifikasi | Log startup Senpi atau `--verbose` |
| Tool call destruktif ditahan | 1 dari 1 kasus | Perintah `rm -rf` lewat agent, file target masih ada |
| `rm` yang disetujui bisa dipulihkan | 1 dari 1 kasus | `ga restore` mengembalikan byte identik (SHA-256) |
| Popup konfirmasi muncul untuk verdict `ask` | 1 dari 1 kasus | Observasi manual |

## Scope

**MVP** — Bukti minimal bahwa integrasi Senpi nyata dan bekerja:

1. **Senpi terpasang dan adapter ter-load** di VM/Linux, terverifikasi dari log.
2. **Satu smoke test destruktif**: agent diminta menjalankan `rm -rf` pada direktori berisi file; guard menahan; file masih ada.
3. **Satu smoke test `ask`**: agent menjalankan perintah ask-tier; popup konfirmasi muncul; setelah disetujui, perintah jalan.
4. **Satu smoke test restore**: `rm` yang disetujui menghasilkan trash entry yang bisa dipulihkan.

**Out of scope**

- **Pengujian semua 58 kasus redteam di Senpi** — cukup satu per kelas (block, ask, rewrite).
- **Adapter OpenCode** — PRD terpisah.
- **Windows** — target macOS dan Linux.
- **Sandbox OS-level** — di luar batas guard (ADR 0005).
- **Otomasi CI untuk smoke test ini** — dijalankan manual dulu; otomasi menyusul setelah terbukti stabil.

## Delivery Milestones

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | Senpi terpasang + adapter ter-load | Log membuktikan adapter aktif, bukan di-skip | pending | — |
| 2 | Smoke test block | Perintah destruktif ditahan, file target utuh | pending | — |
| 3 | Smoke test ask + restore | Popup muncul, approval bekerja, `ga restore` memulihkan | pending | — |

## Open Questions

- [ ] **Apakah `senpi` bisa diinstal dan dijalankan non-interaktif di VM?** Perlu dicek apakah ada mode headless. → `TBD — needs validation via prototype`
- [ ] **Bagaimana memicu agent untuk menjalankan perintah tertentu secara deterministik?** Prompt bisa ditafsirkan berbeda-beda. Mungkin butuh fixture prompt atau mode scripted.
- [ ] **Di mana log Senpi menunjukkan adapter ter-load?** Perlu ditemukan sebelum bisa diverifikasi.
- [ ] **Apakah `ctx.ui.confirm` bekerja di mode non-TUI (RPC/print)?** Kalau tidak, smoke test `ask` butuh mode TUI.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Senpi tidak bisa dijalankan headless di VM | Medium | High — seluruh smoke test terhambat | Cek dokumentasi; kalau tidak bisa, jalankan di host dengan direktori sekali pakai |
| Agent tidak menjalankan perintah yang diharapkan | High | Medium — test tidak deterministik | Gunakan prompt eksplisit; verifikasi dari log tool call |
| Adapter gagal ter-load tanpa error yang jelas | Medium | High — test bisa "lulus" palsu | Verifikasi dari log, bukan hanya dari exit code |
| Perubahan API hook Senpi antar versi | Medium | Medium | Pin versi; smoke test sebagai deteksi dini |

---
*Status: DRAFT — requirements only. Implementation planning pending via /plan.*
