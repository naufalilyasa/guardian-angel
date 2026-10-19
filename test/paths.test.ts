import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertInSandbox,
  isInsideWorkspace,
  resolveLexical,
  resolvePhysical,
} from "../src/core/paths.ts";

describe("isInsideWorkspace", () => {
  const cases: Array<{ candidate: string; expected: boolean; label: string }> = [
    { candidate: "/ws/a", expected: true, label: "direct child" },
    { candidate: "/ws/a/b", expected: true, label: "nested child" },
    { candidate: "/ws/a/../b", expected: true, label: "dot-dot stays inside" },
    { candidate: "/ws", expected: false, label: "workspace root itself" },
    { candidate: "/ws/", expected: false, label: "workspace root with slash" },
    { candidate: "/ws/..", expected: false, label: "parent of workspace" },
    { candidate: "/ws/../etc", expected: false, label: "traversal outside" },
    { candidate: "/etc/passwd", expected: false, label: "absolute outside" },
    { candidate: "/ws-other/x", expected: false, label: "sibling prefix" },
    { candidate: "", expected: false, label: "empty input" },
    { candidate: ".", expected: false, label: "dot resolves to root" },
  ];

  for (const { candidate, expected, label } of cases) {
    test(`${label}: ${JSON.stringify(candidate)} -> ${expected}`, () => {
      expect(isInsideWorkspace("/ws", candidate)).toBe(expected);
    });
  }
});

describe("resolveLexical", () => {
  test("normalizes traversal from an absolute input", () => {
    expect(resolveLexical("/ws", "/ws/../etc")).toBe("/etc");
  });

  test("keeps an absolute input outside the workspace", () => {
    expect(resolveLexical("/ws", "/etc/passwd")).toBe("/etc/passwd");
  });

  test("resolves a relative input against the workspace", () => {
    expect(resolveLexical("/ws", "a/../b")).toBe("/ws/b");
  });

  test("empty input resolves to the workspace", () => {
    expect(resolveLexical("/ws", "")).toBe("/ws");
  });

  test("dot-dot-only input resolves to the parent", () => {
    expect(resolveLexical("/ws", "..")).toBe("/");
  });
});

describe("assertInSandbox", () => {
  test("passes for a path inside the sandbox", () => {
    expect(() => assertInSandbox("/ws/a/b", "/ws")).not.toThrow();
  });

  test("throws for a path outside the sandbox", () => {
    expect(() => assertInSandbox("/etc/passwd", "/ws")).toThrow(
      /^GA_SANDBOX_VIOLATION:/,
    );
  });

  test("throws for the sandbox root itself", () => {
    expect(() => assertInSandbox("/ws", "/ws")).toThrow(
      /^GA_SANDBOX_VIOLATION:/,
    );
  });

  test("throws for traversal escaping the sandbox", () => {
    expect(() => assertInSandbox("/ws/../etc", "/ws")).toThrow(
      /^GA_SANDBOX_VIOLATION:/,
    );
  });

  test("throws for a sibling-prefix path", () => {
    expect(() => assertInSandbox("/ws-other/x", "/ws")).toThrow(
      /^GA_SANDBOX_VIOLATION:/,
    );
  });
});

describe("resolvePhysical", () => {
  test("REGRESSION: handles symlink cycles without infinite loop or hanging", () => {
    const ws = mkdtempSync(join(tmpdir(), "ga-symlink-cycle-"));
    symlinkSync("loop", join(ws, "loop"));

    const start = Date.now();
    const resolved = resolvePhysical(ws, "loop/child.txt");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(resolved).toBeDefined();

    rmSync(ws, { recursive: true, force: true });
  });
});
