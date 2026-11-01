# guardian-angel

Guard + undo untuk agent AI: keputusan deterministik sebelum tool call dieksekusi, dengan undo sebagai jaring pengaman utama. Mendukung OpenCode v2.1.4 (target utama), OpenCode 1.19.3 (mode maintenance), dan Senpi/OMO Native.

## Language

**Core**:
Logika keputusan deterministik yang tidak pernah meng-import kode harness.
_Avoid_: engine, library

**Adapter**:
Lapisan tipis per-harness yang menerjemahkan hook pre-tool-call harness ke pemanggilan Core.
_Avoid_: plugin, extension

**Harness**:
Runtime agent yang menjalankan tool call (OpenCode v2.1.4, OpenCode v1.19.3, Senpi/OMO Native).
_Avoid_: host, client

**Verdict**:
Hasil Core untuk satu tool call: allow, ask, atau block.
_Avoid_: decision, action

**Tier**:
Kategori keputusan Verdict. `allow` langsung jalan, `ask` minta persetujuan per Scope, `block` ditolak.
_Avoid_: level, mode

**Scope**:
Kunci persetujuan tier `ask`: kombinasi path dan sesi, bukan per tool call.
_Avoid_: permission

**Approval**:
Persetujuan tersimpan untuk sebuah Scope; setelah ada Approval, Verdict `ask` pada Scope yang sama tidak bertanya lagi.
_Avoid_: consent

**Trash**:
Penyimpanan file hasil penghapusan agar bisa dipulihkan.
_Avoid_: recycle bin, backup

**Undo**:
Pemulihan file dari Trash.
_Avoid_: rollback

**Redteam**:
Kumpulan kasus uji bypass yang mencatat batas kemampuan guard secara jujur.
_Avoid_: fuzzing
