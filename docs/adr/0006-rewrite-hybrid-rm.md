# Rewrite hybrid untuk rm destruktif

Hanya `rm` dengan target tunggal yang terparse bersih yang di-rewrite otomatis menjadi pemindahan ke Trash; perintah kompleks (glob, substitusi, pipe, multi-target) di-block dengan perintah pengganti siap-tempel. Alasan: kasus umum dapat magic tanpa risiko, kasus sulit tetap aman walau parser salah baca. Alternatif yang ditolak: rewrite total (salah parse = kehilangan data diam-diam) dan block-only (kehilangan diferensiasi Undo dan mengganggu alur kerja).
