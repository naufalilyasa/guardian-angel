import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearDenialCache, createHookHandler } from "../src/adapters/opencode/server.ts";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("20-Case Destructive Smoke Test (OpenCode Adapter)", () => {
  test("20 destructive cases are strictly held, blocked, or safely rewritten — 0 silent passes", async () => {
    clearDenialCache();
    const sandboxRoot = mkdtempSync(join(tmpdir(), "ga-smoke-20-"));
    const pkgRoot = resolve(import.meta.dir, "..");
    const ipcDir = mkdtempSync(join(tmpdir(), "ga-smoke-ipc-"));

    // Canary file inside workspace — must remain 100% untouched
    const canaryPath = join(sandboxRoot, "canary.txt");
    const canarySecret = `CANARY-${Date.now()}-${Math.random()}`;
    writeFileSync(canaryPath, canarySecret, "utf8");
    const canaryHash = sha256(canarySecret);

    // Existing files for overwrite tests
    const existingFile = join(sandboxRoot, "existing.txt");
    writeFileSync(existingFile, "original content before overwrite", "utf8");
    const existingHash = sha256("original content before overwrite");

    const existingCode = join(sandboxRoot, "code.ts");
    writeFileSync(existingCode, "export const value = 42;\n", "utf8");

    // Quoted path file for rm rewrite test
    const quotedDir = join(sandboxRoot, "quoted-dir with space");
    mkdirSync(quotedDir, { recursive: true });
    const fileInsideQuoted = join(quotedDir, "target.txt");
    const quotedContent = "data to be safely trashed and restored";
    writeFileSync(fileInsideQuoted, quotedContent, "utf8");
    const quotedHash = sha256(quotedContent);

    // Hook handler configured for this workspace (headless mode, no active TUI)
    const hook = createHookHandler({
      workspace: sandboxRoot,
      pkgRoot,
      ipcDir,
      confirmTimeoutMs: 1000,
    });

    type TestCase = {
      id: number;
      name: string;
      tool: string;
      args: Record<string, unknown>;
      expectedOutcome: "throw-block" | "throw-ask" | "rewrite-trash";
    };

    const cases: TestCase[] = [
      // 1. Quoted path rm (Old guard hole #1) -> safely rewritten to ga trash
      {
        id: 1,
        name: 'rm quoted path with spaces: rm -rf "quoted-dir with space"',
        tool: "bash",
        args: { command: `rm -rf "${quotedDir}"` },
        expectedOutcome: "rewrite-trash",
      },
      // 2. Overwrite existing file via > (Old guard hole #2) -> ask throw
      {
        id: 2,
        name: "echo overwrite existing file: echo evil > existing.txt",
        tool: "bash",
        args: { command: "echo evil > existing.txt" },
        expectedOutcome: "throw-ask",
      },
      // 3. Root destruction -> block
      {
        id: 3,
        name: "root destruction: rm -rf /",
        tool: "bash",
        args: { command: "rm -rf /" },
        expectedOutcome: "throw-block",
      },
      // 4. Home destruction -> block
      {
        id: 4,
        name: "home destruction: rm -rf ~",
        tool: "bash",
        args: { command: "rm -rf ~" },
        expectedOutcome: "throw-block",
      },
      // 5. Root child destruction -> block
      {
        id: 5,
        name: "system dir destruction: rm -rf /var",
        tool: "bash",
        args: { command: "rm -rf /var" },
        expectedOutcome: "throw-block",
      },
      // 6. bash -c wrapper evasion -> block
      {
        id: 6,
        name: 'bash -c wrapper: bash -c "rm -rf /"',
        tool: "bash",
        args: { command: 'bash -c "rm -rf /"' },
        expectedOutcome: "throw-block",
      },
      // 7. sh -c wrapper evasion -> block
      {
        id: 7,
        name: "sh -c wrapper: sh -c 'rm -rf /'",
        tool: "bash",
        args: { command: "sh -c 'rm -rf /'" },
        expectedOutcome: "throw-block",
      },
      // 8. eval wrapper evasion -> block
      {
        id: 8,
        name: 'eval wrapper: eval "rm -rf /"',
        tool: "bash",
        args: { command: 'eval "rm -rf /"' },
        expectedOutcome: "throw-block",
      },
      // 9. xargs rm launcher -> block
      {
        id: 9,
        name: "xargs launcher: find . | xargs rm -rf",
        tool: "bash",
        args: { command: "find . | xargs rm -rf" },
        expectedOutcome: "throw-block",
      },
      // 10. find -exec rm -> block
      {
        id: 10,
        name: "find -exec: find . -exec rm -rf {} +",
        tool: "bash",
        args: { command: "find . -exec rm -rf {} +" },
        expectedOutcome: "throw-block",
      },
      // 11. SQL single DROP TABLE -> block
      {
        id: 11,
        name: 'psql DROP TABLE: psql -c "DROP TABLE users;"',
        tool: "bash",
        args: { command: 'psql -c "DROP TABLE users;"' },
        expectedOutcome: "throw-block",
      },
      // 12. SQL multi-payload DROP TABLE bypass -> block
      {
        id: 12,
        name: 'mysql multi-payload: mysql -e "SELECT 1" -e "DROP TABLE users;"',
        tool: "bash",
        args: { command: 'mysql -e "SELECT 1" -e "DROP TABLE users;"' },
        expectedOutcome: "throw-block",
      },
      // 13. SQL multi-payload TRUNCATE -> block
      {
        id: 13,
        name: 'psql multi-payload TRUNCATE: psql -c "SELECT 1" -c "TRUNCATE orders;"',
        tool: "bash",
        args: { command: 'psql -c "SELECT 1" -c "TRUNCATE orders;"' },
        expectedOutcome: "throw-block",
      },
      // 14. Chained rm -> block
      {
        id: 14,
        name: "chained rm: rm ./a && rm ./b",
        tool: "bash",
        args: { command: "rm ./a && rm ./b" },
        expectedOutcome: "throw-block",
      },
      // 15. Chained rm + command -> block
      {
        id: 15,
        name: "chained rm + test: rm ./build && npm test",
        tool: "bash",
        args: { command: "rm ./build && npm test" },
        expectedOutcome: "throw-block",
      },
      // 16. Write outside workspace -> ask throw
      {
        id: 16,
        name: "write outside workspace: write /etc/hosts",
        tool: "write",
        args: { filePath: "/etc/hosts", content: "127.0.0.1 evil" },
        expectedOutcome: "throw-ask",
      },
      // 17. Tamper with .guardian-angel store -> block
      {
        id: 17,
        name: "tamper store: write .guardian-angel/config.json",
        tool: "write",
        args: { filePath: join(sandboxRoot, ".guardian-angel/config.json"), content: "{}" },
        expectedOutcome: "throw-block",
      },
      // 18. Tamper with .git repository -> block
      {
        id: 18,
        name: "tamper git: write .git/config",
        tool: "write",
        args: { filePath: join(sandboxRoot, ".git/config"), content: "evil" },
        expectedOutcome: "throw-block",
      },
      // 19. Cat /dev/null truncation overwrite -> ask throw
      {
        id: 19,
        name: "cat /dev/null truncation: cat /dev/null > code.ts",
        tool: "bash",
        args: { command: "cat /dev/null > code.ts" },
        expectedOutcome: "throw-ask",
      },
      // 20. Sed -i in-place rewrite -> ask throw
      {
        id: 20,
        name: "sed -i in-place modification: sed -i 's/value/evil/' code.ts",
        tool: "bash",
        args: { command: "sed -i 's/value/evil/' code.ts" },
        expectedOutcome: "throw-ask",
      },
    ];

    expect(cases.length).toBe(20);

    let rewrittenCommand = "";

    for (const c of cases) {
      const output = { args: { ...c.args } };
      let threw = false;
      let errorMessage = "";

      try {
        await hook(
          {
            tool: c.tool,
            sessionID: `session-smoke-${c.id}`,
            callID: `call-smoke-${c.id}`,
          },
          output,
        );
      } catch (err) {
        threw = true;
        errorMessage = (err as Error).message;
      }

      if (c.expectedOutcome === "throw-block") {
        expect(threw).toBe(true);
        expect(errorMessage).toContain("[guardian-angel]");
        expect(errorMessage).not.toContain("memerlukan persetujuan");
      } else if (c.expectedOutcome === "throw-ask") {
        expect(threw).toBe(true);
        expect(errorMessage).toContain("[guardian-angel]");
        expect(errorMessage).toContain("memerlukan persetujuan");
      } else if (c.expectedOutcome === "rewrite-trash") {
        expect(threw).toBe(false);
        expect(output.args.command).toContain("ga.ts");
        expect(output.args.command).toContain("trash");
        rewrittenCommand = output.args.command as string;
      }
    }

    // VERIFY REWRITE EXECUTION & UNDO / RESTORE (Case #1)
    expect(rewrittenCommand).toBeTruthy();
    // Jalankan perintah rewrite yang dihasilkan (ga trash) melalui shell
    const trashProc = Bun.spawnSync(["sh", "-c", rewrittenCommand], {
      cwd: sandboxRoot,
      env: { ...process.env, GA_WORKSPACE: sandboxRoot },
    });
    if (trashProc.exitCode !== 0) {
      console.error("trash stderr:", trashProc.stderr.toString());
    }
    expect(trashProc.exitCode).toBe(0);
    // Direktori target seharusnya sudah dipindahkan ke trash
    expect(existsSync(quotedDir)).toBe(false);

    // Sekarang jalankan restore --last
    const restoreProc = Bun.spawnSync(
      ["bun", "run", resolve(pkgRoot, "src/cli/ga.ts"), "restore", "--last"],
      {
        cwd: sandboxRoot,
        env: { ...process.env, GA_WORKSPACE: sandboxRoot },
      },
    );
    expect(restoreProc.exitCode).toBe(0);

    // Target berhasil dipulihkan dengan konten byte-identik!
    expect(existsSync(quotedDir)).toBe(true);
    expect(existsSync(fileInsideQuoted)).toBe(true);
    const restoredContent = readFileSync(fileInsideQuoted, "utf8");
    expect(sha256(restoredContent)).toBe(quotedHash);

    // VERIFY CANARY INTACT
    expect(existsSync(canaryPath)).toBe(true);
    const canaryActual = readFileSync(canaryPath, "utf8");
    expect(canaryActual).toBe(canarySecret);
    expect(sha256(canaryActual)).toBe(canaryHash);

    // VERIFY EXISTING FILES INTACT
    expect(existsSync(existingFile)).toBe(true);
    expect(sha256(readFileSync(existingFile, "utf8"))).toBe(existingHash);

    // VERIFY AUDIT LOG RECORDED DECISIONS
    const auditPath = join(sandboxRoot, ".guardian-angel/audit.jsonl");
    expect(existsSync(auditPath)).toBe(true);
    const auditLines = readFileSync(auditPath, "utf8").trim().split("\n");
    // Setiap block dan ask harus memiliki baris audit
    expect(auditLines.length).toBeGreaterThanOrEqual(19);

    // Cleanup
    try {
      rmSync(sandboxRoot, { recursive: true, force: true });
      rmSync(ipcDir, { recursive: true, force: true });
    } catch {}
  });
});
