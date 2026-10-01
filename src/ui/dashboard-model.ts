import type {ActivityCategory, ActivityItem, ContextDashboard, RawContextSnapshot, FileOperationKind} from "../context-types.js";

export const categoryLabels: Record<ActivityCategory, string> = {
  system:"系统提示词", developer:"项目 / 开发者指令", user:"用户消息", assistant:"助手消息",
  reasoning:"公开思考摘要", tool_call:"工具调用参数", tool_result:"工具结果", compaction:"压缩记录", other:"其他记录",
};
export const categoryColors: Record<ActivityCategory, string> = {
  system:"#7661ff", developer:"#b452fa", user:"#22c55e", assistant:"#3285ff",
  reasoning:"#e54aae", tool_call:"#ffad0a", tool_result:"#00b9aa", compaction:"#fb6479", other:"#8d97a9",
};
export function scopedItems(dashboard: ContextDashboard, index: number): ActivityItem[] {
  const items = dashboard.activity?.items ?? [];
  const snapshot = dashboard.snapshots?.[index];
  if (index < 0 || !snapshot) return items;
  const cutoff = Date.parse(snapshot.timestamp);
  if (!Number.isFinite(cutoff)) return [];
  // Unknown timestamps cannot be attributed to a historical request.
  return items.filter(item => Number.isFinite(Date.parse(item.timestamp)) && Date.parse(item.timestamp) <= cutoff);
}
export function categoryComposition(items: ActivityItem[], previous: ActivityItem[] = []) {
  return Object.entries(categoryLabels).map(([category, label]) => {
    const current = items.filter(item => item.category === category);
    const priorIds = new Set(previous.filter(item => item.category === category).map(item => item.id));
    return {category:category as ActivityCategory,label,color:categoryColors[category as ActivityCategory],
      items:current,characters:current.reduce((sum,item)=>sum+item.characters,0),added:current.filter(item=>!priorIds.has(item.id)).length};
  });
}
export function observedTiming(items: ActivityItem[]) {
  const times = items.map(item => Date.parse(item.timestamp)).filter(Number.isFinite);
  const start = Math.min(...times), end = Math.max(...times);
  const span = times.length > 1 && end > start ? (end-start)/1000 : null;
  const calls = new Map<string,number>();
  const completed = new Set<string>();
  const intervals: Array<[number,number]> = [];
  for (const item of items) {
    const time = Date.parse(item.timestamp);
    if (!item.callId || !Number.isFinite(time)) continue;
    if (item.category === "tool_call") calls.set(item.callId,time);
    if (item.category === "tool_result" && !completed.has(item.callId)) {
      const begin = calls.get(item.callId);
      if (begin !== undefined && time >= begin) { intervals.push([begin,time]); completed.add(item.callId); }
    }
  }
  intervals.sort((a,b)=>a[0]-b[0]);
  let total=0, left:number|null=null, right=0;
  for (const [begin,finish] of intervals) {
    if (left === null) {left=begin;right=finish;}
    else if (begin <= right) right=Math.max(right,finish);
    else {total+=right-left;left=begin;right=finish;}
  }
  if (left !== null) total+=right-left;
  const tool = span !== null && intervals.length > 0 ? Math.min(span,total/1000) : null;
  return {span,tool,other:span!==null&&tool!==null?Math.max(0,span-tool):null,pairedCalls:intervals.length};
}
export interface FileRow {
  path:string; calls:number; characters:number; read:number; write:number; search:number; image:number;
  addedLines:number|null; removedLines:number|null; lastAt:string|null; items:ActivityItem[];
}
export function fileRows(items:ActivityItem[]):FileRow[] {
  const rows=new Map<string,FileRow>();
  for (const item of items) {
    if (item.category!=="tool_call") continue;
    const operations=item.fileOperations??(item.file?[{path:item.file,kind:"other" as FileOperationKind,addedLines:null,removedLines:null}]:[]);
    const byPath=new Map<string,typeof operations>();
    for (const operation of operations) byPath.set(operation.path,[...(byPath.get(operation.path)??[]),operation]);
    for (const [path,ops] of byPath) {
      const row=rows.get(path)??{path,calls:0,characters:0,read:0,write:0,search:0,image:0,addedLines:0,removedLines:0,lastAt:null,items:[]};
      row.calls++;row.characters+=item.characters;row.items.push(item);
      const kinds=new Set(ops.map(operation=>operation.kind));
      for (const kind of kinds) if (kind!=="other") row[kind]++;
      for (const operation of ops) if (operation.kind==="write"||operation.kind==="other") {
        row.addedLines=row.addedLines===null||operation.addedLines===null?null:row.addedLines+operation.addedLines;
        row.removedLines=row.removedLines===null||operation.removedLines===null?null:row.removedLines+operation.removedLines;
      }
      if (Number.isFinite(Date.parse(item.timestamp)) && (row.lastAt===null||Date.parse(item.timestamp)>Date.parse(row.lastAt))) row.lastAt=item.timestamp;
      rows.set(path,row);
    }
  }
  return [...rows.values()];
}
export function trendGroups(snapshots:RawContextSnapshot[], byTurn:boolean) {
  const groups:Array<{snapshot:RawContextSnapshot;index:number;count:number}>=[];
  snapshots.forEach((snapshot,index)=>{
    const last=groups.at(-1);
    if (byTurn && typeof snapshot.turnId==="string" && snapshot.turnId.length>0 && last?.snapshot.turnId===snapshot.turnId) {last.snapshot=snapshot;last.index=index;last.count++;}
    else groups.push({snapshot,index,count:1});
  });
  return groups;
}
