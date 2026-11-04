import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";
import { RolloutContextProvider, SessionRegistry } from "../runtime/core/index.mjs";

async function moduleOf(entry) {
  const result = await build({entryPoints:[entry],bundle:true,write:false,platform:"node",format:"esm",logLevel:"silent"});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { sessionLabel } = await moduleOf("src/ui/session-label.ts");
const { sessionTitles } = await moduleOf("src/providers/session-titles.ts");

test("session names use the newest database, follow renames and survive missing/old schemas", async context => {
  const directory = await mkdtemp(path.join(tmpdir(), "monitor-titles-"));
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  context.after(async () => {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await rm(directory, {recursive:true,force:true});
  });
  assert.equal((await sessionTitles(["one"])).size, 0);
  const old = new DatabaseSync(path.join(directory, "state_5.sqlite"));
  old.exec("CREATE TABLE threads(id TEXT, title TEXT); INSERT INTO threads VALUES('one','旧版标题')");
  old.close();
  assert.equal((await sessionTitles(["one"])).get("one"), "旧版标题");
  const db = new DatabaseSync(path.join(directory, "state_10.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT, title TEXT, name TEXT)");
  const id = "11111111-2222-4333-8444-555555555555";
  db.prepare("INSERT INTO threads VALUES(?,?,?)").run(id, "原始提示词", "安装上下文监控插件");
  db.prepare("INSERT INTO threads VALUES(?,?,?)").run("blank", "回退标题", "   ");
  assert.equal((await sessionTitles([id])).get(id), "安装上下文监控插件");
  assert.equal((await sessionTitles(["blank"])).get("blank"), "回退标题");
  assert.equal((await sessionTitles(["missing"])).size, 0);
  db.prepare("UPDATE threads SET name=? WHERE id=?").run("改名后的聊天", id);
  assert.equal((await sessionTitles([id])).get(id), "改名后的聊天");
  const sessions = path.join(directory, "sessions", "2026", "10", "22");
  await mkdir(sessions, {recursive:true});
  await writeFile(path.join(sessions, `rollout-${id}.jsonl`), JSON.stringify({type:"session_meta",payload:{id,cwd:directory}})+"\n");
  const provider = new RolloutContextProvider(new SessionRegistry(path.join(directory, "monitor")));
  const rows = await provider.listSessions();
  assert.equal(rows.find(row => row.sessionId === id)?.title, "改名后的聊天");
  db.exec("DROP TABLE threads");
  assert.equal((await sessionTitles([id])).size, 0);
  db.close();
});

test("session labels prefer titles, distinguish duplicates and fall back safely", () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";
  assert.equal(sessionLabel({sessionId,title:"安装插件",agentName:"worker"}), "安装插件 · 11111111");
  assert.equal(sessionLabel({sessionId,title:"\n ",agentName:"worker"}), "worker · 11111111");
  assert.equal(sessionLabel({sessionId}), sessionId);
  assert.equal(sessionLabel({sessionId,title:"多行\n聊天"}), "多行 聊天 · 11111111");
  assert.notEqual(sessionLabel({sessionId,title:"相同标题"}), sessionLabel({sessionId:"different-id",title:"相同标题"}));
  assert.ok(sessionLabel({sessionId,title:"长".repeat(500)}).length < 100);
});

test("Guardian visibility filters only review sessions and can restore the full list", async () => {
  const {isGuardianSession,visibleSessions}=await moduleOf("src/ui/session-label.ts");
  const normal={sessionId:"chat",title:"安装插件"};
  const named={sessionId:"review",title:"Guardian review"};
  const model={sessionId:"renamed",title:"重命名后的审核",model:"codex-auto-review"};
  const mentioned={sessionId:"explanation",title:"解释 Guardian review 是什么"};
  const rows=[normal,named,model,mentioned];
  assert.deepEqual(visibleSessions(rows,false),[normal,mentioned]);
  assert.equal(visibleSessions(rows,true),rows);
  assert.deepEqual(visibleSessions([named,model],false),[]);
  assert.ok(isGuardianSession({sessionId:"case",agentName:"  guardian   REVIEW  "}));
  assert.equal(isGuardianSession({sessionId:"unknown"}),false);
});
