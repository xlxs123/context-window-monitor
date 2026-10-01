import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {activityItem,summarizeActivity} from "../runtime/core/index.mjs";

const moduleOf=async entry=>{
  const result=await build({entryPoints:[entry],bundle:true,write:false,platform:"node",format:"esm",logLevel:"silent"});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
};
const [model,donut]=await Promise.all([moduleOf("src/ui/dashboard-model.ts"),moduleOf("src/ui/dsh-donut.ts")]);
const record=(id,category,seconds,callId=null)=>({id,category,timestamp:new Date(seconds*1000).toISOString(),callId,characters:10,file:null});

test("donut preserves tiny visible slices and omits unavailable or invalid values",()=>{
  const arcs=donut.donutArcs([{key:"large",color:"blue",value:9999},{key:"tiny",color:"green",value:1},{key:"missing",color:"red",value:null}]);
  assert.equal(arcs.length,2);assert.ok(arcs[1].length>0&&arcs[1].length<.01);
  assert.equal(arcs[0].offset,124.75);
  assert.deepEqual(donut.donutArcs([null,NaN,-10,0].map(value=>({key:String(value),color:"gray",value}))),[]);
  assert.deepEqual(donut.donutArcs([{key:"single",color:"blue",value:3}]),[{key:"single",color:"blue",length:100,offset:125}]);
});

test("historical selection includes only timestamped records before its cutoff",()=>{
  const items=[record("before","user",1),record("at","assistant",3),record("after","tool_call",4),{...record("unknown","other",0),timestamp:"unknown"}];
  const dashboard={activity:{items},snapshots:[{timestamp:new Date(3000).toISOString()}]};
  assert.deepEqual(model.scopedItems(dashboard,0).map(item=>item.id),["before","at"]);
  assert.equal(model.scopedItems(dashboard,-1),items);
  assert.equal(model.categoryComposition(items.slice(0,2),items.slice(0,1)).find(part=>part.category==="assistant").added,1);
});

test("timing merges overlapping tool intervals and keeps unmatched duration unavailable",()=>{
  const items=[record("start","user",0),record("a","tool_call",10,"a"),record("b","tool_call",15,"b"),record("ra","tool_result",20,"a"),record("rb","tool_result",25,"b"),record("again","tool_result",28,"b"),record("end","assistant",30)];
  assert.deepEqual(model.observedTiming(items),{span:30,tool:15,other:15,pairedCalls:2});
  assert.deepEqual(model.observedTiming([record("a","tool_call",0,"a"),record("end","assistant",30)]),{span:30,tool:null,other:null,pairedCalls:0});
  assert.equal(model.observedTiming([]).span,null);
});

test("turn mode uses each contiguous turn's latest request and keeps unknown turns separate",()=>{
  const snapshots=["a","a",null,null,"b","b",undefined,undefined].map((turnId,index)=>({turnId,last:{inputTokens:index}}));
  const turns=model.trendGroups(snapshots,true);
  assert.deepEqual(turns.map(group=>[group.index,group.count]),[[1,2],[2,1],[3,1],[5,2],[6,1],[7,1]]);
  assert.equal(model.trendGroups(snapshots,false).length,8);
});

test("file rows agree with the backend for repeated hunks, unknown writes and deletion",()=>{
  const parse=(payload,id)=>activityItem({type:"response_item",payload},id,"2026-10-01T12:00:00Z");
  const patch=parse({type:"custom_tool_call",name:"apply_patch",input:"*** Begin Patch\n*** Update File: same.ts\n@@\n-old\n+new\n*** Update File: same.ts\n@@\n-x\n+y\n+z\n*** Delete File: deleted.ts\n*** End Patch"},"p");
  const result=parse({type:"custom_tool_call_output",call_id:"p",output:"done"},"r");
  const unknown=parse({type:"function_call",name:"unknown_tool",arguments:'{"path":"same.ts"}'},"unknown");
  for(const items of [[patch,result],[patch,unknown,result]]){
    const backend=summarizeActivity(items,false,null,null);
    const rows=model.fileRows(items);
    for(const file of backend.files){const row=rows.find(value=>value.path===file.path);assert.deepEqual([row.calls,row.write,row.addedLines,row.removedLines,row.lastAt],[file.calls,file.writeCalls,file.addedLines,file.removedLines,file.lastAt]);}
  }
  assert.equal(model.fileRows([patch,result]).find(row=>row.path==="same.ts").write,1);
  assert.equal(model.fileRows([patch,result]).find(row=>row.path==="deleted.ts").addedLines,0);
});
