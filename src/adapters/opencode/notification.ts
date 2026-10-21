import { spawn } from "node:child_process";

export interface DesktopNotification {
  title: string;
  message: string;
}

/**
 * Send an OS-level desktop notification to the user's laptop.
 * Supports macOS (osascript with Ping sound) and Linux (notify-send).
 * Non-blocking, detached, and fire-and-forget so failures never break dialog flow.
 */
export function notifyDesktop(
  notification: DesktopNotification,
  platform = process.platform,
  spawner = spawn,
): void {
  try {
    if (platform === "darwin") {
      const script = `display notification ${JSON.stringify(notification.message)} with title ${JSON.stringify(notification.title)} sound name "Ping"`;
      const proc = spawner("osascript", ["-e", script], {
        stdio: "ignore",
        detached: true,
      });
      proc.on?.("error", () => {});
      proc.unref?.();
    } else if (platform === "linux") {
      const proc = spawner("notify-send", [notification.title, notification.message], {
        stdio: "ignore",
        detached: true,
      });
      proc.on?.("error", () => {});
      proc.unref?.();
    }
  } catch {
    // Non-fatal fire-and-forget
  }
}
