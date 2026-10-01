import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import test from "node:test";

const execute=promisify(execFile);
const login=path.resolve("scripts/start-on-login.ps1");
const configure=path.resolve("scripts/configure-startup.ps1");
const windows={skip:process.platform!=="win32"};
const quote=value=>"'"+value.replaceAll("'","''")+"'";
async function ps(args,env=process.env){
  return execute("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass",...args],{env,windowsHide:true,timeout:15000});
}
async function command(code){return ps(["-EncodedCommand",Buffer.from(code,"utf16le").toString("base64")]);}
async function fixture(context){
  const directory=await mkdtemp(path.join(tmpdir(),"cm-"));
  const home=path.join(directory,"home 空格 $`'"),source=path.join(directory,"plugin $`'"),startup=path.join(directory,"boot");
  const cli=path.join(directory,"codex-fixture.ps1"),listing=path.join(directory,"plugins.json"),marker=path.join(directory,"started.json");
  const registry=`HKCU:\\Software\\CodexContextMonitorTests\\${randomUUID()}`;
  await mkdir(home,{recursive:true});await mkdir(source,{recursive:true});
  await writeFile(cli,'[IO.File]::ReadAllText((Join-Path $PSScriptRoot "plugins.json")); exit 0');
  const plugin={pluginId:"context-window-monitor@personal",name:"context-window-monitor",marketplaceName:"personal",version:"0.4.4+fixture.1",installed:true,enabled:true,source:{source:"local",path:source}};
  const save=()=>writeFile(listing,JSON.stringify({installed:[plugin]}));
  await save();
  const runtime=async(root,version=plugin.version)=>{
    await mkdir(path.join(root,".codex-plugin"),{recursive:true});await mkdir(path.join(root,"runtime"),{recursive:true});
    await writeFile(path.join(root,".codex-plugin","plugin.json"),JSON.stringify({name:plugin.name,version}));
    await writeFile(path.join(root,"runtime","open-dashboard.mjs"),`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)},JSON.stringify({root:${JSON.stringify(root)},args:process.argv.slice(2)})); console.log(JSON.stringify({desktopEntry:{visible:true}}));`);
  };
  await runtime(source);
  const env={...process.env};delete env.CONTEXT_MONITOR_DISABLE_DESKTOP_ENTRY;delete env.CONTEXT_MONITOR_DISABLE_LOGIN_STARTUP;
  const run=async(...args)=>JSON.parse((await ps(["-File",login,"-PluginId",plugin.pluginId,"-CodexHome",home,"-NodePath",process.execPath,"-CodexExecutable",cli,...args],env)).stdout);
  const register=async(mode="Install")=>JSON.parse((await ps(["-File",configure,"-Mode",mode,"-PluginId",plugin.pluginId,"-CodexHome",home,"-NodePath",process.execPath,"-StartupDirectory",startup,"-RegistryPath",registry],env)).stdout);
  context.after(async()=>{
    // This is a private test key, never the real Windows Run key.
    assert.match(registry,/^HKCU:\\Software\\CodexContextMonitorTests\\[a-f0-9-]+$/u);
    await command(`if(Test-Path -LiteralPath ${quote(registry)}){Remove-Item -LiteralPath ${quote(registry)} -Recurse -Force}`);
    assert.equal(path.dirname(directory),tmpdir());await rm(directory,{recursive:true,force:true});
  });
  return {directory,home,source,startup,cli,listing,marker,registry,plugin,save,runtime,env,run,register};
}

test("login validates an enabled plugin without starting it in CheckOnly",windows,async context=>{
  const f=await fixture(context);
  assert.equal((await f.run("-CheckOnly")).status,"enabled");
  await assert.rejects(access(f.marker));
  await assert.rejects(access(path.join(f.home,"context-window-monitor","startup-last-run.json")));
});

test("login does not run disabled or uninstalled plugins even when old files remain",windows,async context=>{
  const f=await fixture(context);
  f.plugin.enabled=false;await f.save();assert.equal((await f.run()).status,"disabled");
  await assert.rejects(access(f.marker));
  await writeFile(f.listing,JSON.stringify({installed:[]}));assert.equal((await f.run()).status,"not-installed");
  await assert.rejects(access(f.marker));
  f.plugin.enabled=true;await f.save();
  const {stdout}=await ps(["-File",login,"-PluginId",f.plugin.pluginId,"-CodexHome",f.home,"-CodexExecutable",f.cli],{...f.env,CONTEXT_MONITOR_DISABLE_LOGIN_STARTUP:"1"});
  assert.equal(JSON.parse(stdout).status,"disabled");await assert.rejects(access(f.marker));
});

test("login uses the current cache version after upgrades instead of a stale local copy",windows,async context=>{
  const f=await fixture(context);
  f.plugin.version="0.4.4+fixture.2";await f.save();
  const current=path.join(f.home,"plugins","cache",f.plugin.marketplaceName,f.plugin.name,f.plugin.version);
  await f.runtime(current);
  assert.equal((await f.run()).status,"started");
  assert.deepEqual(JSON.parse(await readFile(f.marker,"utf8")),{root:current,args:["--ensure"]});
  assert.equal(JSON.parse(await readFile(path.join(f.home,"context-window-monitor","startup-last-run.json"),"utf8")).error,null);
});

