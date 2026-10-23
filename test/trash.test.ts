import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gc, listTrash, restore, safeDelete, TRASH_TTL_MS } from "../src/core/trash.ts";
import { ensureStore, trashDir } from "../src/core/store.ts";

function sandbox(): { workspace: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "ga-trash-"));
  const workspace = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { workspace, outside };
}

describe("safeDelete", () => {
  test("moves a file into the trash and removes the original", () => {
    const { workspace } = sandbox();
    const target = join(workspace, "a.txt");
    writeFileSync(target, "hello", "utf8");

    const id = safeDelete(workspace, "a.txt");

    expect(existsSync(target)).toBe(false);
    const entries = listTrash(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(id);
    expect(entries[0].kind).toBe("file");
    expect(entries[0].originalPath).toBe(target);
  });

  test("writes meta.json with the original path", () => {
    const { workspace } = sandbox();
    writeFileSync(join(workspace, "b.txt"), "x", "utf8");
    const id = safeDelete(workspace, "b.txt");
    const meta = JSON.parse(
      readFileSync(join(trashDir(workspace), id, "meta.json"), "utf8"),
    );
    expect(meta.originalPath).toBe(join(workspace, "b.txt"));
    expect(meta.id).toBe(id);
  });

  test("moves a directory", () => {
    const { workspace } = sandbox();
    mkdirSync(join(workspace, "build"));
    writeFileSync(join(workspace, "build", "out.js"), "x", "utf8");

    safeDelete(workspace, "build");

    expect(existsSync(join(workspace, "build"))).toBe(false);
    expect(listTrash(workspace)[0].kind).toBe("dir");
  });

  test("refuses a target outside the workspace", () => {
    const { workspace, outside } = sandbox();
    const file = join(outside, "victim.txt");
    writeFileSync(file, "safe", "utf8");

    expect(() => safeDelete(workspace, file)).toThrow(/GA_TRASH_REFUSED/);
    expect(readFileSync(file, "utf8")).toBe("safe");
  });

  test("refuses the workspace root", () => {
    const { workspace } = sandbox();
    expect(() => safeDelete(workspace, ".")).toThrow(/GA_TRASH_REFUSED/);
  });

  test("REGRESSION: refuses to trash the guardian-angel store", () => {
    const { workspace } = sandbox();
    ensureStore(workspace);
    const audit = join(workspace, ".guardian-angel", "audit.jsonl");
    writeFileSync(audit, "{}\n", "utf8");

    expect(() => safeDelete(workspace, ".guardian-angel/audit.jsonl")).toThrow(/GA_TRASH_REFUSED/);
    expect(() => safeDelete(workspace, ".guardian-angel")).toThrow(/GA_TRASH_REFUSED/);
    expect(existsSync(audit)).toBe(true);
  });

  test("REGRESSION: refuses to trash .git", () => {
    const { workspace } = sandbox();
    mkdirSync(join(workspace, ".git"), { recursive: true });
    expect(() => safeDelete(workspace, ".git")).toThrow(/GA_TRASH_REFUSED/);
    expect(existsSync(join(workspace, ".git"))).toBe(true);
  });

  test("refuses a symlink", () => {
    const { workspace, outside } = sandbox();
    const target = join(outside, "real.txt");
    writeFileSync(target, "x", "utf8");
    symlinkSync(target, join(workspace, "link.txt"));

    expect(() => safeDelete(workspace, "link.txt")).toThrow(/GA_TRASH_REFUSED: symlink/);
    expect(existsSync(target)).toBe(true);
  });

  test("REGRESSION: refuses a target reached through a symlinked parent directory", () => {
    const { workspace, outside } = sandbox();
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "OUTSIDE-VICTIM", "utf8");
    symlinkSync(outside, join(workspace, "link"), "dir");

    expect(() => safeDelete(workspace, "link/victim.txt")).toThrow(/GA_TRASH_REFUSED: symlink in path/);
    expect(readFileSync(victim, "utf8")).toBe("OUTSIDE-VICTIM");
  });

  test("REGRESSION: refuses restore into a symlinked parent directory", () => {
    const { workspace, outside } = sandbox();
    mkdirSync(join(workspace, "nested"), { recursive: true });
    writeFileSync(join(workspace, "nested", "deep.txt"), "deep", "utf8");
    const id = safeDelete(workspace, "nested/deep.txt");


    rmSync(join(workspace, "nested"), { recursive: true, force: true });
    symlinkSync(outside, join(workspace, "nested"), "dir");

    expect(() => restore(workspace, id)).toThrow(/GA_TRASH_REFUSED: symlink in path/);
    expect(existsSync(join(outside, "deep.txt"))).toBe(false);
  });

  test("refuses a missing target", () => {
    const { workspace } = sandbox();
    expect(() => safeDelete(workspace, "nope.txt")).toThrow(/does not exist/);
  });

  test("leaves a canary outside the sandbox untouched", () => {
    const { workspace, outside } = sandbox();
    const canary = join(outside, "canary.txt");
    writeFileSync(canary, "intact", "utf8");
    writeFileSync(join(workspace, "c.txt"), "x", "utf8");

    safeDelete(workspace, "c.txt");

    expect(readFileSync(canary, "utf8")).toBe("intact");
  });
});

