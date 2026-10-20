import { describe, expect, test } from "bun:test";
import { classify } from "../src/core/classifier.ts";

const WS = "/ws";

function verdictOf(command: string) {
  return classify({ call: { toolName: "bash", input: { command } }, workspace: WS });
}

/**
 * Inline interpreter code (`python3 -c`, `node -e`, ...) cannot be inspected
 * deterministically. Proven by the Atria-Dawn pentest: a base64 executescript
 * payload wiped production.db, `open(...).write(...)` erased the audit trail
 * and `shutil.rmtree('.guardian-angel')` deleted the store — all with verdict
 * `allow` and zero confirmation.
 */
describe("inline interpreter code is uninspectable", () => {
  const askCases: Array<[string, string]> = [
    [`python3 -c "print('hi')"`, "plain python -c"],
    [`python3 -c "import sqlite3,base64;c=sqlite3.connect('production.db');c.executescript(base64.b64decode('REVMRVRFIEZST00gdXNlcnM7').decode());c.commit()"`, "pentest base64 SQL payload"],
    [`python3 -c "open('production.db','ab').write(b'\\x00'*100)"`, "pentest binary db corruption"],
    [`node -e 'console.log(1)'`, "node -e"],
    [`node --eval 'console.log(1)'`, "node --eval"],
    [`node --eval='console.log(1)'`, "node --eval=code"],
    [`node -p 'process.version'`, "node -p"],
    [`bun -e 'console.log(1)'`, "bun -e"],
    [`perl -e 'print 1'`, "perl -e"],
    [`perl -E 'say 1'`, "perl -E"],
    [`ruby -e 'puts 1'`, "ruby -e"],
    [`php -r 'echo 1;'`, "php -r"],
    [`lua -e 'print(1)'`, "lua -e"],
    [`Rscript -e 'print(1)'`, "Rscript -e"],
    [`osascript -e 'display dialog "x"'`, "osascript -e"],
    [`deno eval 'console.log(1)'`, "deno eval"],
    [`python3.11 -c "print(1)"`, "version-suffixed interpreter"],
    [`/usr/bin/python3 -c "print(1)"`, "absolute path to interpreter"],
    [`env python3 -c "print(1)"`, "env launcher before interpreter"],
    [`nice python3 -c "print(1)"`, "nice launcher before interpreter"],
    [`bash -c "python3 -c 'print(1)'"`, "interpreter behind bash -c wrapper"],
    [`echo hi; python3 -c "print(1)"`, "interpreter as second segment"],
  ];

  for (const [command, label] of askCases) {
    test(`asks for ${label}: ${command}`, () => {
      const result = verdictOf(command);
      expect(result.verdict).toBe("ask");
      expect(result.reason).toBeTruthy();
    });
  }
});

describe("inline interpreter code touching the protected store is blocked", () => {
  const blockCases: Array<[string, string]> = [
    [`python3 -c "open('.guardian-angel/audit.jsonl','w').write('[]')"`, "pentest audit wipe"],
    [`python3 -c "import shutil;shutil.rmtree('.guardian-angel')"`, "pentest store delete"],
    [`python3 -c "import shutil;shutil.rmtree('.git')"`, "pentest git delete"],
    [`node -e "fs.writeFileSync('.guardian-angel/approvals.json','{}')"`, "forged approvals via node"],
    [`bun -e 'Bun.write(".guardian-angel/approvals.json","{}")'`, "forged approvals via bun"],
    [`bash -c "python3 -c 'open(\\".guardian-angel/audit.jsonl\\",\\"w\\").write(\\"x\\")'"`, "wrapped interpreter store write"],
  ];

  for (const [command, label] of blockCases) {
    test(`blocks ${label}: ${command}`, () => {
      const result = verdictOf(command);
      expect(result.verdict).toBe("block");
      expect(result.reason).toBeTruthy();
    });
  }
});

describe("interpreter usage without inline code stays allowed", () => {
  const allowCases: Array<[string, string]> = [
    ["python3 script.py", "script file (documented corpus bypass)"],
    ["python3 -m pytest", "module flag"],
    ["python3 --version", "version flag"],
    ["node server.js", "node script file"],
    ["bun test", "bun subcommand"],
    ["deno run --allow-net app.ts", "deno run"],
    ["perl script.pl", "perl script file"],
    ["ruby script.rb", "ruby script file"],
    ["php script.php", "php script file"],
    ["python3 -c", "flag without payload"],
    ["python3 -c \"\"", "empty payload"],
  ];

  for (const [command, label] of allowCases) {
    test(`allows ${label}: ${command}`, () => {
      expect(verdictOf(command).verdict).toBe("allow");
    });
  }
});

describe("interpreter ask does not weaken existing rules", () => {
  test("plain-text rm -rf / inside an interpreter payload still blocks", () => {
    expect(verdictOf(`python3 -c "import os; os.system('rm -rf /')"`).verdict).toBe("block");
  });

  test("chained rm next to interpreter code still blocks", () => {
    expect(verdictOf(`python3 -c "print(1)" && rm ./file`).verdict).toBe("block");
  });

  test("sudo plus interpreter still asks", () => {
    expect(verdictOf(`sudo python3 -c "print(1)"`).verdict).toBe("ask");
  });
});
