import { createHash } from "node:crypto";
import type { ActivityCategory, ActivityFileOperation, ActivityItem, ActivityReport, FileOperationKind } from "../context-types.js";

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

const operationKinds: Record<FileOperationKind, ReadonlySet<string>> = {
  read: new Set(["read", "read_file", "read_text_file", "read_binary_file", "read_multiple_files", "read_document", "read_notebook"]),
  write: new Set(["write", "write_file", "write_text_file", "append_file", "create_file", "edit", "edit_file", "replace_in_file", "delete_file", "remove_file", "move_file", "rename_file", "apply_patch"]),
  search: new Set(["search", "search_file", "search_files", "find_in_file", "find_in_files", "grep", "ripgrep", "rg", "glob"]),
  image: new Set(["view_image", "read_image", "open_image"]),
  other: new Set(),
};

function toolLeaf(name: string): string {
  return name.toLowerCase().split(/\.|__/u).at(-1) ?? name;
}

function operationKind(name: string): FileOperationKind {
  const leaf = toolLeaf(name);
  return (["read", "write", "search", "image"] as const).find(kind => operationKinds[kind].has(leaf)) ?? "other";
}

function filePath(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && !/[\r\n]/u.test(value) ? value : null;
}

interface PatchFile {
  path: string;
  action: "Add" | "Update" | "Delete";
  added: number;
  removed: number;
  moveTo: string | null;
  hasBody: boolean;
}

/** Count only the recorded patch syntax, never read files or execute its contents. */
function patchOperations(input: string): ActivityFileOperation[] {
  const lines = input.trim().split(/\r?\n/u);
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") return [];
  const operations: ActivityFileOperation[] = [];
  let current: PatchFile | null = null;
  const finish = (): void => {
    if (!current) return;
    if (current.moveTo) {
      // The source disappears and the destination receives its full contents,
      // whose size is absent from the patch. Do not duplicate hunk counts.
      operations.push({ path: current.path, kind: "write", addedLines: null, removedLines: null });
      if (current.moveTo !== current.path) operations.push({ path: current.moveTo, kind: "write", addedLines: null, removedLines: null });
    } else {
      operations.push({ path: current.path, kind: "write", addedLines: current.added, removedLines: current.action === "Delete" ? null : current.removed });
    }
  };
  for (const line of lines.slice(1, -1)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
    if (header) {
      const target = filePath(header[2]);
      if (!target) return [];
      finish();
      current = { path: target, action: header[1] as PatchFile["action"], added: 0, removed: 0, moveTo: null, hasBody: false };
      continue;
    }
    if (!current) return [];
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (move) {
      if (current.action !== "Update" || current.moveTo || current.hasBody) return [];
      current.moveTo = filePath(move[1]);
      if (!current.moveTo) return [];
      continue;
    }
    if (current.action === "Delete") return [];
    if (current.action === "Update" && (/^@@(?: |$)/u.test(line) || line === "*** End of File")) {
      current.hasBody = true;
      continue;
    }
    if (line.startsWith("+")) current.added++;
    else if (current.action === "Update" && line.startsWith("-")) current.removed++;
    else if (!(current.action === "Update" && line.startsWith(" "))) return [];
    current.hasBody = true;
  }
  finish();
  return operations;
}

function fileOperations(payload: Record<string, unknown>): ActivityFileOperation[] {
  const name = text(payload.name) ?? "";
  const input = payload.arguments ?? payload.input;
  if (toolLeaf(name) === "apply_patch" && typeof input === "string") {
    const patch = patchOperations(input);
    if (patch.length > 0) return patch;
  }
  let args = object(input);
  if (typeof input === "string") {
    try { args = object(JSON.parse(input)); }
    catch { return []; }
  }
  const target = filePath(args?.path) ?? filePath(args?.file_path) ?? filePath(args?.filename);
  return target ? [{ path: target, kind: operationKind(name), addedLines: null, removedLines: null }] : [];
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
  const operations=category==="tool_call"?fileOperations(payload):[];
  return {id,timestamp,category,type,role,name:text(payload.name)??role??type,callId:text(payload.call_id),messageId:text(payload.id),characters:body.length,hash:digest(body),file:operations[0]?.path??null,...(operations.length?{fileOperations:operations}:{}),tokens:null};
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
    if(i.category==="tool_call"){
      const operations=i.fileOperations??(i.file?[{path:i.file,kind:operationKind(i.name),addedLines:null,removedLines:null}]:[]);
      const byPath=new Map<string,ActivityFileOperation[]>();
      for(const op of operations)byPath.set(op.path,[...(byPath.get(op.path)??[]),op]);
      for(const [target,ops] of byPath){
        const f=files.get(target)??{path:target,calls:0,characters:0,readCalls:0,writeCalls:0,searchCalls:0,imageCalls:0,addedLines:0,removedLines:0,lastAt:null,itemIds:[]};
        f.calls++;f.characters+=i.characters;
        const kinds=new Set(ops.map(op=>op.kind));
        if(kinds.has("read"))f.readCalls=(f.readCalls??0)+1;
        if(kinds.has("write"))f.writeCalls=(f.writeCalls??0)+1;
        if(kinds.has("search"))f.searchCalls=(f.searchCalls??0)+1;
        if(kinds.has("image"))f.imageCalls=(f.imageCalls??0)+1;
        for(const op of ops)if(op.kind==="write"||op.kind==="other"){
          f.addedLines=f.addedLines===null||op.addedLines===null?null:(f.addedLines??0)+op.addedLines;
          f.removedLines=f.removedLines===null||op.removedLines===null?null:(f.removedLines??0)+op.removedLines;
        }
        if(Number.isFinite(Date.parse(i.timestamp))&&(!f.lastAt||Date.parse(i.timestamp)>Date.parse(f.lastAt)))f.lastAt=i.timestamp;
        f.itemIds??=[];if(!f.itemIds.includes(i.id))f.itemIds.push(i.id);
        files.set(target,f);
      }
    }
    if(i.characters>=256)hashes.set(i.hash,[...(hashes.get(i.hash)??[]),i]);
  }
  return {items:normalized,truncated,scope:"最近保留的日志记录；不代表当前模型完整上下文",parentSessionId,agentName,tools:[...tools.values()].sort((a,b)=>b.resultCharacters-a.resultCharacters),files:[...files.values()].sort((a,b)=>b.calls-a.calls),duplicates:[...hashes.values()].filter(a=>a.length>1).map(a=>({hash:a[0]!.hash,ids:a.map(i=>i.id),characters:a.slice(1).reduce((n,i)=>n+i.characters,0)}))};
}
