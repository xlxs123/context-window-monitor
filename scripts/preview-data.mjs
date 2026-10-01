import {activityItem,summarizeActivity} from "../runtime/core/index.mjs";

/** Synthetic records only: safe to capture and publish without user session data. */
export function previewDashboard(seed) {
  const dashboard=JSON.parse(JSON.stringify(seed));
  const model="synthetic-codex-model";
  const timestamp=seconds=>new Date(Date.UTC(2026,8,1,2,0,seconds)).toISOString();
  const items=[];
  const add=(payload,seconds,rootType="response_item")=>items.push(activityItem({type:rootType,payload},`demo-${items.length}`,timestamp(seconds)));
  add({type:"message",role:"system",content:[{text:"演示系统指令：准确、可验证，保持原文隐私。".repeat(80)}]},0);
  add({type:"message",role:"developer",content:[{text:"演示项目约定：沿用现有工具链，记录真实请求字段。".repeat(60)}]},1);
  const cumulative={inputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0};
  dashboard.snapshots=Array.from({length:30},(_,index)=>{
    const begin=index*60+8,callId=`demo-call-${index}`;
    if(index%3===0)add({type:"message",role:"user",content:[{text:`检查演示项目第 ${index/3+1} 轮的界面与数据边界。`}]},begin-3);
    let name,input,result;
    switch(index%4){
      case 0:name="read_file";input=JSON.stringify({path:index%8===0?"src/context-panel.ts":"docs/architecture.md"});result="演示文件内容：这是独立生成的测试数据，不包含用户文件。\n".repeat(190);break;
      case 1:name="functions.apply_patch";input="*** Begin Patch\n*** Update File: src/context-panel.ts\n@@\n-oldRender()\n+renderDashboard()\n+preserveSelection()\n*** Update File: src/styles.css\n@@\n-background: white;\n+background: #08090b;\n*** End Patch";result="Success. Updated synthetic files.";break;
      case 2:name="search_files";input=JSON.stringify({path:"src/context-panel.ts",query:"renderDashboard"});result="演示搜索结果：找到 3 个显式调用。\n".repeat(90);break;
      default:name="functions.view_image";input=JSON.stringify({path:"docs/preview.png"});result="演示图片已读取。";break;
    }
    add({type:name.endsWith("apply_patch")?"custom_tool_call":"function_call",name,call_id:callId,...(name.endsWith("apply_patch")?{input}:{arguments:input})},begin);
    if(index===18)add({type:"compaction",summary:[{text:"演示压缩摘要：保留目标和关键结果，减少历史输入。".repeat(20)}]},begin+12,"compacted");
    add({type:name.endsWith("apply_patch")?"custom_tool_call_output":"function_call_output",call_id:callId,output:result},begin+22+index%5);
    if(index%3===1)add({type:"reasoning",summary:[{type:"summary_text",text:"演示公开摘要：检查分类数据与快照范围是否一致。".repeat(25)}]},begin+38);
    add({type:"message",role:"assistant",content:[{text:"演示回复：已完成本步骤的核对，所有值以日志提供的信息为准。".repeat(45)}]},begin+45);
    const inputTokens=Math.round(index<18?42000+index*6300:62000+(index-18)*(16420/11));
    const last={inputTokens,cachedInputTokens:Math.round(inputTokens*.78),cacheWriteInputTokens:0,outputTokens:900+index*18,reasoningOutputTokens:320,totalTokens:0};
    last.totalTokens=last.inputTokens+last.outputTokens;
    for(const key of Object.keys(cumulative))cumulative[key]+=last[key];
    return {sessionId:"fixture-session",timestamp:timestamp(index*60+59),source:"rollout-log",selection:"explicit",last,cumulative:{...cumulative},modelContextWindow:200000,model,turnId:`demo-turn-${Math.floor(index/3)+1}`};
  });
  const last=dashboard.snapshots.at(-1);
  dashboard.usage={...dashboard.usage,model,usedTokens:last.last.inputTokens,remainingTokens:200000-last.last.inputTokens,percentage:last.last.inputTokens/2000,updatedAt:last.timestamp};
  dashboard.exactBreakdown={currentModelInputTokens:last.last.inputTokens,cachedInputTokens:last.last.cachedInputTokens,cacheWriteInputTokens:0,uncachedInputTokens:last.last.inputTokens-last.last.cachedInputTokens,lastOutputTokens:last.last.outputTokens,reasoningOutputTokens:last.last.reasoningOutputTokens,cumulativeThreadTokens:last.cumulative.totalTokens};
  dashboard.cumulativeTokens=last.cumulative.totalTokens;
  dashboard.recentChanges=dashboard.snapshots.slice(1).map((snapshot,index)=>({id:`demo-change-${index+1}`,timestamp:index===17?timestamp(18*60+20):snapshot.timestamp,kind:index===17?"compaction":"increase",beforeTokens:dashboard.snapshots[index].last.inputTokens,afterTokens:snapshot.last.inputTokens,deltaTokens:snapshot.last.inputTokens-dashboard.snapshots[index].last.inputTokens,label:index===17?"正式压缩事件 · 演示摘要替换":"请求输入变化 · 演示日志",detail:"Synthetic fixture, never user data.",attribution:index===17?"exact-event":"observed-correlation"}));
  dashboard.compactions=[{timestamp:timestamp(18*60+20),trigger:"auto",beforeTokens:dashboard.snapshots[17].last.inputTokens,afterTokens:dashboard.snapshots[18].last.inputTokens,reducedTokens:dashboard.snapshots[17].last.inputTokens-dashboard.snapshots[18].last.inputTokens,precision:"exact",detail:"Synthetic compaction with surrounding usage snapshots."}];
  dashboard.activity=summarizeActivity(items,false,null,"演示项目 · 上下文监控");
  return dashboard;
}
