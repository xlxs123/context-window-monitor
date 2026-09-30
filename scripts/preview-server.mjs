import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { activityItem, summarizeActivity } from "../runtime/core/index.mjs";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.CONTEXT_MONITOR_PREVIEW_PORT ?? "4174", 10);
const [script, fixtureText] = await Promise.all([
  readFile(new URL("../runtime/ui/context-details-panel.js", import.meta.url), "utf8"),
  readFile(new URL("../test/fixtures/exact-dashboard.json", import.meta.url), "utf8"),
]);
const fixture=JSON.parse(fixtureText);
fixture.usage.model="synthetic-codex-model";
fixture.snapshots=Array.from({length:30},(_,i)=>{
  const input=i<18?22000+i*6300:62000+(i-18)*(16420/11);
  const last={inputTokens:Math.round(input),cachedInputTokens:Math.round(input*.78),cacheWriteInputTokens:0,outputTokens:3810,reasoningOutputTokens:1440,totalTokens:Math.round(input)+3810};
  return {sessionId:"fixture-session",timestamp:new Date(Date.UTC(2026,8,1,0,i)).toISOString(),source:"rollout-log",selection:"explicit",last,cumulative:{...last,totalTokens:314880},modelContextWindow:200000,model:"synthetic-codex-model",turnId:`fixture-turn-${i}`};
});
const records=[{type:"message",role:"system",content:[{type:"input_text",text:"Synthetic instructions. ".repeat(40)}]},
  {type:"message",role:"developer",content:[{type:"input_text",text:"Synthetic project guidance. ".repeat(40)}]},
  {type:"message",role:"user",content:[{type:"input_text",text:"Review the sample architecture."}]},
  {type:"function_call",name:"read_file",call_id:"fixture-1",arguments:'{"path":"architecture.md"}'},
  {type:"function_call_output",call_id:"fixture-1",output:"Synthetic architecture content. ".repeat(170)},
  {type:"function_call",name:"read_file",call_id:"fixture-2",arguments:'{"path":"architecture.md"}'},
  {type:"function_call_output",call_id:"fixture-2",output:"Synthetic architecture content. ".repeat(170)},
  {type:"reasoning",summary:[{type:"summary_text",text:"Synthetic public reasoning summary. ".repeat(10)}]},
  {type:"message",role:"assistant",content:[{type:"output_text",text:"Synthetic assistant response. ".repeat(20)}]}];
fixture.activity=summarizeActivity(records.map((p,i)=>activityItem({type:"response_item",payload:p},String(i),new Date(Date.UTC(2026,8,1,0,i)).toISOString())),false,null,null);

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Context Monitor · 演示数据</title><link rel="icon" href="data:,"></head>
<body>
<div id="root"></div>
<script>window.__CONTEXT_MONITOR_PREVIEW__=${JSON.stringify(fixture).replaceAll("<","\\u003c")};</script>
<script type="module">${script}</script>
</body></html>`;

const server = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
});

server.listen(port, host, () => {
  console.log(`Context Window Monitor preview: http://${host}:${port}`);
});
