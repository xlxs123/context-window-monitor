import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "smol-toml";
import { discoverProjects, ProjectActions } from "../runtime/core/index.mjs";

const execute = promisify(execFile);
const config = root => path.join(root, ".codex", "environments", "environment.toml");
async function fixture(context) {
  const directory = await mkdtemp(path.join(tmpdir(), "monitor-projects-"));
  const codexHome = path.join(directory, "codex");
  const dataDirectory = path.join(codexHome, "context-window-monitor");
  await mkdir(codexHome);
  const database = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  database.exec("CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, position INTEGER); CREATE TABLE project_roots(project_id TEXT, position INTEGER, path TEXT)");
  const add = async name => {
    const root = path.join(directory, name);
    await mkdir(root, { recursive: true });
    database.prepare("INSERT INTO projects VALUES (?, ?, 0)").run(name, name);
    database.prepare("INSERT INTO project_roots VALUES (?, 0, ?)").run(name, root);
    return root;
  };
  const remove = name => database.prepare("DELETE FROM projects WHERE id=?").run(name);
  const actions = new ProjectActions({ codexHome, dataDirectory, pluginRoot: path.resolve(".") });
  context.after(async () => { actions.stop(); database.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, codexHome, dataDirectory, database, add, remove, actions };
}

test("registered projects gain an idempotent action; additions and deletions preserve existing configuration", async context => {
  const f = await fixture(context);
  const first = await f.add("Project with spaces");
  const second = await f.add("项目二");
  const original = '# user comment\nversion = 1\nname = "Custom"\n[setup]\nscript = "echo setup"\n[[actions]]\nname = "Tests"\ncommand = "npm test"\n';
  await mkdir(path.dirname(config(first)), { recursive: true });
  await writeFile(config(first), original);
  let status = await f.actions.sync();
  assert.equal(status.configured, 2); assert.deepEqual(status.errors, []);
  const text = await readFile(config(first), "utf8");
  assert.ok(text.startsWith(original));
  const actions = parse(text).actions;
  assert.equal(actions.length, 2); assert.equal(actions[1].name, "上下文监控");
  assert.equal(actions[1].command.includes(first), false, "action must use the terminal working directory");
  const modified = (await stat(config(first))).mtimeMs;
  await f.actions.sync();
  assert.equal((await stat(config(first))).mtimeMs, modified);
  const third = await f.add("New project");
  f.remove("项目二");
  status = await f.actions.sync();
  assert.equal(status.configured, 2);
  await assert.rejects(readFile(config(second)), { code: "ENOENT" });
  assert.equal(parse(await readFile(config(third), "utf8")).actions.length, 1);
  f.remove("Project with spaces");
  await f.actions.sync();
  assert.equal(await readFile(config(first), "utf8"), original);
});

test("database is authoritative over stale saved roots, and malformed registry never removes actions", async context => {
  const f = await fixture(context);
  const root = await f.add("Active");
  await writeFile(path.join(f.codexHome, ".codex-global-state.json"), JSON.stringify({ "local-projects": { ghost: { name: "Deleted", rootPaths: [path.join(f.directory, "Deleted")] } }, "electron-saved-workspace-roots": ["/stale"] }));
  assert.deepEqual((await discoverProjects(f.codexHome)).projects.map(p => p.root), [root]);
  await f.actions.sync();
  const before = await readFile(config(root), "utf8");
  f.database.exec("ALTER TABLE project_roots RENAME TO invalid_roots");
  assert.equal((await f.actions.sync()).errors.length, 1);
  assert.equal(await readFile(config(root), "utf8"), before);
  f.database.exec("ALTER TABLE invalid_roots RENAME TO project_roots");
  f.remove("Active");
  assert.deepEqual((await discoverProjects(f.codexHome)).projects, []);
  await f.actions.sync();
  await assert.rejects(readFile(config(root)), { code: "ENOENT" });
});

test("unavailable roots retain ownership; user edits and escaping directory links are preserved", async context => {
  const f = await fixture(context);
  const root = await f.add("Removable");
  await f.actions.sync();
  await rename(root, root + "-offline");
  assert.equal((await f.actions.sync()).errors.length, 1);
  await rename(root + "-offline", root);
  assert.deepEqual((await f.actions.sync()).errors, []);
  const changed = (await readFile(config(root), "utf8")).replace('name = "上下文监控"', 'name = "My monitor"');
  await writeFile(config(root), changed);
  assert.equal((await f.actions.sync()).errors.length, 1);
  f.remove("Removable");
  await f.actions.sync();
  assert.equal(await readFile(config(root), "utf8"), changed);
  const linked = await f.add("Linked");
  const outside = path.join(f.directory, "outside"); await mkdir(outside);
  await symlink(outside, path.join(linked, ".codex"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.actions.sync()).errors.length, 1);
  await assert.rejects(stat(path.join(outside, "environments")), { code: "ENOENT" });
});

test("legacy local-projects fallback ignores stale history and does not guess missing registration", async context => {
  const directory = await mkdtemp(path.join(tmpdir(), "monitor-legacy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await discoverProjects(directory)).complete, false);
  const file = path.join(directory, ".codex-global-state.json");
  await writeFile(file, JSON.stringify({ "local-projects": {}, "electron-saved-workspace-roots": [directory] }));
  assert.deepEqual((await discoverProjects(directory)).projects, []);
  await writeFile(file, JSON.stringify({ "local-projects": { one: { name: "Project", rootPaths: [directory] } } }));
  assert.deepEqual((await discoverProjects(directory)).projects, [{ id: "one", name: "Project", root: directory }]);
});

test("CRLF editing keeps action ownership and offline deleted projects are cleaned when they return", async context => {
  const f = await fixture(context);
  const root = await f.add("Line endings");
  const original = 'version = 1\r\nname = "Existing"\r\n[setup]\r\nscript = ""\r\n';
  await mkdir(path.dirname(config(root)), { recursive: true });
  await writeFile(config(root), original);
  await f.actions.sync();
  const before = await readFile(config(root), "utf8");
  await writeFile(config(root), before.replace(/\r?\n/g, "\r\n").trimEnd());
  assert.deepEqual((await f.actions.sync()).errors, []);
  assert.equal(parse(await readFile(config(root), "utf8")).actions.length, 1);
  await rename(root, root + "-offline"); f.remove("Line endings");
  assert.equal((await f.actions.sync()).errors.length, 1);
  const ledger = JSON.parse(await readFile(path.join(f.dataDirectory, "project-actions.json"), "utf8"));
  assert.equal(ledger.files.length, 1);
  await rename(root + "-offline", root);
  assert.deepEqual((await f.actions.sync()).errors, []);
  assert.equal(await readFile(config(root), "utf8"), original);
});

test("Windows action invokes a literal plugin path containing shell metacharacters", { skip: process.platform !== "win32" }, async context => {
  const f = await fixture(context);
  const root = await f.add("Literal paths");
  const pluginRoot = path.join(f.directory, "$dollar `tick 'quote (spaces)");
  await mkdir(path.join(pluginRoot, "scripts"), { recursive: true });
  await writeFile(path.join(pluginRoot, "scripts", "open-dashboard.ps1"), 'Write-Output "literal-path-success"\n');
  const actions = new ProjectActions({ codexHome: f.codexHome, dataDirectory: f.dataDirectory, pluginRoot });
  await actions.sync();
  const command = parse(await readFile(config(root), "utf8")).actions[0].command;
  const result = await execute("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true, timeout: 10000 });
  assert.equal(result.stdout.trim(), "literal-path-success");
});

test("MCP startup creates actions without any tool calls and keeps following project changes", { timeout: 25000 }, async context => {
  const f = await fixture(context);
  const first = await f.add("Initial");
  const env = { ...process.env, CODEX_HOME: f.codexHome, CONTEXT_MONITOR_DATA: path.join(f.directory, "sessions"), CONTEXT_MONITOR_LAUNCHER_DATA: f.dataDirectory, CONTEXT_MONITOR_DISABLE_AUTO_PROJECTS: "0", CONTEXT_MONITOR_DISABLE_DESKTOP_ENTRY: "1" };
  const child = spawn(process.execPath, [path.resolve("runtime/mcp-server.mjs")], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.resume();
  const until = async predicate => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(100); }
    assert.fail("Automatic integration did not reach expected state");
  };
  try {
    await until(() => stat(config(first)).then(() => true, () => false));
    const state = JSON.parse(await readFile(path.join(f.dataDirectory, "launcher-0.5.0.json"), "utf8"));
    const health = () => fetch(state.url + "health").then(r => r.json());
    await until(async () => (await health()).projectIntegration.configured === 1);
    assert.equal(output, "", "auto initialization must not emit unsolicited MCP stdout");
    const second = await f.add("Added while running");
    await until(() => stat(config(second)).then(() => true, () => false));
    f.remove("Initial");
    await until(() => stat(config(first)).then(() => false, error => error.code === "ENOENT"));
    assert.equal((await health()).projectIntegration.projects, 1);
  } finally {
    child.kill();
    await execute(process.execPath, [path.resolve("runtime/open-dashboard.mjs"), "--stop"], { env, windowsHide: true, timeout: 5000 });
    await delay(200);
  }
});
