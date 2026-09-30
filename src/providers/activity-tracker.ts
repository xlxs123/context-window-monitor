import { createHash } from "node:crypto";
import type { ActivityCategory, ActivityItem, ActivityReport } from "../context-types.js";

export const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string | null => typeof v === "string" ? v : null;
export const digest = (v:string):string => createHash("sha256").update(v).digest("hex");

/** Read only explicitly logged text. Encrypted reasoning and internal metadata are excluded. */
export function visibleText(payload:Record<string,unknown>):string {
  if (typeof payload.arguments === "string") return payload.arguments;
  if (typeof payload.input === "string") return payload.input;
  if (typeof payload.output === "string") return payload.output;
  if (Array.isArray(payload.output)) return payload.output.map(v=>visibleText(object(v)??{})).join("\n");
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.message === "string") return payload.message;
  const blocks = Array.isArray(payload.content) ? payload.content : Array.isArray(payload.summary) ? payload.summary : [];
  return blocks.map(v=>text(object(v)?.text)??"").filter(Boolean).join("\n");
}

/** Structural log classification. This is recorded activity, never a reconstructed model request. */
export function activityItem(root:Record<string,unknown>,id:string,timestamp:string):ActivityItem|null {
  const payload=object(root.payload);if(!payload)return null;
  const type=text(payload.type)??String(root.type);
  if(root.type!=="response_item"&&root.type!=="compacted")return null;
  let category:ActivityCategory="other";
  const role=text(payload.role);
  if(type==="message"&&["system","developer","user","assistant"].includes(role??""))category=role as ActivityCategory;
  else if(type==="reasoning")category="reasoning";
  else if(["function_call","custom_tool_call","web_search_call"].includes(type))category="tool_call";
  else if(["function_call_output","custom_tool_call_output"].includes(type))category="tool_result";
  else if(root.type==="compacted"||["compaction","context_compaction"].includes(type))category="compaction";
  const body=visibleText(payload);
  let file:string|null=null;
  if(category==="tool_call")try{const args=object(JSON.parse(text(payload.arguments)??text(payload.input)??"null"));file=text(args?.path)??text(args?.file_path)??null;}catch{/* Free-form tool input is not treated as structured file metadata. */}
  return {id,timestamp,category,type,role,name:text(payload.name)??role??type,callId:text(payload.call_id),messageId:text(payload.id),characters:body.length,hash:digest(body),file,tokens:null};
}

export function summarizeActivity(items:ActivityItem[],truncated:boolean,parentSessionId:string|null,agentName:string|null):ActivityReport {
  const calls=new Map(items.filter(i=>i.category==="tool_call"&&i.callId).map(i=>[i.callId,i.name]));
  const normalized=items.map(i=>i.category==="tool_result"?{...i,name:calls.get(i.callId)??"未关联工具结果"}:i);
  const tools=new Map<string,ActivityReport["tools"][number]>();
  const files=new Map<string,ActivityReport["files"][number]>();
  const hashes=new Map<string,ActivityItem[]>();
  for(const i of normalized){
    if(i.category==="tool_call"||i.category==="tool_result"){
      const t=tools.get(i.name)??{name:i.name,calls:0,results:0,argumentCharacters:0,resultCharacters:0,tokens:null};
      if(i.category==="tool_call"){t.calls++;t.argumentCharacters+=i.characters;}else{t.results++;t.resultCharacters+=i.characters;}tools.set(i.name,t);
    }
    if(i.file){const f=files.get(i.file)??{path:i.file,calls:0,characters:0};f.calls++;f.characters+=i.characters;files.set(i.file,f);}
    if(i.characters>=256)hashes.set(i.hash,[...(hashes.get(i.hash)??[]),i]);
  }
  return {items:normalized,truncated,scope:"最近保留的日志记录；不代表当前模型完整上下文",parentSessionId,agentName,tools:[...tools.values()].sort((a,b)=>b.resultCharacters-a.resultCharacters),files:[...files.values()].sort((a,b)=>b.calls-a.calls),duplicates:[...hashes.values()].filter(a=>a.length>1).map(a=>({hash:a[0]!.hash,ids:a.map(i=>i.id),characters:a.slice(1).reduce((n,i)=>n+i.characters,0)}))};
}
