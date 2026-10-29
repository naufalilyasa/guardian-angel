# Desain Porting Adapter OpenCode v2 (v2.1.4)

Status: Fase 0–2 tervalidasi live termasuk gate TUI interaktif (2026-10-28..29, OpenCode v2.1.4). Menyupersede ADR-0012 untuk target adapter OpenCode (ADR-0013 difilekan di Fase 4).

### Fakta verifikasi live (2026-10-28, `opencode run --standalone`)

- Daemon v2 memuat `~/.config/opencode/plugins/*.ts` otomatis (id = path file; watcher berlangganan per file — **jangan taruh plugin throw-on-shell di direktori ini selama sesi berjalan**, akan memblokir tool shell sesi sendiri).
- `setup(ctx)` dipanggil; `ctx.tool.hook(\"execute.before\", cb)` tersedia dan `cb` menerima event `{tool, input, sessionID, agent, messageID, id}` persis seperti asumsi §1.2.
- `ctx.location.directory` = direktori boot daemon (workspace efektif saat ini). Key `ctx` (O-1): `app, location, options, agent, aisdk, command, credential, event, experimental, generate, model, provider, integration, mcp, permission, plugin, reference, rpc, skill, storage, tool, vcs, websearch, worktree, session, shell` — **tidak ada `client`** → advisor client harus lewat `createOpencodeClient` (fallback) atau `opts.advisorClient`.
- Tool gate **bekerja end-to-end**: `cat /dev/null > canary.txt` → verdict `block` ruleId `ask:write-outside` reason \"TUI is not running\" (fail-closed headless) → tool call dibatalkan, canary utuh.
- **Bug ditemukan & diperbaiki**: nama tool v2 `"shell"` vs v1 `"bash"` — tanpa pemetaan, `toToolCall` return null dan hook menjadi no-op (bypass total). Tes v2 diperbarui memakai `"shell"` + test mapping eksplisit.

### Fakta verifikasi TUI interaktif (2026-10-29)

