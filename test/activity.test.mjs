import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,appendFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {activityItem,summarizeActivity,visibleText,createParsedRolloutState,parseRolloutLine,RolloutContextProvider,SessionRegistry,ContextHistoryTracker} from "../runtime/core/index.mjs";

const timestamp="2026-09-28T00:00:00.000Z";
const usage={input_tokens:500,cached_input_tokens:200,cache_write_input_tokens:0,output_tokens:50,reasoning_output_tokens:10,total_tokens:550};
const row=(payload,time=timestamp)=>({timestamp:time,type:"response_item",payload});

test("classifies tool pairs and explicit paths without retaining original text",()=>{
  const rows=[row({type:"function_call",name:"read_file",call_id:"c1",arguments:'{"path":"README.md"}'}),row({type:"function_call_output",call_id:"c1",output:"private fixture ".repeat(40)}),row({type:"function_call_output",call_id:"c1",output:"private fixture ".repeat(40)}),row({type:"reasoning",summary:[{type:"summary_text",text:"Public summary"}],encrypted_content:"never reveal"})];
  const items=rows.map((r,i)=>activityItem(r,String(i),timestamp));const report=summarizeActivity(items,false,null,null);
  assert.equal(report.tools[0].calls,1);assert.equal(report.tools[0].results,2);assert.equal(report.files[0].path,"README.md");
  assert.equal(report.duplicates.length,1);assert.equal(report.items[1].name,"read_file");assert.equal(report.items[1].tokens,null);
  assert.ok(!JSON.stringify(report).includes("private fixture"));assert.ok(!JSON.stringify(report).includes("never reveal"));
  assert.equal(visibleText(rows[3].payload),"Public summary");
});

test("recognizes new token_usage_record and compacted envelopes without duplicate usage",()=>{
  const state=createParsedRolloutState("fixture",null);
  const lines=[{timestamp,type:"turn_context",payload:{model:"test-model",turn_id:"turn"}},
    {timestamp,type:"event_msg",payload:{type:"task_started",model_context_window:4096}},
    {timestamp,type:"token_usage_record",payload:{usage,thread_token_usage:usage,turn_id:"turn"}},
    {timestamp,type:"event_msg",payload:{type:"token_count",info:{last_token_usage:usage,total_token_usage:usage,model_context_window:4096}}},
    {timestamp,type:"compacted",payload:{message:"summary",replacement_history:[]}}];
  lines.forEach(r=>parseRolloutLine(JSON.stringify(r),"explicit",state));
  assert.equal(state.snapshots.length,1);assert.equal(state.snapshots[0].modelContextWindow,4096);assert.equal(state.snapshots[0].last.inputTokens,500);
  assert.equal(state.compactions.length,1);assert.equal(state.activity[0].category,"compaction");
});

test("failed/incomplete compaction is not counted as a completed event",()=>{
  const state=createParsedRolloutState("fixture",null);
  parseRolloutLine(JSON.stringify({timestamp,method:"item/started",params:{item:{type:"contextCompaction"}}}),"explicit",state);
  assert.equal(state.compactions.length,0);
});

test("explicit parent metadata is recognized; arbitrary message prose is not an Agent link",()=>{
  const state=createParsedRolloutState("child",null);
  parseRolloutLine(JSON.stringify({timestamp,type:"session_meta",payload:{id:"child",source:{subagent:{thread_spawn:{parent_thread_id:"parent",agent_nickname:"Research"}}}}}),"explicit",state);
  assert.equal(state.parentSessionId,"parent");assert.equal(state.agentName,"Research");
});

test("incremental reads preserve partial UTF-8, exact offsets, concurrency, and read-only privacy",async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"codex-monitor-activity-"));const file=path.join(dir,"fixture.jsonl");const registry=new SessionRegistry(dir);
  await registry.record({sessionId:"fixture",transcriptPath:file,cwd:dir,model:null,eventName:"SessionStart",turnId:null,toolName:null,trigger:null,timestamp});
  const first=JSON.stringify({timestamp,type:"session_meta",payload:{id:"fixture"}})+"\n";
  const line=Buffer.from(JSON.stringify(row({type:"message",role:"user",content:[{type:"input_text",text:"中文隐私文本"}]}))+"\n");
  const split=line.indexOf(Buffer.from("中文"))+1;
  await writeFile(file,Buffer.concat([Buffer.from(first),line.subarray(0,split)]));
  const provider=new RolloutContextProvider(registry);assert.equal((await provider.getContext({sessionId:"fixture"})).activity.items.length,0);
  await appendFile(file,line.subarray(split));
  const [a,b]=await Promise.all([provider.getContext({sessionId:"fixture"}),provider.getContext({sessionId:"fixture"})]);
  assert.equal(a.activity.items.length,1);assert.equal(b.activity.items.length,1);
  assert.equal(a.activity.items[0].characters,6);assert.ok(!JSON.stringify(a).includes("中文隐私文本"));
  const revealed=await provider.readItem("fixture",a.activity.items[0].id);assert.equal(revealed.text,"中文隐私文本");
  await assert.rejects(provider.readItem("fixture","999999"),/保留范围/u);
  await assert.rejects(provider.getContext({sessionId:"../outside"}),/Invalid/u);
});

test("compaction with only one timestamp never invents a zero-sized reduction",()=>{
  const state=createParsedRolloutState("fixture",null);parseRolloutLine(JSON.stringify({timestamp,type:"token_usage_record",payload:{usage,thread_token_usage:usage}}),"explicit",state);
  const c=new ContextHistoryTracker().compactions(state.snapshots,[{timestamp,trigger:"unknown",source:"rollout-log"}])[0];
  assert.equal(c.beforeTokens,null);assert.equal(c.afterTokens,null);assert.equal(c.reducedTokens,null);
});
