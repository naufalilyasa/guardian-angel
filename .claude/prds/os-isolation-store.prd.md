# Isolasi OS untuk Store Guardian Angel

## Problem

Guard ini menyimpan approval dan audit di dalam workspace (`.guardian-angel/`). Classifier menutup jalur tulis yang dikenal (write/edit, redirection, `cp`/`mv`/`sed -i`, dan sebagainya), tapi **tidak bisa menutup semua jalur**.

Sudah dibuktikan: `python3 -c "..."` lolos dari classifier, dan lewat situ agent bisa menulis `approvals.json` yang valid. Setelah itu, `sudo apt install evil` langsung `allow` dengan **0 konfirmasi**. Ini bukan bug yang bisa ditutup dengan pola teks — interpreter adalah permukaan tak terbatas.

## Evidence

**Bukti langsung dari probe pada codebase ini:**

```
python3 -c "..."  → classifier: allow
  → tulis .guardian-angel/approvals.json dengan bentuk key yang benar
  → guard("sudo apt install evil") → {"verdict":"allow","reason":"approval sudah ada untuk Scope ini"}
  → confirm calls: 0
```

**Keputusan desain yang sudah diambil:** HMAC atas scope **ditolak** sebagai solusi. Alasannya: secret lokal apa pun bisa dibaca agent lewat bash yang sama, jadi HMAC di sini adalah security theater — menambah kompleksitas tanpa menambah keamanan nyata.

**Assumption — needs validation via prototype:** Belum diuji apakah pemisahan user OS benar-benar menutup jalur ini tanpa merusak alur kerja normal (agent butuh menulis ke workspace, tapi tidak ke store).

## Users

- **Primary**: Developer yang menjalankan agent dengan akses ke repo berisi data berharga, dan butuh jaminan bahwa agent tidak bisa memalsukan approval-nya sendiri.
- **Secondary**: Tim yang perlu memenuhi syarat audit — "agent tidak bisa memodifikasi log auditnya sendiri".
- **Not for**: Pengguna single-user yang menganggap risiko ini dapat diterima. Untuk mereka, guard pola teks sudah cukup, dan PRD ini bisa dilewati.

## Hypothesis

We believe **memisahkan store guard ke lokasi yang tidak bisa ditulis oleh user OS agent** akan **menutup jalur forged-approval sepenuhnya** for **developer yang butuh jaminan keras**.

We'll know we're right when **agent yang menjalankan `python3 -c` untuk menulis ke store gagal dengan permission error, dan guard tetap berfungsi normal untuk operasi yang sah**.

## Success Metrics

| Metric | Target | How measured |
|---|---|---|
| Agent gagal menulis store lewat interpreter | 1 dari 1 kasus | Probe `python3 -c` → permission denied |
| Guard tetap berfungsi untuk operasi sah | 100% | Suite 355 test tetap lulus |
| Audit tidak bisa dirusak agent | 1 dari 1 kasus | Probe truncate → permission denied |
| Tidak ada regresi alur kerja | 0 kegagalan | Smoke test CLI + adapter |

## Scope

**MVP** — Bukti bahwa pemisahan OS-level bisa menutup residual tanpa merusak fungsi:

1. **Store berada di lokasi yang tidak bisa ditulis user agent** — mekanismenya TBD (mount read-only, user terpisah, atau path di luar workspace dengan permission ketat).
2. **Agent tetap bisa bekerja normal** — menulis ke workspace, menjalankan perintah, menggunakan trash.
3. **Probe membuktikan penolakan** — `python3 -c` yang mencoba menulis store gagal.
4. **Dokumentasi batasan** — apa yang dilindungi dan apa yang tidak.

**Out of scope**

- **Full sandbox (container/VM per sesi)** — jauh lebih besar; ini hanya soal store.
- **Enkripsi store** — tidak menambah keamanan terhadap agent yang punya akses baca.
- **Multi-user / multi-tenant** — di luar cakupan POC.
- **Windows** — target macOS dan Linux.

## Delivery Milestones

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | Mekanisme isolasi dipilih dan divalidasi | Satu pendekatan terbukti menutup jalur tulis agent | pending | — |
| 2 | Probe forged-approval gagal | `python3 -c` tidak bisa menulis store | pending | — |
| 3 | Regresi nol | 355 test + smoke test CLI tetap lulus | pending | — |

## Open Questions

- [ ] **Mekanisme mana yang dipilih?** Tiga kandidat: (a) mount read-only untuk store, (b) user OS terpisah, (c) store di luar workspace dengan permission `0700` milik user lain. Masing-masing punya trade-off berbeda. → `TBD — needs validation via prototype`
- [ ] **Apakah trash masih berfungsi kalau store read-only?** Trash butuh menulis. Mungkin butuh dua area: store read-only untuk audit/approval, area writable untuk trash.
- [ ] **Bagaimana portabilitas macOS vs Linux?** `chown` dan mount semantics berbeda.
- [ ] **Apakah ini masih "POC" atau sudah produk?** Kompleksitasnya mungkin melebihi sisa anggaran POC.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Isolasi merusak alur kerja normal (trash tidak bisa menulis) | High | High — guard jadi tidak berguna | Pisahkan area read-only (audit/approval) dari writable (trash) |
| Kompleksitas setup membuat orang tidak mau pakai | High | Medium — guard ditinggalkan | Sediakan mode default tanpa isolasi + mode hardened opsional |
| Perilaku berbeda di macOS dan Linux | Medium | Medium | Uji keduanya; dokumentasikan perbedaan |
| Menambah attack surface baru (sudo, permission salah) | Medium | High | Review keamanan khusus untuk mekanisme yang dipilih |

---
*Status: DRAFT — requirements only. Implementation planning pending via /plan.*
