import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface DesktopEntryState {
  application: string; version: string; pid: number; instanceId: string;
  updatedAt: string; visible: boolean; hotkeyRegistered: boolean; hotkey: string;
  hotkeyError: number; lastLaunchAt: string | null; lastError: string | null;
}

export async function readDesktopEntry(directory: string): Promise<DesktopEntryState | null> {
  try {
    const value: DesktopEntryState = JSON.parse(await readFile(path.join(directory, "desktop-entry.json"), "utf8"));
    if (value.application !== "context-window-monitor" || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      !/^[a-f0-9]{32}$/u.test(value.instanceId) || Date.now() - Date.parse(value.updatedAt) > 15_000 ||
      !Number.isFinite(Date.parse(value.updatedAt))) return null;
    process.kill(value.pid, 0);
    return value;
  } catch { return null; }
}

export async function stopDesktopEntry(directory: string): Promise<void> {
  const entry = await readDesktopEntry(directory);
  if (entry) await writeFile(path.join(directory, `desktop-stop-${entry.instanceId}`), "stop", { mode: 0o600 });
}

/** Own tray UI only. Never reads or operates other application windows. */
export async function ensureDesktopEntry(directory: string, pluginRoot: string, version: string): Promise<DesktopEntryState | null> {
  if (process.platform !== "win32" || process.env.CONTEXT_MONITOR_DISABLE_DESKTOP_ENTRY === "1") return null;
  const existing = await readDesktopEntry(directory);
  if (existing?.version === version) return existing;
  if (existing) {
    await stopDesktopEntry(directory);
    for (let attempt = 0; attempt < 20 && await readDesktopEntry(directory); attempt++) await delay(100);
  }
  await mkdir(directory, { recursive: true });
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = path.join(pluginRoot, "scripts", "desktop-entry.ps1");
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const quoteArgument = (value: string): string => `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
  const arguments_ = ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script,
    "-DataDirectory", directory, "-NodePath", process.execPath, "-Version", version].map(quoteArgument).join(" ");
  const command = `Start-Process -FilePath ${literal(powershell)} -ArgumentList ${literal(arguments_)} -WindowStyle Hidden -ErrorAction Stop`;
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    windowsHide: true, stdio: "ignore", env: process.env,
  });
  let failure: Error | undefined;
  child.on("error", error => { failure = error; });
  child.unref();
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error("Tray launcher could not start.");
    const entry = await readDesktopEntry(directory);
    if (entry?.version === version && entry.visible) return entry;
    await delay(100);
  }
  throw new Error("Tray startup timed out. The dashboard service is still available.");
}
