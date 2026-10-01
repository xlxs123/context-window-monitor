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
  const env={...process.env,CODEX_HOME:path.join(directory,"codex"),CONTEXT_MONITOR_DATA:path.join(directory,"registry"),CONTEXT_MONITOR_LAUNCHER_DATA:state,CONTEXT_MONITOR_DISABLE_AUTO_PROJECTS:"1",CONTEXT_MONITOR_DISABLE_DESKTOP_ENTRY:"1"};
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
  await writeFile(path.join(f.state,"launcher-0.5.0.json"),JSON.stringify({version:"0.5.0",pid:123,url:"https://example.invalid/"}));
  const launches=await Promise.all([f.run("--session","fixture"),f.run("--session","fixture"),f.run("--session","fixture")]);
  assert.equal(new Set(launches.map(value=>value.pid)).size,1);
  assert.equal(new Set(launches.map(value=>value.url)).size,1);
  const warm=await f.run("--session","fixture");assert.equal(warm.pid,launches[0].pid);
  assert.equal(warm.browserTarget,"codex");
  const appLink=new URL(warm.launchUrl);
  assert.equal(appLink.protocol,"codex:");assert.equal(appLink.hostname,"browser");
  assert.equal(appLink.pathname,"");assert.equal(appLink.searchParams.size,1);
  assert.equal(appLink.searchParams.get("url"),warm.url);
  assert.equal(appLink.hash,"");
  const external=await f.run("--session","fixture","--external-browser");
  assert.equal(external.browserTarget,"external");assert.equal(external.launchUrl,external.url);
  assert.equal(external.pid,warm.pid);
  const url=new URL(warm.url);assert.equal(url.hostname,"127.0.0.1");
  assert.equal(url.searchParams.get("session"),"fixture");assert.equal(url.searchParams.has("selection"),false);
  const health=await (await fetch(new URL("health",url))).json();
  assert.equal(health.pid,warm.pid);assert.equal(health.version,"0.5.0");
  assert.equal((await fetch(url)).status,200);
  assert.equal((await fetch(new URL("health",url),{headers:{Origin:"https://example.invalid"}})).status,403);
  const saved=JSON.parse(await readFile(path.join(f.state,"launcher-0.5.0.json"),"utf8"));assert.equal(saved.pid,warm.pid);
});

test("desktop entry selects the most recent session across projects independently of its working directory",async context=>{
  const f=await fixture(context);
  const first="44444444-4444-4444-8444-444444444444",second="55555555-5555-4555-8555-555555555555";
  await f.log(first,path.join(f.directory,"first-project"),5000);
  await f.log(second,path.join(f.directory,"second-project"),1000);
  const selected=await f.run("--recent","--cwd",path.join(f.directory,"unrelated-launcher"));
  assert.equal(selected.sessionId,second);
  assert.equal(new URL(selected.url).searchParams.get("selection"),"recent-session");
  await f.log(first,path.join(f.directory,"first-project"),0);
  const switched=await f.run("--recent");
  assert.equal(switched.sessionId,first);assert.equal(switched.pid,selected.pid);
  const explicit=await f.run("--recent","--session",second);
  assert.equal(explicit.sessionId,second);assert.equal(new URL(explicit.url).searchParams.has("selection"),false);
});

test("Windows desktop helper compiles without showing windows or registering a hotkey",{skip:process.platform!=="win32"},async()=>{
  const {stdout}=await execute("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",path.resolve("scripts/desktop-entry.ps1"),
    "-DataDirectory",path.join(tmpdir(),"context-entry-check"),"-NodePath",process.execPath,"-CheckOnly"],{windowsHide:true,timeout:15000});
  assert.deepEqual(JSON.parse(stdout),{nodeFound:true,hotkey:"Ctrl+Alt+M",launcherFound:true,compiled:true});
});

test("Windows browser entry resolves the executable from each install manifest without opening it",{skip:process.platform!=="win32"},async context=>{
  const directory=await mkdtemp(path.join(tmpdir(),"context-browser-"));
  context.after(()=>rm(directory,{recursive:true,force:true}));
  const script=path.resolve("scripts/open-codex-browser.ps1").replaceAll("'","''");
  for(const name of ["New Codex install","Different drive layout"]){
    const root=path.join(directory,name);await mkdir(path.join(root,"renamed app"),{recursive:true});
    const executable=path.join(root,"renamed app","Desktop.exe");await writeFile(executable,"");
    await writeFile(path.join(root,"AppxManifest.xml"),'<Package xmlns="urn:test"><Applications><Application Executable="runner.exe"/><Application Executable="renamed app/Desktop.exe"><Extensions><Extension><Protocol Name="codex"/></Extension></Extensions></Application></Applications></Package>');
    const command=`function Get-AppxPackage { param($Name) [PSCustomObject]@{Version='26.999.1.0';InstallLocation='${root.replaceAll("'","''")}'} }; & '${script}' -ResolveOnly`;
    const {stdout}=await execute("powershell.exe",["-NoProfile","-Command",command],{windowsHide:true,timeout:15000});
    assert.deepEqual(JSON.parse(stdout),{method:"desktop-executable",executable});
  }
  await writeFile(path.join(directory,"AppxManifest.xml"),'<Package><Application Executable="../escape.exe"><Protocol Name="codex"/></Application></Package>');
  const invalid=`function Get-AppxPackage { param($Name) [PSCustomObject]@{Version='1.0';InstallLocation='${directory.replaceAll("'","''")}'} }; & '${script}' -ResolveOnly`;
  await assert.rejects(execute("powershell.exe",["-NoProfile","-Command",invalid],{windowsHide:true,timeout:15000}),/outside its package/u);
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
  const lock=path.join(f.state,"launcher-0.5.0.lock");await writeFile(lock,"");
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
