# ADR 0013: OpenCode v2 Adapter & Dual Compatibility

## Status
Accepted (Supersedes ADR 0012)

## Konteks
OpenCode telah merilis versi 2 (v2.1.4 di lingkungan lokal) dengan perombakan arsitektur utama:
1. Pemisahan proses antara background service daemon (`opencode service`) dan client terminal TUI.
2. Migrasi antarmuka plugin server dari hook return object (v1: `tool.execute.before`) ke registrasi imperatif (v2: `ctx.tool.hook("execute.before")`).
3. Migrasi konfigurasi terminal TUI dari `tui.json(c)` ke satu konfigurasi global `~/.config/opencode/cli.json`.
4. Penghapusan slot `session_prompt` di TUI dan penggantian dengan slot `session.composer.top`.

## Keputusan
1. **Dukungan Penuh OpenCode v2**:
   - Dibuat adapter v2 terpisah di `src/adapters/opencode-v2/server.ts` dan `src/adapters/opencode-v2/tui.tsx`.
   - Plugin server v2 mengintercept tool call via `ctx.tool.hook("execute.before", event => ...)` dan melakukan mutasi in-place `event.input.command` saat rewrite `rm -> ga trash`.
   - Plugin TUI v2 merender dialog konfirmasi inline langsung di slot `session.composer.top` di atas prompt input tanpa modal overlay.
2. **Dual Export & Kompatibilitas Mundur v1**:
   - Adapter v1 (`src/adapters/opencode/server.ts` dan `src/adapters/opencode/tui.ts`) tetap dipertahankan 100% utuh beserta seluruh test suite v1.
   - Entrypoint loader `~/.config/opencode/plugins/guardian-angel.ts` mengadopsi struktur dual-export yang otomatis memanggil `setup(ctx)` di v2 atau `server(opts)` di v1.
3. **Komunikasi Antar-Proses (IPC)**:
   - Tetap menggunakan File-IPC terisolasi berbasis direktori per-workspace (`$TMPDIR/guardian-angel-ipc-<user>/<hash16>/`) dengan nonce kriptografis dan heartbeat verification.

## Konsekuensi
- Guardian Angel dapat berjalan secara transparan baik di OpenCode v1 maupun OpenCode v2.
- Pengguna OpenCode v2 mendaftarkan TUI plugin di `~/.config/opencode/cli.json`.
- 679 test unit dan integrasi lulus verifikasi tanpa regresi.
