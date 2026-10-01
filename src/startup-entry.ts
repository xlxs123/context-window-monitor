import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/** Per-user login recovery; the bootstrap resolves the installed plugin afresh. */
export async function ensureStartupEntry(pluginRoot: string): Promise<unknown> {
  if (process.platform !== "win32" || process.env.CONTEXT_MONITOR_DISABLE_DESKTOP_ENTRY === "1" || process.env.CONTEXT_MONITOR_DISABLE_LOGIN_STARTUP === "1") return null;
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(pluginRoot, "scripts", "configure-startup.ps1"), "-NodePath", process.execPath,
    "-CodexHome", process.env.CODEX_HOME || path.join(homedir(), ".codex")], { windowsHide: true, timeout: 15_000 });
  return JSON.parse(stdout);
}
