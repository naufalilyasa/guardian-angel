import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classify } from "../src/core/classifier.ts";
import { guard } from "../src/core/guard.ts";
import { createApprovalStore } from "../src/core/approvals.ts";
import type { AuditSink, GuardDeps } from "../src/core/types.ts";

describe("Script Content Gate (Batas 1)", () => {
  let ws: string;

  beforeEach(() => {
    ws = join(tmpdir(), `ga-script-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(ws, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {}
  });

  function classifyCmd(command: string) {
    return classify({ call: { toolName: "bash", input: { command } }, workspace: ws });
  }

  test("allows clean python script", () => {
    writeFileSync(join(ws, "app.py"), "print('hello from clean script')\n", "utf8");
    const res = classifyCmd("python3 app.py");
    expect(res.verdict).toBe("allow");
  });

  test("allows python module invocation without script file", () => {
    const res = classifyCmd("python3 -m pytest tests/");
    expect(res.verdict).toBe("allow");
  });

  test("allows missing script file to fail naturally in OS", () => {
    const res = classifyCmd("python3 nonexistent.py");
    expect(res.verdict).toBe("allow");
  });

  test("blocks python script tampering with .guardian-angel store via rmtree", () => {
    writeFileSync(
      join(ws, "payload.py"),
      "import shutil\nshutil.rmtree('.guardian-angel')\n",
      "utf8",
    );
    const res = classifyCmd("python3 payload.py");
    expect(res.verdict).toBe("block");
    expect(res.ruleId).toBe("block:protected-script");
  });

  test("blocks python script modifying .guardian-angel/audit.jsonl via open()", () => {
    writeFileSync(
      join(ws, "audit_tamper.py"),
      "open('.guardian-angel/audit.jsonl', 'w').write('[]')\n",
      "utf8",
    );
    const res = classifyCmd("python3 audit_tamper.py");
    expect(res.verdict).toBe("block");
    expect(res.ruleId).toBe("block:protected-script");
  });

  test("blocks python script removing .git/config via os.remove", () => {
    writeFileSync(
      join(ws, "git_tamper.py"),
      "import os\nos.remove('.git/config')\n",
      "utf8",
    );
    const res = classifyCmd("python3 git_tamper.py");
    expect(res.verdict).toBe("block");
    expect(res.ruleId).toBe("block:protected-script");
  });

  test("asks for script referencing .git without write verbs", () => {
    writeFileSync(
      join(ws, "check_git.py"),
      "print('Checking .git status')\n",
      "utf8",
    );
    const res = classifyCmd("python3 check_git.py");
    expect(res.verdict).toBe("ask");
    expect(res.ruleId).toBe("ask:script-protected");
    expect(res.scopePath).toBe(join(ws, "check_git.py"));
  });

  test("blocks python script containing destructive rm -rf /", () => {
    writeFileSync(
      join(ws, "wipe.py"),
      "import os\nos.system('rm -rf /')\n",
      "utf8",
    );
    const res = classifyCmd("python3 wipe.py");
    expect(res.verdict).toBe("block");
    expect(res.ruleId).toBe("block:script-destructive");
  });

  test("asks for python script containing obfuscated eval/exec base64", () => {
    writeFileSync(
      join(ws, "obf.py"),
      "import base64\nexec(base64.b64decode('cHJpbnQoMSk='))\n",
      "utf8",
    );
    const res = classifyCmd("python3 obf.py");
    expect(res.verdict).toBe("ask");
    expect(res.ruleId).toBe("ask:script-obfuscated");
    expect(res.scopePath).toBe(join(ws, "obf.py"));
  });

  test("allows eval in vendor / node_modules scripts", () => {
    const vendorDir = join(ws, "node_modules", "some-pkg");
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(join(vendorDir, "bundle.js"), "eval('console.log(1)')\n", "utf8");
    const res = classifyCmd("node node_modules/some-pkg/bundle.js");
    expect(res.verdict).toBe("allow");
  });

  test("blocks node.js script modifying approvals.json", () => {
    writeFileSync(
      join(ws, "forge.js"),
      "const fs = require('fs');\nfs.writeFileSync('.guardian-angel/approvals.json', '{}');\n",
      "utf8",
    );
    const res = classifyCmd("node forge.js");
    expect(res.verdict).toBe("block");
    expect(res.ruleId).toBe("block:protected-script");
  });

  test("blocks shell script with destructive rm -rf /", () => {
    writeFileSync(join(ws, "run.sh"), "rm -rf /\n", "utf8");
    const res = classifyCmd("bash run.sh");
    expect(res.verdict).toBe("block");
    expect(res.ruleId).toBe("block:script-destructive");
  });

  test("blocks direct shebang script modifying protected store", () => {
    writeFileSync(
      join(ws, "direct.sh"),
      "#!/bin/bash\nrm -rf .guardian-angel\n",
      "utf8",
    );
    const res = classifyCmd("./direct.sh");
    expect(res.verdict).toBe("block");
    expect(res.ruleId).toBe("block:protected-script");
  });

  test("asks for script located outside the workspace", () => {
    const res = classifyCmd("python3 /tmp/some_outside_script.py");
    expect(res.verdict).toBe("ask");
    expect(res.ruleId).toBe("ask:script-outside");
  });

  test("asks for binary file passed as script", () => {
    const binFile = join(ws, "binary.py");
    const buf = Buffer.alloc(100);
    buf[10] = 0; // NUL byte
    writeFileSync(binFile, buf);
    const res = classifyCmd("python3 binary.py");
    expect(res.verdict).toBe("ask");
    expect(res.ruleId).toBe("ask:script-uninspectable");
  });

  test("blocks script with ANSI-C encoded path when destructive", () => {
    writeFileSync(
      join(ws, "wipe.py"),
      "import os\nos.system('rm -rf /')\n",
      "utf8",
    );
    const res = classifyCmd("python3 $'wipe.py'");
    expect(res.verdict).toBe("block");
    expect(res.ruleId).toBe("block:script-destructive");
  });

  test("asks for script target with tilde expansion pointing outside workspace", () => {
    const res = classifyCmd("python3 ~/some_outside_script.py");
    expect(res.verdict).toBe("ask");
    expect(res.ruleId).toBe("ask:script-outside");
  });

  test("asks for script target with unresolvable shell variable expansion", () => {
    const res = classifyCmd("python3 $HOME/script.py");
    expect(res.verdict).toBe("ask");
    expect(res.ruleId).toBe("ask:script-unresolvable");
  });

  test("asks for symlinked script pointing outside the workspace", () => {
    const outsideTarget = "/tmp/outside_target.py";
    writeFileSync(outsideTarget, "print('outside')\n", "utf8");
    try {
      const linkPath = join(ws, "link.py");
      symlinkSync(outsideTarget, linkPath);
      const res = classifyCmd("python3 link.py");
      expect(res.verdict).toBe("ask");
      expect(res.ruleId).toBe("ask:script-outside");
    } finally {
      try {
        rmSync(outsideTarget, { force: true });
      } catch {}
    }
  });

  test("asks for script exceeding size limit", () => {
    const largeFile = join(ws, "large.py");
    const buf = Buffer.alloc(513 * 1024, 0x20); // 513KB of spaces
    writeFileSync(largeFile, buf);
    const res = classifyCmd("python3 large.py");
    expect(res.verdict).toBe("ask");
    expect(res.ruleId).toBe("ask:script-uninspectable");
  });

  test("asks for unreadable script file (permission denied)", () => {
    const unreadable = join(ws, "unreadable.py");
    writeFileSync(unreadable, "print('cant read')\n", "utf8");
    chmodSync(unreadable, 0o000);
    try {
      const res = classifyCmd("python3 unreadable.py");
      expect(res.verdict).toBe("ask");
      expect(res.ruleId).toBe("ask:script-uninspectable");
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });

  test("approval is scoped to the specific script path, not whole workspace", async () => {
    writeFileSync(
      join(ws, "script1.py"),
      "import base64\nexec(base64.b64decode('cHJpbnQoMSk='))\n",
      "utf8",
    );
    writeFileSync(
      join(ws, "script2.py"),
      "import base64\nexec(base64.b64decode('cHJpbnQoMik='))\n",
      "utf8",
    );

    const approvals = createApprovalStore({ workspace: ws });
    const auditEntries: any[] = [];
    const audit: AuditSink = { append: (e) => auditEntries.push(e) };
    const deps: GuardDeps = {
      workspace: ws,
      sessionId: "test-session",
      approvals,
      audit,
      now: () => Date.now(),
      policy: { rules: [] },
      confirm: async () => true, // User approves script1
    };

    // First call for script1 asks and user approves
    const res1 = await guard({ toolName: "bash", input: { command: "python3 script1.py" } }, deps);
    expect(res1.verdict).toBe("allow");

    // Second call for script1 reuses cached approval without confirm
    let confirmCalled = false;
    deps.confirm = async () => {
      confirmCalled = true;
      return true;
    };
    const res1Cached = await guard({ toolName: "bash", input: { command: "python3 script1.py" } }, deps);
    expect(res1Cached.verdict).toBe("allow");
    expect(confirmCalled).toBe(false);

    // Call for script2 must still ask because approval was scoped to script1!
    let script2Confirmed = false;
    deps.confirm = async () => {
      script2Confirmed = true;
      return true;
    };
    const res2 = await guard({ toolName: "bash", input: { command: "python3 script2.py" } }, deps);
    expect(res2.verdict).toBe("allow");
    expect(script2Confirmed).toBe(true);
  });
});
