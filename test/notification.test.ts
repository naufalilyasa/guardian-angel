import { describe, expect, test } from "bun:test";
import { notifyDesktop } from "../src/adapters/opencode/notification.ts";

describe("notifyDesktop", () => {
  test("triggers osascript notification on macOS (darwin)", () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let unrefCalled = false;

    const mockSpawner: any = (cmd: string, args: string[]) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return {
        unref: () => {
          unrefCalled = true;
        },
      };
    };

    notifyDesktop(
      {
        title: "Guardian Angel",
        message: "Command: git push origin main",
      },
      "darwin",
      mockSpawner,
    );

    expect(capturedCmd).toBe("osascript");
    expect(capturedArgs[0]).toBe("-e");
    expect(capturedArgs[1]).toContain('display notification "Command: git push origin main"');
    expect(capturedArgs[1]).toContain('with title "Guardian Angel"');
    expect(capturedArgs[1]).toContain('sound name "Ping"');
    expect(unrefCalled).toBe(true);
  });

  test("triggers notify-send on Linux", () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let unrefCalled = false;

    const mockSpawner: any = (cmd: string, args: string[]) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return {
        unref: () => {
          unrefCalled = true;
        },
      };
    };

    notifyDesktop(
      {
        title: "Guardian Angel",
        message: "Command: rm -rf /outside",
      },
      "linux",
      mockSpawner,
    );

    expect(capturedCmd).toBe("notify-send");
    expect(capturedArgs).toEqual(["Guardian Angel", "Command: rm -rf /outside"]);
    expect(unrefCalled).toBe(true);
  });

  test("does nothing on unsupported platforms without throwing", () => {
    let called = false;
    const mockSpawner: any = () => {
      called = true;
    };

    notifyDesktop({ title: "t", message: "m" }, "win32" as any, mockSpawner);
    expect(called).toBe(false);
  });

  test("catches spawner exceptions gracefully without throwing", () => {
    const errorSpawner: any = () => {
      throw new Error("spawn failed");
    };

    expect(() => {
      notifyDesktop({ title: "t", message: "m" }, "darwin", errorSpawner);
    }).not.toThrow();
  });
});