describe("restore", () => {
  test("restores identical content and removes the trash entry", () => {
    const { workspace } = sandbox();
    const target = join(workspace, "doc.txt");
    writeFileSync(target, "important", "utf8");
    const id = safeDelete(workspace, "doc.txt");

    const restored = restore(workspace, id);

    expect(restored).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("important");
    expect(listTrash(workspace)).toHaveLength(0);
  });

  test("restores into a recreated parent directory", () => {
    const { workspace } = sandbox();
    mkdirSync(join(workspace, "nested"));
    writeFileSync(join(workspace, "nested", "deep.txt"), "deep", "utf8");
    const id = safeDelete(workspace, "nested/deep.txt");

    rmSync(join(workspace, "nested"), { recursive: true, force: true });

    restore(workspace, id);

    expect(readFileSync(join(workspace, "nested", "deep.txt"), "utf8")).toBe("deep");
  });

  test("refuses to overwrite an existing file", () => {
    const { workspace } = sandbox();
    writeFileSync(join(workspace, "x.txt"), "original", "utf8");
    const id = safeDelete(workspace, "x.txt");
    writeFileSync(join(workspace, "x.txt"), "newer", "utf8");

    expect(() => restore(workspace, id)).toThrow(/GA_TRASH_RESTORE_CONFLICT/);
    expect(readFileSync(join(workspace, "x.txt"), "utf8")).toBe("newer");
  });

  test("throws for an unknown id", () => {
    const { workspace } = sandbox();
    expect(() => restore(workspace, "does-not-exist")).toThrow(/GA_TRASH_NOT_FOUND/);
  });

  test("rejects a traversal id", () => {
    const { workspace } = sandbox();
    expect(() => restore(workspace, "../escape")).toThrow(/GA_TRASH_INVALID_ID/);
  });
});

describe("gc", () => {
  test("removes entries older than the TTL and keeps fresh ones", () => {
    const { workspace } = sandbox();
    writeFileSync(join(workspace, "old.txt"), "old", "utf8");
    writeFileSync(join(workspace, "new.txt"), "new", "utf8");

    const base = 1_700_000_000_000;
    safeDelete(workspace, "old.txt", () => base - TRASH_TTL_MS - 1000);
    safeDelete(workspace, "new.txt", () => base);

    expect(listTrash(workspace)).toHaveLength(2);
    const removed = gc(workspace, () => base);

    expect(removed).toBe(1);
    const remaining = listTrash(workspace);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].originalPath).toBe(join(workspace, "new.txt"));
  });

  test("returns zero on an empty store", () => {
    const { workspace } = sandbox();
    expect(gc(workspace)).toBe(0);
  });
});

describe("listTrash", () => {
  test("sorts newest first", () => {
    const { workspace } = sandbox();
    writeFileSync(join(workspace, "one.txt"), "1", "utf8");
    writeFileSync(join(workspace, "two.txt"), "2", "utf8");

    const base = 1_700_000_000_000;
    safeDelete(workspace, "one.txt", () => base);
    safeDelete(workspace, "two.txt", () => base + 60_000);

    const entries = listTrash(workspace);
    expect(entries[0].originalPath).toBe(join(workspace, "two.txt"));
    expect(entries[1].originalPath).toBe(join(workspace, "one.txt"));
  });

  test("skips a corrupt entry", () => {
    const { workspace } = sandbox();
    writeFileSync(join(workspace, "ok.txt"), "x", "utf8");
    safeDelete(workspace, "ok.txt");
    mkdirSync(join(trashDir(workspace), "broken-entry"), { recursive: true });

    expect(listTrash(workspace)).toHaveLength(1);
  });

  test("returns empty when the store does not exist", () => {
    const { workspace } = sandbox();
    expect(listTrash(workspace)).toEqual([]);
  });
});

