import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ContextMonitorService } from "./context-monitor-service.js";
import { startDashboard } from "./dashboard-server.js";
import { RolloutContextProvider } from "./providers/rollout-context-provider.js";
import { ProjectActions } from "./project-actions.js";

const VERSION = "0.4.0";
const dataDirectory = process.env.CONTEXT_MONITOR_LAUNCHER_DATA || path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "context-window-monitor");
const statePath = path.join(dataDirectory, `launcher-${VERSION}.json`);
const lockPath = path.join(dataDirectory, `launcher-${VERSION}.lock`);
interface ServerState { version: string; pid: number; url: string }

function localUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port && !url.username && !url.password && /^\/[a-f0-9]{48}\/$/u.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

async function runningServer(): Promise<ServerState | null> {
  try {
    const state: ServerState = JSON.parse(await readFile(statePath, "utf8"));
    if (state.version !== VERSION || !Number.isSafeInteger(state.pid) || state.pid <= 0 || !localUrl(state.url)) return null;
    const response = await fetch(`${state.url}health`, { signal: AbortSignal.timeout(700), redirect: "error" });
    const health = await response.json();
    return response.ok && health.application === "context-window-monitor" && health.version === VERSION && health.pid === state.pid ? state : null;
  } catch { return null; }
}

async function ensureServer(): Promise<ServerState> {
  await mkdir(dataDirectory, { recursive: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const existing = await runningServer();
    if (existing) return existing;
    let lock;
    try { lock = await open(lockPath, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Recover an abandoned startup lock; never terminate an unrelated PID.
      try { if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await unlink(lockPath); } catch { /* Another launcher may have just released it. */ }
      await delay(100);
      continue;
    }
    try {
      const recheck = await runningServer();
      if (recheck) return recheck;
      const launcher = fileURLToPath(import.meta.url);
      // ShellExecute through Start-Process prevents a daemon inheriting WinPS 5.1
      // pipeline handles. Direct detached spawn can otherwise hold the pipe open.
      const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
      const command = process.platform === "win32"
        ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : process.execPath;
      const windowsCommand = `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(`"${launcher}" --serve`)} -WindowStyle Hidden -ErrorAction Stop`;
      const arguments_ = process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsCommand, "utf16le").toString("base64")]
        : [launcher, "--serve"];
      const child = spawn(command, arguments_, { detached: process.platform !== "win32", windowsHide: true, stdio: "ignore", env: process.env });
      let spawnError: Error | undefined;
      child.on("error", error => { spawnError = error; });
      child.unref();
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null && (process.platform !== "win32" || child.exitCode !== 0)) throw new Error(`Dashboard exited during startup (${child.exitCode}).`);
        const ready = await runningServer();
        if (ready) return ready;
        await delay(100);
      }
      throw new Error("Dashboard startup timed out. Please click the action again.");
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new Error("Another dashboard launch is still in progress. Please retry shortly.");
}

async function serve(): Promise<void> {
  const provider = new RolloutContextProvider();
  const actions = new ProjectActions({ pluginRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), dataDirectory });
  if (process.env.CONTEXT_MONITOR_DISABLE_AUTO_PROJECTS !== "1") actions.start();
  else actions.status.enabled = false;
  const server = await startDashboard(new ContextMonitorService(provider), provider, () => actions.status);
  const state: ServerState = { version: VERSION, pid: process.pid, url: server.url };
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, statePath);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    actions.stop();
    void server.close().then(async () => {
      const saved = await readFile(statePath, "utf8").catch(() => "{}");
      if (JSON.parse(saved).pid === process.pid) await unlink(statePath).catch(() => undefined);
      process.exit(0);
    });
  });
}

async function openBrowser(url: string): Promise<void> {
  // No shell interpolation; the URL originates from a verified loopback service.
  const command = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : process.platform === "darwin" ? "open" : "xdg-open";
  const openCommand = `Start-Process -FilePath '${url.replaceAll("'", "''")}' -ErrorAction Stop`;
  const args = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(openCommand, "utf16le").toString("base64")] : [url];
  const child = spawn(command, args, { detached: process.platform !== "win32", windowsHide: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Browser launcher exited (${code}).`)));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--serve")) { await serve(); return; }
  if (args.includes("--ensure")) { const server = await ensureServer(); console.log(JSON.stringify({ url: server.url, pid: server.pid })); return; }
  if (args.includes("--stop")) {
    const server = await runningServer();
    if (server) process.kill(server.pid, "SIGTERM");
    console.log(server ? "Dashboard stopped." : "No running dashboard.");
    return;
  }
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const result = args[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`Missing ${flag} value.`);
    return result;
  };
  const requested = value("--session");
  if (requested && !/^[a-zA-Z0-9_-]{1,128}$/u.test(requested)) throw new Error("Invalid session ID.");
  const started = performance.now();
  const provider = new RolloutContextProvider();
  const [server, session] = await Promise.all([
    ensureServer(),
    requested ? Promise.resolve(requested) : provider.latestSessionForDirectory(value("--cwd") || process.cwd()),
  ]);
  const url = new URL(server.url);
  url.searchParams.set("session", session || "no-session-for-project");
  if (!requested) url.searchParams.set("selection", session ? "recent-project" : "no-project-session");
  if (!args.includes("--no-open")) await openBrowser(url.href);
  console.log(JSON.stringify({ url: url.href, pid: server.pid, sessionId: session, startupMs: Math.round(performance.now() - started) }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