test("login fails closed on invalid status and missing installed runtime",windows,async context=>{
  const f=await fixture(context);
  await writeFile(f.listing,"invalid JSON");await assert.rejects(f.run());
  await assert.rejects(access(f.marker));
  assert.equal(JSON.parse(await readFile(path.join(f.home,"context-window-monitor","startup-last-run.json"),"utf8")).status,"failed");
  await f.save();await rm(path.join(f.source,"runtime","open-dashboard.mjs"));
  await assert.rejects(f.run(),/currently installed plugin runtime/u);
  assert.equal(JSON.parse(await readFile(path.join(f.home,"context-window-monitor","startup-last-run.json"),"utf8")).error,"The currently installed plugin runtime was not found.");
  await writeFile(f.cli,"exit 42");await assert.rejects(f.run(),/Could not read installed/u);
  await assert.rejects(access(f.marker));
});

test("login registration is idempotent, keeps unrelated values and removes only its own entry",windows,async context=>{
  const f=await fixture(context);
  await command(`New-Item -Path ${quote(f.registry)} -Force | Out-Null; New-ItemProperty -LiteralPath ${quote(f.registry)} -Name OtherApp -Value unchanged -PropertyType String | Out-Null`);
  assert.equal((await f.register()).registered,true);assert.equal((await f.register()).owned,true);
  assert.deepEqual(await f.register("Check"),{name:"CodexContextMonitor",registered:true,owned:true});
  const owner=JSON.parse(await readFile(path.join(f.startup,"startup-registration.json"),"utf8"));
  assert.ok(owner.command.length<=260);assert.match(owner.command,/-File /u);assert.doesNotMatch(owner.command,/-EncodedCommand/u);
  const kind=await command(`(Get-Item -LiteralPath ${quote(f.registry)}).GetValueKind('CodexContextMonitor').ToString()`);assert.equal(kind.stdout.trim(),"ExpandString");
  const {stdout}=await ps(["-File",path.join(f.startup,"login-startup.ps1"),"-CodexExecutable",f.cli,"-CheckOnly"],f.env);
  assert.equal(JSON.parse(stdout).status,"enabled");await assert.rejects(access(f.marker));
  assert.equal((await f.register("Remove")).removed,true);
  assert.equal((await f.register("Check")).registered,false);
  assert.equal((await command(`(Get-Item -LiteralPath ${quote(f.registry)}).GetValue('OtherApp')`)).stdout.trim(),"unchanged");
  await assert.rejects(access(path.join(f.startup,"login-startup.ps1")));
});

test("startup updates preserve user edited registry values and bootstrap files",windows,async context=>{
  const f=await fixture(context);await f.register();
  const owner=JSON.parse(await readFile(path.join(f.startup,"startup-registration.json"),"utf8"));
  await command(`Set-ItemProperty -LiteralPath ${quote(f.registry)} -Name CodexContextMonitor -Value user-edited`);
  await assert.rejects(f.register(),/modified or belongs/u);
  assert.deepEqual(await f.register("Remove"),{removed:false,preservedUserEdit:true});
  assert.equal((await command(`(Get-Item -LiteralPath ${quote(f.registry)}).GetValue('CodexContextMonitor')`)).stdout.trim(),"user-edited");
  await command(`New-ItemProperty -LiteralPath ${quote(f.registry)} -Name CodexContextMonitor -Value ${quote(owner.command)} -PropertyType String -Force | Out-Null`);
  assert.equal((await f.register("Check")).owned,false);assert.equal((await f.register("Remove")).preservedUserEdit,true);
  await command(`New-ItemProperty -LiteralPath ${quote(f.registry)} -Name CodexContextMonitor -Value ${quote(owner.command)} -PropertyType ExpandString -Force | Out-Null`);
  await command(`Set-ItemProperty -LiteralPath ${quote(f.registry)} -Name CodexContextMonitor -Value ${quote(owner.command)}`);
  const bootstrap=path.join(f.startup,"login-startup.ps1");await writeFile(bootstrap,"# user edit");
  await assert.rejects(f.register(),/bootstrap was edited/u);
  assert.equal((await f.register("Remove")).removed,true);
  assert.equal(await readFile(bootstrap,"utf8"),"# user edit");
});

test("a damaged login settings file leaves a diagnostic beside the bootstrap",windows,async context=>{
  const f=await fixture(context);await f.register();
  await writeFile(path.join(f.startup,"startup-registration.json"),"invalid JSON");
  await assert.rejects(ps(["-File",path.join(f.startup,"login-startup.ps1")],f.env));
  const failure=JSON.parse(await readFile(path.join(f.startup,"startup-last-run.json"),"utf8"));
  assert.equal(failure.status,"failed");assert.equal(typeof failure.error,"string");
  await assert.rejects(access(f.marker));
});