- **Plugin TUI tidak bisa berupa file tunggal atau entry `cli.json`** — client mengabaikannya. Menurut docs resmi (<https://opencode.ai/v2/docs/cli/plugins>), TUI plugin = bagian `./tui` dari **package plugin** yang ditemukan di `<global-config>/plugins/<nama>/` (atau `<project>/.opencode/plugins/<nama>/`) dengan layout:
  ```
  <global-config>/plugins/guardian-angel/package.json   {"exports": {".": "./index.ts", "./tui": "./tui.tsx"}}
  <global-config>/plugins/guardian-angel/index.ts       ← server part (dimuat daemon)
  <global-config>/plugins/guardian-angel/tui.tsx        ← TUI part (dimuat client)
  ```
  Shim file tunggal `guardian-angel.ts` hanya dimuat **daemon** (dengan WARN "must be a directory"); client hanya meregistrasi (plugins=14) tanpa pernah mengimpor modulnya (diverifikasi via marker level-modul yang tidak pernah tertulis). Setelah layout direktori diterapkan, client mereconcile plugins=15 dan `context.ui.slot`/`context.keymap` terisi.
- **Gate interaktif end-to-end terbukti**: heartbeat TUI tertulis di `$TMPDIR/guardian-angel-ipc-<user>/<sha256-16>/tui-heartbeat.json`, hook daemon → rule `ask:write-outside` → dialog muncul di TUI → user allow → approval scope `workspace\0session\0workspace\0ask:write-outside` TTL 24j tercatat, tool diizinkan. Semua layer (hook → guard → IPC → dialog → approval store → audit) urut.
- **Approval ber-scoped workspace untuk write-outside**: satu allow di sesi ini membuat semua tulisan keluar workspace di sesi yang sama auto-approve 24 jam — catatan UX (default scope tombol allow). Konsisten dengan perilaku v1.
- Residual: daemon memberi WARN satu kali (ENOENT) untuk path file lama saat transisi; entry plugin manager bisa menampilkan kegagalan basi sampai restart berikutnya.

## Temuan eksplorasi (fakta repo, 2026-10-28)

- `bun test`: **653 tests / 24 files hijau (3.40s)**. Test mengimpor dari `src/adapters/opencode/{server,tui,ipc,advisor-client,question-dialog,permission-view,notification}.ts(x)` — semua file v1 wajib tetap kompatibel.
- `@opencode-ai/plugin@1.18.2` (terpasang) **sudah mengekspor `./v2/promise` dan `./v2/effect`**, tapi `PluginContext`-nya hanya puny `options, agent, aisdk, catalog, command, integration, plugin, reference, skill` — **tidak ada `ctx.tool`**. Permukaan `ctx.tool.hook("execute.before")` ada di rilis yang lebih baru; **upgrade SDK adalah prasyarat, bukan no-op**.
- Snapshot dist-tag `tui-v2` (0.0.0-tui-v2-20260626): `TuiEventBus` hanya `on` (subscribe `Event` SDK), **tidak ada `emit`/channel custom**; `TuiPluginApi` sudah punya `keymap.registerLayer`, `mode.push`, `slots.register`, `plugins.activate`, `kv`, `lifecycle`. Slot `session_prompt` masih ada di snapshot itu — penghapusan +nama `session.composer.top`/`prompt.footer` ada di v2.1.4 sesuai spesifikasi.
- `executeHookLogic` / `createHookHandler` di `server.ts` **sudah harness-agnostic**: signaturenya `{tool, sessionID, callID}` + `{args}`. Map ke event v2 hanya pembungkus tipis (lihat §1.2).
- `toToolCall(tool, args)` di `server.ts` juga sudah v2-shaped (`(tool: string, args: Record)`). Tidak perlu ditulis ulang.

---

## 1. Server Adapter v2

### 1.1 Keputusan: modul v2 terpisah, v1 tidak disentuh (bukan dual-export satu modul)

Ditolak: satu modul yang mengekspor sekaligus Plugin v1 (`PluginModule { server }`) dan Plugin v2 (`define({id, setup})`). Alasan: `PluginModule.server` dan `TuiPluginModule.tui` saling eksklusif (`server?: never`), loader v1/v2 membaca bentuk modul berbeda, dan di v2 **daemon dan TUI adalah proses terpisah** yang masing-masing memuat pluginnya sendiri — dua modul adalah konsekuensi arsitektur, bukan pilihan gaya.

Dipilih: `src/adapters/opencode-v2/server.ts` membungkus logika shared yang sudah ada **tanpa mengedit file v1 mana pun**. `server.ts` v1 tetap menjadi tempat `createHookHandler`/`toToolCall`/denial-cache diekspor (test v1 dan konsumen lama tidak bergerak).

```
 src/adapters/opencode-v2/server.ts      ← baru, ~40 baris, hanya map event→shared shape
 src/adapters/opencode/server.ts          ← tidak diubah (ekspor createHookHandler, toToolCall, ...)
 src/core/*                               ← tidak diubah sama sekali
```

### 1.2 Mapping event v2 → ToolCall & mutasi

```ts
// src/adapters/opencode-v2/server.ts
import { resolve } from "node:path";
import { createHookHandler } from "../opencode/server.ts";
import { resolveAdvisorModel, type AdvisorSdkClient } from "../opencode/advisor-client.ts";

type ToolExecuteBeforeEvent = {
  tool: string;
  input: Record<string, unknown>;
  sessionID: string;
  agent?: string;
  messageID?: string;
  id: string;
};

export default define({
  id: "guardian-angel",
  async setup(ctx) {
    const opts = ctx.options ?? {};
    const pkgRoot = (opts.pkgRoot as string) ?? resolve(import.meta.dir, "../../..");
    const workspace = (opts.directory as string) ?? process.cwd();

    const handler = createHookHandler({
      workspace,
      pkgRoot,
      ipcDir: opts.ipcDir as string | undefined,
      confirmTimeoutMs: (opts.confirmTimeoutMs as number) ?? 0,
      advisorClient: resolveAdvisorClient(ctx, opts),     // lihat §1.4
      advisorModel: opts.advisorModel as string | undefined,
    });

    await ctx.tool.hook("execute.before", async (event: ToolExecuteBeforeEvent) => {
      // { args: event.input } membuat mutasi in-place event.input.command
      // (rewrite rm→ga trash) langsung terlihat oleh tool runner v2.
      await handler(
        { tool: event.tool, sessionID: event.sessionID, callID: event.id },
        { args: event.input },
      );
    });
  },
});
```

| v1 | v2 | Catatan |
|---|---|---|
| `input.tool` | `event.tool` | **d diverifikasi: tool shell v2 bernama `\"shell\"`, bukan `\"bash\"`** — dipetakan di `createServerV2Hook` sebelum masuk shared handler; tanpa pemetaan `toToolCall` return null → hook no-op (bypass!) |
| `input.sessionID` | `event.sessionID` | |
| `input.callID` | `event.id` | |
| `output.args` | `event.input` | objek yang sama yang dijalankan runner; mutasi in-place (diverifikasi: rewrite `rm→ga trash` memutar `event.input.command`) |
| `throw new Error` | `throw new Error` | **diverifikasi: v2.1.4 membatalkan tool call dan menjadikan error sebagai tool result** (sesi headless `opencode run --standalone` terblokir) |
| — | `event.agent` | terisi (mis. `\"build\"`); belum dipakai untuk filter approval |
| — | `event.messageID` | hanya audit |
| — | `event.input.workdir` | **baru**: direktori tool call; candidate workspace per-call (sekarang workspace = `ctx.location.directory` = direktori boot daemon) |

`toToolCall(event.tool, event.input)` dipakai apa adanya. Satu risiko nyata: **nama field input v2 bisa berbeda** (`filePath` vs `path`). Mitigasi: satu fungsi normalisasi `normalizeToolInput(tool, input)` di modul v2 yang mentoleransi ejaan keduanya + test tabel; tetap menggunakan pasangan `(tool, args)` sebagai satu-satunya seam.

### 1.3 Async approval wait (daemon memblokir hook)

Semantik yang dipertahankan persis dari v1:

- Hook callback di-`await` → tool call tertahan sampai approval selesai. Tidak ada perubahan.
- `waitForResponse` polling 150 ms; `deadline = 0` = menunggu selamanya **selama heartbeat TUI segar**; jika TUI mati → return `null` → denialReason `"TUI is not running"` → throw dengan pesan headless. Di v2 ini justru **lebih penting**: daemon bisa hidup tanpa TUI client yang terhubung.
- Denial cache 30 detik (retry suppression) tidak berubah; key tetap `${sessionId}:${tool}:${command|filePath}`.
- Konkurensi: file per-`callID`, tidak ada lock global; beberapa tool call paralel aman.
- Daemon berumur panjang: `preparedWorkspaces` (Set per-proses) dan registrasi hook sekali di `setup` cocok; policy tetap dimuat per-call via `loadEffectivePolicy` sehingga edit `.guardian-angel/config.json` langsung efektif tanpa restart daemon.

### 1.4 Advisor client

`advisor-client.ts` **tidak diubah**: `AdvisorSdkClient` adalah tipe structural (session.create + session.prompt), test-injectable, tidak terikat SDK. Yang berubah hanya dari mana `client` didapat. Di `PluginContext` snapshot yang diperiksa **tidak ada `client`** → open item:

- **O-1 (wajib di Fase 0)**: verifikasi apakah v2.1.4 `ctx` menyediakan client (mis. `ctx.client` / `ctx.integration.connection.active`). Fallback: `createOpencodeClient({ baseURL: daemonUrl })` dengan `daemonUrl` dari env/`ctx.options`. Advisor tetap **advisory-only, non-blocking** (status `loading→ready|error` lewat `advisor-<callID>.json`), tidak pernah gate — kegagalan advisor tidak boleh memblokir tool call.
- `resolveAdvisorModel(workspace, model)` dipakai apa adanya.

---

## 2. TUI Adapter v2

### 2.1 Slot pengganti

`session_prompt` dihapus. Pengganti: **`session.composer.top`** — area render milik plugin di atas composer, placement setara dengan v1 (dialog inline di atas prompt, no modal). Delta terhadap `PromptSlotWrapper` v1:

1. Nama slot: `session_prompt` → `session.composer.top`.
2. **Hentikan re-render `api.ui.Prompt`**. Di v1 kita harus merender ulang Prompt sendiri agar dialog bisa menyisip di atasnya; v2 me-render prompt native di bawah slot → hapus `renderPrompt()` + passthrough `api.ui.Prompt` (~30 baris). Yang tersisa: filter session-scope (`slotProps.session_id` + `shouldHandleRequest`) dan `<Show>` ke `QuestionDialog`.
3. `session_prompt_right` (slot `right` pada Prompt v1) menghilang bersama Prompt re-render; hint keyboard sudah ada di footer `QuestionDialog` sendiri.

`prompt.footer` **secara eksplisit tidak dipakai** — footer dialog sudah memuat hint; menambah slot kedua hanya duplikasi.

```tsx
// src/adapters/opencode-v2/tui.ts — hanya deltar terhadap v1
api.slots.register({
  order: 10,
  slots: {
    "session.composer.top"(_ctx: any, slotProps: { session_id?: string }) {
      return ComposerTopPanel({ api, activeRequest, slotProps }); // Show + QuestionDialog
    },
  },
});
```

Fallback `api.ui.dialog.replace(... QuestionDialog ...)` tetap (host tanpa renderer slot); cabang `DialogSelect`/`DialogConfirm` tetap (10 baris, untuk lingkungan tanpa renderer). Tidak ada penulisan ulang komponen: `question-dialog.tsx`, `permission-view.ts`, `notification.ts` dipakai apa adanya.

### 2.2 Keymap layer priority

`api.keymap.registerLayer({ priority: 1000, mode: "question", commands, bindings })` — API ini sudah ada di snapshot tui-v2 dan **kode v1 sudah memakainya**. Tetap:

- priority 1000 (di atas binding app/transcript), `mode: "question"` via `api.mode.push("question")` saat mount, `popMode()` + `unregister()` di `onCleanup`.
- Bindings: `up/k`, `down/j`, `tab` (expand), `pageup/pagedown`, `1` (deny), `2` (allow), `r` (advisor retry), `return`, `escape` (deny).
- Fallback listener `api.renderer.keyInput` hanya jika `registerLayer` tidak ada (test env, raw terminal) — tetap.

### 2.3 Lifecycle dialog

State machine tidak berubah dari v1 (hanya host slot yang beda):

```
pending(queue) → shown(slot/dialog) → settled(allow|deny) → cleanupFile
   ↑ processedCallIds dedup          settleOnce guard: sinyal pertama menang;
                                       onCleanup un-settled → deny (fail-closed)
```

- Queue + `processNext`, dedup `processedCallIds` (cap 1000), polling `listPendingRequests` 200 ms, heartbeat 2 s dengan `removeHeartbeat` di `api.lifecycle.onDispose`.
- `notifyDesktop` + `api.attention.notify` tetap.
- Workspace resolution di TUI: `options.workspace ?? api.state.path.directory ?? api.state.path.worktree ?? GA_WORKSPACE` → `getWorkspaceIpcDir(workspace)`. **Harus sama dengan daemon** (lihat R3).

---

## 3. Evaluasi IPC: pertahankan File-IPC

**Keputusan: file-IPC tetap; jangan migrasi ke v2 Plugin RPC/Event sekarang.**

Alasan (dibuktikan dari SDK, bukan asumsi):

1. **daemon ↔ TUI client = proses OS berbeda** — channel komunikasi dibutuhkan tak pedulikan API plugin. Di v1 pun server hook dan TUI sudah berkomunikasi lewat file karena API plugin tidak menyediakan panggilan langsung hook→TUI.
2. **Tidak ada channel custom yang terlihat**: `TuiEventBus` di SDK hanya `on` (subscribe tipe `Event` SDK yang tetap); tidak ada `emit`. `PluginContext` v2 tidak punya domain messaging. "Plugin RPC/Event" v2.1.4 — jika ada — belum terbukti membawa payload custom (`ruleId`, `deadline`, `advisor status`), dan tidak boleh dicampur dengan sistem permission native (`PermissionRequest` SDK) yang semantiknya berbeda (approval ber-scope rule + TTL + advisor card).
3. **File-IPC sudah ter-keras**: nonce anti-race, fail-closed timeout, mode 0700/0600, anti-symlink + ownership check, `cleanupStale`, heartbeat liveness, workspace isolation via sha256-16.
4. Biaya swap nanti **kecil** karena seamnya sudah alami: server hanya lewat `requestTuiApproval` (yang menulis request & menunggu response), TUI hanya lewat `listPendingRequests`/`writeResponse`/`readAdvisorStatus`. Tidak perlu interface `ApprovalTransport` sampai RPC v2 terkonfirmasi ada — itu abstraksi tanpa konsumen kedua hari ini.

**Syarat evaluasi ulang**: setelah Fase 0 (SDK v2.1.4 memiliki dokumentasi RPC plugin yang stabil dan ternyata mendukung payload custom + emit), spike satu hari; jika lolos, ganti isi `ipc.ts` di kedua sisi tanpa menyentuh `server`/`tui`.

Risiko spesifik v2 yang harus ditangani di ipc.ts:

- **R3 — workspace mismatch**: daemon dan TUI bisa melihat path berbeda (symlink/worktree). `resolve()` di hash sudah dilakukan kedua sisi; mitigasi tambahan: log `ipcDir` di startup daemon & TUI + smoke test dua-proses yang menegaskan keduanya sama.
- **R6 — multi-TUI attach**: snapshot tui-v2 punya `plugins.activate/deactivate`; beberapa terminal bisa ke daemon yang sama. Heartbeat saat ini satu file → saling menimpa. **Tunda**: baru ubah ke `tui-heartbeat-<pid>.json` (`isTuiActive` = salah satu segar) kalau multi-attach terkonfirmasi di uji asli. Perubahan ini menyentuh `ipc.ts` + `test/opencode-ipc.test.ts` + `tui-session-leak.test.ts` → harus dalam satu commit dengan full suite hijau.

---

## 4. Dual export & package layout

```jsonc
{
  "exports": {
    ".": "./src/adapters/opencode/server.ts",              // tetap v1 (konsumen terpasang tidak putus)
    "./server": "./src/adapters/opencode/server.ts",
    "./tui": "./src/adapters/opencode/tui.ts",
    "./opencode-server": "./src/adapters/opencode/server.ts",
    "./opencode-tui": "./src/adapters/opencode/tui.ts",
    "./opencode-v2/server": "./src/adapters/opencode-v2/server.ts",   // baru
    "./opencode-v2/tui": "./src/adapters/opencode-v2/tui.ts",         // baru
    "./senpi": "./src/adapters/senpi.ts"
  }
}
```

- `.` tetap v1 sampai v1 EOL (mencegah break instalasi yang ada); flip dilakukan sekali di Fase 4 dengan catatan rilis.
- **Satu devDependency** `@opencode-ai/plugin` di-pin ke rilis yang menyediakan `ctx.tool` (cek inout: rilis tersebut masih mengekspor API v1 `Plugin`/`Hooks` — peta ekspor 1.18.2 menyatukan keduanya, jadi v1 dan v2 hidup berdampingan dalam satu paket; tidak perlu dua dependency/alias).
- Config instalasi: **package plugin direktori** (diverifikasi 2026-10-29; `cli.json` HANYA untuk plugin CLI-only per docs <https://opencode.ai/v2/docs/cli/plugins>):
  ```
  ~/.config/opencode/plugins/guardian-angel/
    package.json   { "name": "guardian-angel", "type": "module",
                     "exports": { ".": "./index.ts", "./tui": "./tui.tsx" } }
    index.ts       export { default, GuardianAngelServerV2 } from "<abs>/src/adapters/opencode-v2/server.ts";
    tui.tsx        export { default, GuardianAngelTuiV2 } from "<abs>/src/adapters/opencode-v2/tui.tsx";
  ```
  - Import harus **path absolut** — daemon bisa boot dari cwd mana pun (bare specifier `guardian-angel-poc` gagal di-resolve saat cwd ≠ repo; diverifikasi).
  - Daemon memuat `index.ts` (server hooks) saat startup; TUI client memuat `tui.tsx` (slot/keymap/heartbeat). Penambahan file `~/.config/opencode/plugins/guardian-angel.ts` lama → ganti ke layout direktori.
  - Perubahan layout butuh restart daemon (`opencode service restart`) supaya sisi hook berganti; client reload saat TUI restart.
- `id: "guardian-angel"` dipakai di **kedua** plugin (daemon server plugin + TUI client plugin). Registri terpisah per proses, jadi id yang sama justru menjaga identitas koheren.
- File v1 tidak dihapus; dedup `toToolCall`/`shellQuote` dengan `senpi.ts` adalah duplikasi pra-ada yang **bukan bagian port ini** (ditandai, bukan dikerjakan).

---

## 5. Rencana migrasi bertahap (5 fase)

Prinsip: **Fase 1–2 murni aditif** — tidak ada satu barispun di `src/adapters/opencode/*` atau `src/core/*` yang diubah → 653 test dijamin tidak tersentuh. Setiap fase punya gerbang: `bun test` (semua) + `bun run typecheck` hijau, dan pengujian asli di OpenCode v2.1.4 untuk fase berlabel integrasi.

### Fase 0 — Verifikasi & pin SDK (gerbang atau mati)
- Bump `@opencode-ai/plugin` ke rilis v2.1.4-compatible; **sebelum commit**: scratch typecheck bahwa kode v1 masih kompabil terhadap paket baru (risiko R1). Jika v1 pecah: hentikan, cari rilis yang mendukung keduanya.
- Konfirmasi: bentuk `ctx.tool.hook("execute.before", …)`, bentuk `event`, lokasi client untuk advisor (O-1), skema `cli.json` `plugins`, nama slot final.
- Output: catatan fakta di ADR-0013. **Gerbang**: 653 hijau + typecheck.

### Fase 1 — Server adapter v2 (hanya file baru)
- `src/adapters/opencode-v2/server.ts` (§1.2) + `normalizeToolInput` jika nama field v2 berbeda.
- `test/opencode-v2-server.test.ts`: mirror `opencode-adapter.test.ts` dengan bentuk event v2 (mapping, rewrite `rm→trash` memutar `event.input.command` in-place, block lewat throw, headless fail-closed, denial cache, advisor status file).
- **Gerbang**: 653 lama + baru hijau; nol edit file v1/core.

### Fase 2 — TUI adapter v2 (hanya file baru)
- `src/adapters/opencode-v2/tui.ts` (§2.1–2.3); komponen dialog dipakai ulang.
- `test/opencode-v2-tui.test.tsx` dengan pola yang sudah ada: `createTestRenderer` + `render` (`@opentui/solid`), mock api dengan `slots.register("session.composer.top")`, `keymap.registerLayer`, `mode.push`, `lifecycle.onDispose`; tulis `request-<callID>.json`, asersi dialog muncul di slot, `writeResponse` → settle, `cleanupCall` terjadi, dispose membersihkan timer/heartbeat.
- **Gerbang**: full suite hijau; integrasi dua-proses asli (daemon + TUI client, satu workspace) — terima/tolak approval end-to-end, `ipcDir` konsisten (R3).

### Fase 3 — Hardening IPC (menyentuh file bersama, satu commit)
- Hanya jika Fase 2 membuktikan kebutuhan: heartbeat per-PID untuk multi-TUI (R6) + update `test/opencode-ipc.test.ts`, `test/tui-session-leak.test.ts` di commit yang sama.
- Tambah log `ipcDir` startup daemon & TUI.
- **Gerbang**: full suite hijau; smoke `scripts/test-opencode-smoke.ts` diperluas untuk v2.

### Fase 4 — Packaging, ADR, migrasi pengguna
- Tambah exports `./opencode-v2/*` (§4); update README (instalasi `cli.json`, kopet pelaporan); filekan `docs/adr/0013-opencode-v2-primary.md` (ADR-0012 → superseded: v2 jadi target utama, v1 mode maintenance); flip `.` ke v2 bila diinginkan dengan catatan rilis. Rencana EOL v1 (mis. 3 bulan) tergantung adopsi.
- **Gerbang**: full suite hijau + instalasi bersih di mesin lain.

### Register risiko

| # | Risiko | Mitigasi | Fase |
|---|---|---|---|
| R1 | Permukaan SDK v2 berubah / berbeda dari asumsi | Fase 0 verifikasi + pin eksak + typecheck v1 ulang; desain wrapper ~40 baris mudah disesuaikan | 0 |
| R2 | Nama field `event.input` berbeda dari v1 | `normalizeToolInput` + test tabel + corpus redteam jalan di v2 | 1 |
| R3 | Workspace daemon ≠ TUI → hash IPC berbeda → approval tidak pernah muncul | `resolve()` kedua sisi, log `ipcDir`, smoke dua-proses | 0,2 |
| R4 | 653 test regresi oleh edit shared | Fase 1–2 murni aditif; gerbang `bun test` setiap commit | 1–2 |
| R5 | Daemon hidup tanpa TUI + ask → tool hang | Sudah ditangani (heartbeat check → fail-closed); diverifikasi di v2 | 2 |
| R6 | Multi-TUI saling timpa heartbeat | Heartbeat per-PID, hanya jika terkonfirmasi; satu commit dengan test | 3 |
| R7 | Migrasi config `tui.json`→`cli.json` patah instalasi ada | v1 tetap berfungsi sepanjang; README migrasi + ADR | 4 |

### Dihindari dengan sengaja (bukan bagian port ini)

- Slot `prompt.footer` (duplikasi footer dialog). Penghapusan cabang `DialogSelect`/`DialogConfirm` fallback. Interface `ApprovalTransport` (tak ada konsumen kedua sampai RPC v2 terkonfirmasi). Dedup `toToolCall` dengan `senpi.ts` (duplikasi pra-ada). Filter approval berbasis `event.agent` baru setelah advisor/audit wiring stabil.
