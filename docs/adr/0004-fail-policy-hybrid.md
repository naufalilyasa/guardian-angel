# Fail policy hybrid saat classifier error

Saat classifier gagal (exception/timeout), perintah yang cocok pola destruktif yang dikenal di-block (fail-closed); perintah lain di-allow sambil mencatat log (fail-open). Alasan: fail-open murni (pilihan cc-safety-net) membiarkan perintah destruktif lolos justru saat guard rusak; fail-closed murni memblokir alur kerja normal karena bug internal. Konsekuensi: error classifier tidak mematikan produktivitas, tapi pola destruktif tetap tertahan walau classifier rusak sebagian.
