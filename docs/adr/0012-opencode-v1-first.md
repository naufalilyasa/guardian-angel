# OpenCode v1 dulu, v2 ditunda

Adapter OpenCode ditulis terhadap v1 (versi stabil yang terpasang di mesin ini, 1.19.3) memakai hook `tool.execute.before` + permission config native. v2 (permukaan registrasi baru `v2/effect`/`v2/promise`, `Plugin { id, setup }`) ditunda sampai core dan adapter v1 stabil. Alasan: v2 masih bergerak dan menambah permukaan integrasi baru sebelum satu adapter pun terbukti; v1 sudah cukup untuk memvalidasi desain lintas-harness. Alternatif yang ditolak: langsung v2 (risiko churn API) dan menunda OpenCode sepenuhnya (kehilangan pembuktian kedua).
