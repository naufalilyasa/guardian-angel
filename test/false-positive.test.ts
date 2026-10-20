import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../src/core/classifier.ts";

/**
 * REGRESSION: false positives that made the guard unusable in real sessions.
 *
 * Three separate parser gaps all produced `block` for commands that never
 * touch a protected path:
 *
 * 1. Quoted heredoc bodies (`<< 'EOF'`) were scanned as live shell, so writing
 *    a test file whose *contents* mention `>` or `rm -rf /` was blocked.
 * 2. Single-quoted arguments were scanned for `$` expansion, so `sed -n
 *    '/x/,$p'` (where `$` means "last line") tripped the dynamic-target rule.
 * 3. `sed` was treated as a write verb even without `-i`, so read-only
 *    pipelines and even reads of the audit log were blocked — contradicting
 *    the documented "reading the store stays allow" behaviour.
 */

const WS = mkdtempSync(join(tmpdir(), "ga-fp-"));
writeFileSync(join(WS, "canary.txt"), "ORIGINAL", "utf8");
mkdirSync(join(WS, ".guardian-angel"), { recursive: true });
writeFileSync(join(WS, ".guardian-angel", "audit.jsonl"), "{}\n", "utf8");

function run(command: string) {
  return classify({ call: { toolName: "bash", input: { command } }, workspace: WS });
}

describe("REGRESSION: quoted heredoc bodies are inert text, not shell", () => {
  test("single-quoted heredoc delimiter makes the body inert", () => {
    const command = [
      "cat > notes.txt << 'EOF'",
      "rm -rf /",
      "DROP TABLE users;",
      "echo hi > /etc/passwd",
      "EOF",
    ].join("\n");
    expect(run(command).verdict).toBe("allow");
  });

  test("double-quoted heredoc delimiter is also inert for redirections", () => {
    const command = ['cat > notes.txt << "EOF"', "echo x > /outside/y", "EOF"].join("\n");
    expect(run(command).verdict).toBe("allow");
  });

  test("the heredoc's own redirect target is still classified", () => {
    const command = ["cat > .guardian-angel/audit.jsonl << 'EOF'", "harmless", "EOF"].join("\n");
    expect(run(command).verdict).toBe("block");
  });

  test("unquoted heredoc delimiter still expands, so it stays guarded", () => {
    const command = ["cat > x.sh << EOF", "rm -rf /", "EOF"].join("\n");
    expect(run(command).verdict).not.toBe("allow");
  });
});

describe("REGRESSION: single-quoted arguments never expand $ or backticks", () => {
  test("sed address range using $p is not a dynamic target", () => {
    expect(run(`sed -n '/^function Prompt/,$p' file.txt`).verdict).toBe("allow");
  });

  test("awk field reference $1 is not a dynamic target", () => {
    expect(run(`awk '{print $1}' file.txt`).verdict).toBe("allow");
  });

  test("grep pattern containing $ is not a dynamic target", () => {
    expect(run(`grep -n '$foo' file.txt`).verdict).toBe("allow");
  });

  test("backtick inside single quotes is literal", () => {
    expect(run("grep -n '`literal`' file.txt").verdict).toBe("allow");
  });

  test("double quotes still expand, so $ stays dangerous there", () => {
    expect(run(`sed -i "s/a/$HOME/" canary.txt`).verdict).not.toBe("allow");
  });
});

describe("REGRESSION: sed only writes with -i / --in-place", () => {
  test("read-only sed pipeline is allowed", () => {
    expect(run(`curl -s https://example.com/x | sed -n '1,10p' | head -5`).verdict).toBe("allow");
  });

  test("reading the audit log with sed is allowed", () => {
    expect(run(`sed -n '1,5p' .guardian-angel/audit.jsonl`).verdict).toBe("allow");
  });

  test("sed -i on an existing file still asks", () => {
    expect(run(`sed -i 's/a/b/' canary.txt`).ruleId).toBe("ask:overwrite");
  });

  test("sed -i on the store is still blocked", () => {
    expect(run(`sed -i 's/a/b/' .guardian-angel/audit.jsonl`).verdict).toBe("block");
  });

  test("sed --in-place on the store is still blocked", () => {
    expect(run(`sed --in-place 's/a/b/' .guardian-angel/audit.jsonl`).verdict).toBe("block");
  });
});
