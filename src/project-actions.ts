import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { discoverProjects } from "./project-registry.js";

const BEGIN = "# BEGIN context-window-monitor managed action";
const END = "# END context-window-monitor managed action";
interface ManagedFile { root: string; file: string; block: string; created: boolean; base: string }
interface Ledger { files: ManagedFile[] }
export interface ProjectActionStatus { enabled: boolean; source: string; projects: number; configured: number; errors: string[]; updatedAt: string | null }
export interface ProjectActionOptions { codexHome?: string; dataDirectory?: string; pluginRoot: string; nodePath?: string; platform?: NodeJS.Platform }

const samePath = (a: string, b: string): boolean => path.relative(a, b) === "";
const exists = async (file: string): Promise<boolean> => fs.lstat(file).then(() => true).catch(error => {
  if (error.code === "ENOENT") return false;
  throw error;
});
async function atomicWrite(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text, { mode: 0o600 });
  try { await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => undefined); }
}
function managedSpan(text: string): { start: number; end: number; block: string } | null {
  const starts = [...text.matchAll(/^# BEGIN context-window-monitor managed action\r?\n/gmu)];
  if (!starts.length) {
    if (text.includes(BEGIN)) throw new Error("Invalid managed action boundary");
    return null;
  }
  if (starts.length !== 1) throw new Error("Duplicate managed action boundary");
  const start = starts[0]!.index;
  const ending = /^# END context-window-monitor managed action(?:\r?\n|$)/mu.exec(text.slice(start));
  if (!ending) throw new Error("Invalid managed action boundary");
  const end = start + ending.index + ending[0].length;
  return { start, end, block: text.slice(start, end) };
}
function sameBlock(a: string, b: string): boolean {
  const normalize = (value: string): string => value.replaceAll("\r\n", "\n").replace(/\n$/u, "");
  return normalize(a) === normalize(b);
}

export class ProjectActions {
  readonly status: ProjectActionStatus = { enabled: true, source: "pending", projects: 0, configured: 0, errors: [], updatedAt: null };
  private readonly codexHome: string;
  private readonly dataDirectory: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private readonly options: ProjectActionOptions) {
    this.codexHome = options.codexHome || process.env.CODEX_HOME || path.join(homedir(), ".codex");
    this.dataDirectory = options.dataDirectory || path.join(this.codexHome, "context-window-monitor");
  }
  start(): void {
    void this.sync();
    this.timer = setInterval(() => { void this.sync(); }, 3000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private actionBlock(): string {
    const platform = this.options.platform || process.platform;
    const quoted = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    // EncodedCommand is a shell-safe token even for paths containing $, quotes
    // or backticks. The PowerShell script uses a literal, single-quoted path.
    const windowsScript = `& '${path.join(this.options.pluginRoot, "scripts", "open-dashboard.ps1").replaceAll("'", "''")}'`;
    const command = platform === "win32"
      ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(windowsScript, "utf16le").toString("base64")}`
      : `${quoted(this.options.nodePath || process.execPath)} ${quoted(path.join(this.options.pluginRoot, "runtime", "open-dashboard.mjs"))}`;
    return `${BEGIN}\n[[actions]]\nname = "上下文监控"\nicon = "tool"\ncommand = ${JSON.stringify(command)}\nplatform = ${JSON.stringify(platform)}\n${END}\n`;
  }
  private async safeConfig(root: string, file: string): Promise<void> {
    const canonical = await fs.realpath(root);
    for (const candidate of [path.join(root, ".codex"), path.dirname(file), file]) {
      if (!await exists(candidate)) continue;
      const relative = path.relative(canonical, await fs.realpath(candidate));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Configuration path escapes project root");
    }
  }
  private async saveChanged(file: string, before: string, after: string, existed: boolean): Promise<void> {
    if (before === after) return;
    if (existed) {
      const backupDirectory = path.join(this.dataDirectory, "project-action-backups");
      await fs.mkdir(backupDirectory, { recursive: true });
      const hash = createHash("sha256").update(file).update(before).digest("hex");
      await fs.writeFile(path.join(backupDirectory, `${hash}.toml`), before, { flag: "wx", mode: 0o600 }).catch(error => { if (error.code !== "EEXIST") throw error; });
      if (await fs.readFile(file, "utf8") !== before) throw new Error("Configuration changed concurrently");
      await atomicWrite(file, after);
    } else {
      await fs.writeFile(file, after, { flag: "wx", mode: 0o600 });
    }
  }
  private async removeManaged(entry: ManagedFile): Promise<void> {
    if (!await exists(entry.root)) throw new Error("Project root unavailable; retry cleanup later");
    if (!await exists(entry.file)) return;
    const expected = path.join(entry.root, ".codex", "environments");
    if (!samePath(path.dirname(entry.file), expected)) throw new Error("Invalid managed path");
    await this.safeConfig(entry.root, entry.file);
    const before = await fs.readFile(entry.file, "utf8");
    parse(before);
    const span = managedSpan(before);
    // Only remove the exact block we wrote. User edits take precedence.
    if (!span || !sameBlock(span.block, entry.block)) return;
    const after = before.slice(0, span.start) + before.slice(span.end);
    parse(after);
    if (entry.created && after === entry.base) {
      if (await fs.readFile(entry.file, "utf8") !== before) throw new Error("Configuration changed concurrently");
      await fs.unlink(entry.file);
    } else await this.saveChanged(entry.file, before, after, true);
  }
  async sync(): Promise<ProjectActionStatus> {
    if (this.busy) return this.status;
    this.busy = true;
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
    const lockFile = path.join(this.dataDirectory, "project-actions.lock");
    try {
      await fs.mkdir(this.dataDirectory, { recursive: true });
      try { lock = await fs.open(lockFile, "wx"); await lock.writeFile(String(process.pid)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = Date.now() - (await fs.stat(lockFile)).mtimeMs;
        if (age > 30_000) {
          const pid = Number(await fs.readFile(lockFile, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") await fs.unlink(lockFile); }
          }
        }
        return this.status;
      }
      const snapshot = await discoverProjects(this.codexHome);
      this.status.source = snapshot.source;
      if (!snapshot.complete) throw new Error("Project registry unavailable; existing actions retained");
      const ownerFile = path.join(this.dataDirectory, "project-actions-owner.json");
      const owner = await fs.readFile(ownerFile, "utf8").then(value => JSON.parse(value)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (owner && owner.pid !== process.pid && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive && typeof owner.version === "string" && owner.version.localeCompare("0.4.1", undefined, { numeric: true }) >= 0) {
          this.status.enabled = false; this.status.source = "managed-by-running-service"; this.stop(); return this.status;
        }
      }
      if (!owner || owner.pid !== process.pid) await atomicWrite(ownerFile, JSON.stringify({ pid: process.pid, version: "0.4.1" }));
      const ledgerPath = path.join(this.dataDirectory, "project-actions.json");
      const ledger: Ledger = await fs.readFile(ledgerPath, "utf8").then(text => JSON.parse(text)).catch(error => {
        if (error.code === "ENOENT") return { files: [] };
        throw error;
      });
      if (!Array.isArray(ledger.files)) throw new Error("Invalid action ledger");
      const files: ManagedFile[] = [];
      const errors: string[] = [];
      const roots = [...new Set(snapshot.projects.map(project => project.root))];
      let configured = 0;
      for (const root of roots) {
        if (!await exists(root)) {
          files.push(...ledger.files.filter(entry => samePath(entry.root, root)));
          errors.push(`${path.basename(root)}: 项目目录暂时不可用`);
          continue;
        }
        try {
          const folder = path.join(root, ".codex", "environments");
          const candidates = await fs.readdir(folder).catch(error => { if (error.code === "ENOENT") return []; throw error; });
          const names = candidates.filter(name => name.endsWith(".toml"));
          if (!names.length) names.push("environment.toml");
          for (const name of names) {
            const file = path.join(folder, name);
            await this.safeConfig(root, file);
            const existed = await exists(file);
            const before = existed ? await fs.readFile(file, "utf8") : "";
            const document = parse(before);
            const previous = ledger.files.find(entry => samePath(entry.file, file));
            const span = managedSpan(before);
            if (span && (!previous || !sameBlock(span.block, previous.block))) throw new Error("Managed action edited externally");
            const actions = document.actions;
            if (actions !== undefined && !Array.isArray(actions)) throw new Error("Unsupported actions format");
            // Preserve a pre-existing functional monitor action without duplicating it.
            if (!span && Array.isArray(actions) && actions.some(action => typeof action === "object" && action !== null && String((action as Record<string, unknown>).command).includes("context-window-monitor") && /open-dashboard\.(ps1|mjs)/u.test(String((action as Record<string, unknown>).command)))) { configured++; continue; }
            const base = span ? before.slice(0, span.start) + before.slice(span.end) : before || `version = 1\nname = ${JSON.stringify(path.basename(root))}\n\n[setup]\nscript = ""\n`;
            const prefix = base.endsWith("\n") ? base : `${base}\n`;
            const block = this.actionBlock();
            const after = `${prefix}${block}`;
            // Parsing validates duplicates/inline actions before touching the original.
            const updated = parse(after);
            if (!Array.isArray(updated.actions)) throw new Error("Action insertion failed");
            await fs.mkdir(folder, { recursive: true });
            await this.safeConfig(root, file);
            await this.saveChanged(file, before, after, existed);
            files.push({ root, file, block, created: previous?.created ?? !existed, base: previous?.base ?? prefix });
            configured++;
          }
        } catch { errors.push(`${path.basename(root)}: 无法安全更新项目操作，已保留现有配置`); files.push(...ledger.files.filter(entry => samePath(entry.root, root) && !files.some(known => samePath(known.file, entry.file)))); }
      }
      for (const entry of ledger.files) {
        if (roots.some(root => samePath(root, entry.root))) continue;
        try { await this.removeManaged(entry); }
        catch { errors.push(`${path.basename(entry.root)}: 暂时无法清理旧入口`); files.push(entry); }
      }
      const next = JSON.stringify({ files });
      if (JSON.stringify(ledger) !== next) await atomicWrite(ledgerPath, next);
      Object.assign(this.status, { projects: roots.length, configured, errors, updatedAt: new Date().toISOString() });
    } catch (error) {
      this.status.errors = [error instanceof Error && error.message.startsWith("Project registry unavailable") ? error.message : "项目注册表读取失败；保留现有配置并稍后重试"];
    } finally {
      if (lock) { await lock.close(); await fs.unlink(lockFile).catch(() => undefined); }
      this.busy = false;
    }
    return this.status;
  }
}
