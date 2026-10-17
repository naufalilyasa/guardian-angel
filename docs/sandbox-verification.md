# Verifikasi isolasi test

Dokumen ini mencatat mengapa test tidak bisa menghapus file nyata di laptop, dan apa yang harus dicek sebelum menjalankan test pertama.

## Lapisan isolasi

| Lapis | Mekanisme | Yang dicegah |
|---|---|---|
| 1 | Test hanya di VM Lima, bukan macOS | Test destruktif tidak pernah dieksekusi di laptop |
| 2 | Repo di-mount `writable: false` via virtiofs | Bug kode tidak bisa menulis/menghapus repo host |
| 3 | Salinan kerja hanya di `/tmp` VM (ext4) | Test menulis di disk virtual, bukan host |
| 4 | `mkdtemp` per test + `assertInSandbox` fail-closed | Test tidak keluar dari direktori sandbox-nya |
| 5 | Canary file di luar root | Membuktikan tidak ada path di luar sandbox yang tersentuh |

## Fakta penting soal mount

- Lima `writable: false` adalah proteksi kernel/FS di level mount, bukan sekadar konvensi: guest tidak punya izin tulis ke mount tersebut.
- `vmType: vz` + `mountType: virtiofs` (Lima >= 0.17) memakai shared directory Apple Virtualization; mount read-only tidak membuka jalur tulis ke host.
- Home macOS tidak di-mount sama sekali; hanya direktori repo.
- VM sendiri punya disk virtual 20 GiB terpisah; `rm -rf /` di dalam VM tidak menyentuh host.

## Data yang dihapus test

Semua target `rm` di test adalah **file dummy yang dibuat oleh test itu sendiri** di dalam `mkdtemp`, misalnya:

```
/tmp/ga-test-XXXX/workspace/build/artifact.bin
```

Test redteam yang memakai perintah seperti `rm -rf /` **tidak mengeksekusi** perintah itu: classifier hanya mengembalikan Verdict `block`, dan assertion memeriksa Verdict-nya. Tidak ada eksekusi shell nyata untuk perintah destruktif.

## Checklist sebelum run pertama

- [ ] `limactl` terpasang (`brew install lima`)
- [ ] `vm/guardian.yaml` memakai `mountType: virtiofs` + `writable: false`
- [ ] Jalankan `scripts/test-in-vm.sh`; output menunjukkan test berjalan di dalam VM
- [ ] Setelah run, `git status` di repo host bersih (tidak ada file berubah/terhapus)
