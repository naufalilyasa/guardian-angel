# Threat model: kesalahan jujur + prompt injection oportunistik

Guard ini menargetkan kesalahan agent dan prompt injection oportunistik, bukan penyerang bertarget yang bisa menyusun serangan adaptif. Konsekuensi: core deterministik tanpa LLM di jalur keputusan; obfuscation (ANSI-C quoting, base64, dsb.) ditangani best-effort dan dicatat di corpus redteam; bukan sandbox, dan tidak boleh diposisikan sebagai security boundary. Alternatif yang ditolak: klaim anti semua injection (tidak jujur) dan scope penyerang bertarget (butuh isolasi OS di luar batas guard ini).
