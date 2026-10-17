# Trash store di dalam volume workspace

File yang dihapus di-rename ke direktori trash di dalam volume workspace supaya Undo O(1) (operasi metadata rename) dan tidak pernah kena EXDEV. Konsekuensi: workspace mendapat direktori `.guardian-angel/` yang harus di-.gitignore otomatis; direktori yang sama juga menampung `approvals.json` (Q14) dan `audit.jsonl` (Q17). Alternatif yang ditolak: trash di home directory (rename lintas volume gagal, fallback copy+delete mahal dan kehilangan metadata) dan mode hybrid pindah-volume (terlalu kompleks untuk fase 1).
