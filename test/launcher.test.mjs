import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {promisify} from "node:util";
import test from "node:test";

const execute=promisify(execFile);
const launcher=path.resolve("runtime/open-dashboard.mjs");
async function fixture(context){
  const directory=await mkdtemp(path.join(tmpdir(),"context-launcher-"));
  const state=path.join(directory,"state");
  const sessions=path.join(directory,"codex","sessions","2026","09","30");
  await mkdir(state,{recursive:true});await mkdir(sessions,{recursive:true});
  const env={...process.env,CODEX_HOME:path.join(directory,"codex"),CONTEXT_MONITOR_DATA:path.join(directory,"registry"),CONTEXT_MONITOR_LAUNCHER_DATA:state};
  const run=async(...args)=>JSON.parse((await execute(process.execPath,[launcher,"--no-open",...args],{env,timeout:15000,windowsHide:true})).stdout);
  context.after(async()=>{
    await execute(process.execPath,[launcher,"--stop"],{env,timeout:5000,windowsHide:true});
    await delay(150);
    await rm(directory,{recursive:true,force:true});
  });
  const log=async(id,cwd,age)=>{
    const file=path.join(sessions,`rollout-${id}.jsonl`);
    const usage={input_tokens:500,cached_input_tokens:100,cache_write_input_tokens:0,output_tokens:20,reasoning_output_tokens:0,total_tokens:520};
    const rows=[{type:"session_meta",payload:{id,cwd}},
      {type:"turn_context",payload:{model:"fixture-model"}},
      {type:"event_msg",payload:{type:"token_count",info:{last_token_usage:usage,total_token_usage:usage,model_context_window:4096}}}];
    await writeFile(file,rows.map(row=>JSON.stringify({...row,timestamp:"2026-09-30T00:00:00Z"})).join("\n")+"\n");
    const modified=new Date(Date.now()-age);await utimes(file,modified,modified);
  };
  return {directory,state,run,log,env};
}

test("concurrent clicks share one healthy service; a later click reuses it",async context=>{
  const f=await fixture(context);
  // A corrupt saved address must never redirect the launcher outside loopback.
  await writeFile(path.join(f.state,"launcher-0.3.0.json"),JSON.stringify({version:"0.3.0",pid:123,url:"https://example.invalid/"}));
  const launches=await Promise.all([f.run("--session","fixture"),f.run("--session","fixture"),f.run("--session","fixture")]);
  assert.equal(new Set(launches.map(value=>value.pid)).size,1);
  assert.equal(new Set(launches.map(value=>value.url)).size,1);
  const warm=await f.run("--session","fixture");assert.equal(warm.pid,launches[0].pid);
  const url=new URL(warm.url);assert.equal(url.hostname,"127.0.0.1");
  assert.equal(url.searchParams.get("session"),"fixture");assert.equal(url.searchParams.has("selection"),false);
  const health=await (await fetch(new URL("health",url))).json();
  assert.equal(health.pid,warm.pid);assert.equal(health.version,"0.3.0");
  assert.equal((await fetch(url)).status,200);
  assert.equal((await fetch(new URL("health",url),{headers:{Origin:"https://example.invalid"}})).status,403);
  const saved=JSON.parse(await readFile(path.join(f.state,"launcher-0.3.0.json"),"utf8"));assert.equal(saved.pid,warm.pid);
});

test("Windows PowerShell launcher returns from a captured pipeline after cold startup",{skip:process.platform!=="win32"},async context=>{
  const f=await fixture(context);
  const wrapper=path.resolve("scripts/open-dashboard.ps1").replaceAll("'","''");
  const project=path.join(f.directory,"Project with spaces").replaceAll("'","''");
  // The outer pipeline must receive EOF even while the hidden server stays alive.
  const command=`powershell.exe -NoProfile -ExecutionPolicy Bypass -File '${wrapper}' -ProjectPath '${project}' -NoOpen | ConvertFrom-Json | ConvertTo-Json -Compress`;
  const {stdout}=await execute("powershell.exe",["-NoProfile","-Command",command],{env:f.env,timeout:15000,windowsHide:true});
  const result=JSON.parse(stdout);
  assert.ok(result.pid>0);assert.equal(result.sessionId,null);
  assert.equal((await f.run("--session","explicit")).pid,result.pid);
});

test("project selection respects directory boundaries, recovers an old lock, and never falls back to another project",async context=>{
  const f=await fixture(context);
  const project=path.join(f.directory,"Project with spaces");
  await f.log("11111111-1111-4111-8111-111111111111",project,5000);
  await f.log("22222222-2222-4222-8222-222222222222",path.join(project,"nested"),3000);
  await f.log("33333333-3333-4333-8333-333333333333",`${project}-sibling`,1000);
  const lock=path.join(f.state,"launcher-0.3.0.lock");await writeFile(lock,"");
  const old=new Date(Date.now()-60000);await utimes(lock,old,old);
  const selected=await f.run("--cwd",project);
  assert.equal(selected.sessionId,"22222222-2222-4222-8222-222222222222");
  assert.equal(new URL(selected.url).searchParams.get("selection"),"recent-project");
  const response=await fetch(new URL("api",selected.url),{method:"POST",body:JSON.stringify({name:"get_context_usage",arguments:{sessionId:selected.sessionId}})});
  const data=(await response.json()).structuredContent;
  assert.equal(data.usage.usedTokens,500);assert.equal(data.usage.totalTokens,4096);
  const empty=await f.run("--cwd",path.join(f.directory,"unrelated"));
  assert.equal(empty.sessionId,null);assert.equal(empty.pid,selected.pid);
  assert.equal(new URL(empty.url).searchParams.get("session"),"no-session-for-project");
  const missing=await fetch(new URL("api",empty.url),{method:"POST",body:JSON.stringify({name:"get_context_usage",arguments:{sessionId:"no-session-for-project"}})});
  assert.equal((await missing.json()).structuredContent.usage.usedTokens,null);
});
