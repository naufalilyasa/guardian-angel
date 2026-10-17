import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

    const { rmSync } = require("node:fs") as typeof import("node:fs");
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
    const { rmSync } = require("node:fs") as typeof import("node:fs");
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
});
