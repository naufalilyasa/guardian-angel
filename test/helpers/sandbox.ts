import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInSandbox } from "../src/core/paths.ts";

export type Sandbox = {
  root: string;
  workspace: string;
  outside: string;
  cleanup: () => void;
};

export function makeSandbox(prefix = "ga-test-"): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "ws");
  const outside = join(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });

  return {
    root,
    workspace,
    outside,
    cleanup: () => {
      const { rmSync } = require("node:fs") as typeof import("node:fs");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function makeCanary(dir: string, name = "canary.txt"): string {
  const path = join(dir, name);
  writeFileSync(path, "canary-intact\n", "utf8");
  return path;
}

export function assertSandboxed(path: string, sandbox: Sandbox): void {
  assertInSandbox(path, sandbox.root);
}
