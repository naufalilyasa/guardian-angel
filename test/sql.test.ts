import { describe, expect, test } from "bun:test";
import { classifySql } from "../src/core/sql.ts";

function verdict(command: string): string | null {
  return classifySql(command)?.verdict ?? null;
}

describe("no SQL client", () => {
  test("returns null for a plain shell command", () => {
    expect(classifySql("ls -la")).toBeNull();
  });

  test("returns null for bash -c", () => {
    expect(classifySql('bash -c "echo hi"')).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(classifySql("")).toBeNull();
  });

  test("returns null for whitespace", () => {
    expect(classifySql("   \n\t")).toBeNull();
  });
});

describe("mysql -e", () => {
  test("blocks DROP DATABASE", () => {
    const result = classifySql('mysql -e "DROP DATABASE prod"');
    expect(result?.verdict).toBe("block");
  });

  test("allows SELECT", () => {
    expect(verdict('mysql -e "SELECT 1"')).toBe("allow");
  });

  test("asks for DELETE", () => {
    expect(verdict('mysql -e "DELETE FROM users"')).toBe("ask");
  });

  test("supports --execute", () => {
    expect(verdict('mysql --execute "TRUNCATE TABLE logs"')).toBe("block");
  });

  test("supports --execute=value", () => {
    expect(verdict('mysql --execute="ALTER TABLE t ADD c INT"')).toBe("block");
  });

  test("blocks lowercase drop", () => {
    expect(verdict('mysql -e "drop table t"')).toBe("block");
  });
});

describe("psql -c", () => {
  test("asks for DELETE", () => {
    expect(verdict('psql -c "DELETE FROM users"')).toBe("ask");
  });

  test("blocks DROP", () => {
    expect(verdict('psql -c "DROP TABLE users"')).toBe("block");
  });

  test("supports --command", () => {
    expect(verdict('psql --command "SELECT 1"')).toBe("allow");
  });
});

describe("sqlite3 positional SQL", () => {
  test("blocks DROP", () => {
    expect(verdict('sqlite3 app.db "DROP TABLE t"')).toBe("block");
  });

  test("allows SELECT", () => {
    expect(verdict('sqlite3 app.db "SELECT * FROM t"')).toBe("allow");
  });
});

describe("mongosh --eval", () => {
  test("asks for DELETE", () => {
    expect(verdict('mongosh --eval "db.users.deleteMany({})"')).toBe("ask");
  });
});

describe("stdin and files", () => {
  test("blocks DROP piped into mysql", () => {
    expect(verdict('echo "DROP TABLE t" | mysql')).toBe("block");
  });

  test("asks when SQL comes from a file redirect", () => {
    const result = classifySql("mysql < dump.sql");
    expect(result?.verdict).toBe("ask");
    expect(result?.reason).toBe("SQL dari file tidak dapat diperiksa");
  });

  test("asks for -f file", () => {
    expect(verdict("mysql -f script.sql")).toBe("ask");
  });

  test("blocks DROP in a heredoc", () => {
    const command = "mysql <<EOF\nDROP TABLE t;\nEOF";
    expect(verdict(command)).toBe("block");
  });
});

describe("statement classification", () => {
  test("allows SHOW and EXPLAIN", () => {
    expect(verdict('mysql -e "SHOW TABLES"')).toBe("allow");
    expect(verdict('mysql -e "EXPLAIN SELECT 1"')).toBe("allow");
  });

  test("asks for INSERT as unclassified", () => {
    const result = classifySql('mysql -e "INSERT INTO t VALUES (1)"');
    expect(result?.verdict).toBe("ask");
    expect(result?.reason).toBe("unclassified SQL");
  });

  test("marks DELETE without WHERE", () => {
    const result = classifySql('mysql -e "DELETE FROM users"');
    expect(result?.reason).toContain("tanpa WHERE");
  });

  test("does not mark DELETE with WHERE", () => {
    const result = classifySql('mysql -e "DELETE FROM users WHERE id = 1"');
    expect(result?.reason).not.toContain("tanpa WHERE");
  });

  test("multi-statement takes the most severe", () => {
    expect(verdict('mysql -e "SELECT 1; DROP TABLE t"')).toBe("block");
  });

  test("skips a leading comment", () => {
    expect(verdict('mysql -e "-- note\\nDROP TABLE t"')).toBe("block");
  });

  test("skips a block comment", () => {
    expect(verdict('mysql -e "/* note */ DROP TABLE t"')).toBe("block");
  });
});

describe("REGRESSION: every payload is classified, not just the first", () => {
  test("psql with two -c flags blocks on the second DROP", () => {
    expect(verdict('psql -c "SELECT 1" -c "DROP TABLE t"')).toBe("block");
  });

  test("mysql with two -e flags blocks on the second DROP", () => {
    expect(verdict('mysql -e "SELECT 1" -e "DROP TABLE t"')).toBe("block");
  });

  test("mysql mixes -e and --execute=", () => {
    expect(verdict('mysql -e "SELECT 1" --execute="ALTER TABLE t ADD c INT"')).toBe("block");
  });

  test("two benign payloads still ask rather than allow", () => {
    const result = classifySql('mysql -e "SELECT 1" -e "SELECT 2"');
    expect(result?.verdict).toBe("ask");
    expect(result?.reason).toContain("beberapa payload");
  });

  test("a single payload is unaffected", () => {
    expect(verdict('mysql -e "SELECT 1"')).toBe("allow");
  });

  test("a benign payload plus a file is still ask", () => {
    expect(verdict('mysql -e "SELECT 1" -f dump.sql')).toBe("ask");
  });

  test("a benign payload plus a redirect is still ask", () => {
    expect(verdict('mysql -e "SELECT 1" < dump.sql')).toBe("ask");
  });

  test("an allow verdict carries an accurate reason", () => {
    expect(classifySql('mysql -e "SELECT 1"')?.reason).toBe("SELECT read-only");
  });
});

describe("malformed input", () => {
  test("does not throw on an unterminated quote", () => {
    expect(() => classifySql('mysql -e "DROP TABLE t')).not.toThrow();
  });

  test("does not throw on an empty payload", () => {
    expect(() => classifySql('mysql -e ""')).not.toThrow();
  });

  test("asks when the client has no payload", () => {
    expect(verdict("mysql")).toBe("ask");
  });
});
