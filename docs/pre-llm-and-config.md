# Pre-LLM interception (opsional, bukan jalur keputusan)

Tujuan: mendeteksi instruksi berbahaya di konteks sebelum dikirim ke provider, tanpa menggantikan choke point pre-tool-call.

| Harness | Hook | Kemampuan | Status |
|---|---|---|---|
| Senpi | `context` / `context_with_system` | transform transcript + system prompt; hasil dikirim apa adanya | stabil |
| Senpi | `before_provider_request` | ganti payload provider | stabil |
| OpenCode v1 (1.19.3) | `experimental.chat.system.transform` | ubah array system prompt | experimental |
| OpenCode v1 (1.19.3) | `experimental.chat.messages.transform` | ubah messages | experimental |
| OpenCode v1 (1.19.3) | `chat.params` / `chat.headers` | parameter & header request | stabil |

Aturan pakai:

- Temuan pre-LLM hanya **menaikkan kewaspadaan** (tandai sesi) dan menulis audit; tidak pernah menjadi satu-satunya alasan block.
- Semua Verdict destruktif tetap diputuskan di `tool_call` / `tool.execute.before`.
- Bila hook experimental gagal, guard lanjut tanpa pre-LLM (fail-open untuk lapis ini).

## Contoh config tier

`.guardian-angel/config.json`:

```json
{
  "rules": [
    { "match": { "tool": "bash", "command": "rm -rf *" }, "tier": "ask", "reason": "hapus rekursif di workspace" },
    { "match": { "tool": "bash", "command": "rm -rf /*" }, "tier": "block", "reason": "root" },
    { "match": { "tool": "bash", "command": "mysql * -e *DROP*" }, "tier": "block", "reason": "DROP di produksi" },
    { "match": { "tool": "bash", "command": "git push*" }, "tier": "ask", "reason": "push ke remote" }
  ]
}
```

Aturan `block` bawaan tidak bisa diturunkan oleh config proyek; hanya config global user yang boleh.