describe("ensureStore", () => {
  test("adds the gitignore line exactly once", () => {
    const { workspace } = sandbox();
    ensureStore(workspace);
    ensureStore(workspace);
    const lines = readFileSync(join(workspace, ".gitignore"), "utf8")
      .split("\n")
      .filter((line) => line.trim() === ".guardian-angel/");
    expect(lines).toHaveLength(1);
  });

  test("preserves existing gitignore content", () => {
    const { workspace } = sandbox();
    writeFileSync(join(workspace, ".gitignore"), "node_modules/\n", "utf8");
    ensureStore(workspace);
    const content = readFileSync(join(workspace, ".gitignore"), "utf8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(".guardian-angel/");
  });

  test("REGRESSION: restore refuses destination in protected path", () => {
    const { workspace } = sandbox();
    writeFileSync(join(workspace, "file.txt"), "hello", "utf8");
    const id = safeDelete(workspace, "file.txt");
    const metaPath = join(workspace, ".guardian-angel", "trash", id, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.originalPath = join(workspace, ".guardian-angel", "hacked.json");
    writeFileSync(metaPath, JSON.stringify(meta), "utf8");

    expect(() => restore(workspace, id)).toThrow("GA_TRASH_REFUSED");
  });
});

describe("cross-device EXDEV fallback and hash verification", () => {
  function makeExdevError() {
    const err = new Error("cross-device link not permitted");
    (err as any).code = "EXDEV";
    return err;
  }

  test("safeDelete falls back to verified copy+delete on EXDEV for a file", () => {
    const { workspace } = sandbox();
    const target = join(workspace, "mounted-drive-file.txt");
    const content = "crucial data across mount point boundary";
    writeFileSync(target, content, "utf8");

    const id = safeDelete(workspace, "mounted-drive-file.txt", Date.now, {
      renameSync: () => {
        throw makeExdevError();
      },
    });

    expect(existsSync(target)).toBe(false);

    const meta = JSON.parse(
      readFileSync(join(trashDir(workspace), id, "meta.json"), "utf8"),
    );
    expect(meta.copied).toBe(true);
    expect(meta.sha256).toBeDefined();

    const restored = restore(workspace, id);
    expect(restored).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(content);
    expect(listTrash(workspace)).toHaveLength(0);
  });

  test("safeDelete falls back to verified copy+delete on EXDEV for a directory", () => {
    const { workspace } = sandbox();
    const dir = join(workspace, "mounted-dir");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.ts"), "export const a = 1;", "utf8");
    writeFileSync(join(dir, "sub", "b.json"), JSON.stringify({ ok: true }), "utf8");

    const id = safeDelete(workspace, "mounted-dir", Date.now, {
      renameSync: () => {
        throw makeExdevError();
      },
    });

    expect(existsSync(dir)).toBe(false);

    const meta = JSON.parse(
      readFileSync(join(trashDir(workspace), id, "meta.json"), "utf8"),
    );
    expect(meta.copied).toBe(true);
    expect(meta.sha256).toBeDefined();

    restore(workspace, id);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("export const a = 1;");
    expect(readFileSync(join(dir, "sub", "b.json"), "utf8")).toBe(JSON.stringify({ ok: true }));
  });

  test("safeDelete cleans up and leaves source untouched if EXDEV copy verification fails", () => {
    const { workspace } = sandbox();
    const target = join(workspace, "precious.txt");
    const content = "do not lose me under any circumstances";
    writeFileSync(target, content, "utf8");

    expect(() =>
      safeDelete(workspace, "precious.txt", Date.now, {
        renameSync: () => {
          throw makeExdevError();
        },
        copyFileSync: (_src, dest) => {
          // Simulate corrupted or truncated copy
          writeFileSync(dest, "corrupted partial content", "utf8");
        },
      }),
    ).toThrow(/GA_TRASH_EXDEV_VERIFY/);

    // Source must be completely untouched and intact
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(content);

    // Trash must be cleaned up
    expect(listTrash(workspace)).toHaveLength(0);
  });

  test("restore falls back to copy+unlink when renameSync throws EXDEV", () => {
    const { workspace } = sandbox();
    const target = join(workspace, "restore-exdev.txt");
    const content = "content restored across filesystem boundary";
    writeFileSync(target, content, "utf8");

    const id = safeDelete(workspace, "restore-exdev.txt");

    const restored = restore(workspace, id, {
      renameSync: () => {
        throw makeExdevError();
      },
    });

    expect(restored).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(content);
    expect(listTrash(workspace)).toHaveLength(0);
  });

  test("restore refuses to restore if payload has been corrupted or tampered with", () => {
    const { workspace } = sandbox();
    const target = join(workspace, "tamper-check.txt");
    writeFileSync(target, "authentic original bytes", "utf8");

    const id = safeDelete(workspace, "tamper-check.txt");
    const payloadPath = join(trashDir(workspace), id, "payload");

    // Tamper with payload in trash
    writeFileSync(payloadPath, "tampered modified bytes", "utf8");

    expect(() => restore(workspace, id)).toThrow(/GA_TRASH_RESTORE_HASH_MISMATCH/);

    // Target must not be created with corrupted bytes
    expect(existsSync(target)).toBe(false);
  });

  test("safeDelete refuses directory containing a symlink during EXDEV copy", () => {
    const { workspace, outside } = sandbox();
    const dir = join(workspace, "dir-with-symlink");
    mkdirSync(dir, { recursive: true });
    const extFile = join(outside, "secret.txt");
    writeFileSync(extFile, "secret", "utf8");
    symlinkSync(extFile, join(dir, "link.txt"));

    expect(() =>
      safeDelete(workspace, "dir-with-symlink", Date.now, {
        renameSync: () => {
          throw makeExdevError();
        },
      }),
    ).toThrow(/GA_TRASH_REFUSED: symlink in dir/);

    expect(existsSync(dir)).toBe(true);
  });
});
