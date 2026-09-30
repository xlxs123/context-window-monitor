import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ContextProvider, ContextProviderOptions } from "../context-provider.js";
import type {
  CompactionMarker,
  ProviderResult,
  RawContextSnapshot,
  SessionRegistration,
  SessionSelection,
} from "../context-types.js";
import {
  createParsedRolloutState,
  parseRolloutLine,
  type ParsedRolloutState,
} from "./rollout-event-parser.js";
import { SessionRegistry } from "./session-registry.js";
import { digest, object, summarizeActivity, visibleText } from "./activity-tracker.js";

const INITIAL_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOTS = 80;
const MAX_COMPACTIONS = 20;

interface TailCache {
  offset: number;
  carry: Buffer;
  skipFirst: boolean;
  state: ParsedRolloutState;
}

interface LocatedSession {
  registration: SessionRegistration;
  selection: SessionSelection;
}

export function selectSnapshotsForModel(
  snapshots: RawContextSnapshot[],
  activeModel: string | null,
): RawContextSnapshot[] {
  if (!activeModel) return snapshots;
  return snapshots.filter(
    (snapshot) => snapshot.model === null || snapshot.model === activeModel,
  );
}

function usableEnvironmentPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("${")) return null;
  return path.resolve(trimmed);
}

function codexSessionsRoot(): string {
  const codexDirectory =
    usableEnvironmentPath(process.env.CODEX_HOME) ?? path.join(homedir(), ".codex");
  return path.join(codexDirectory, "sessions");
}

function sessionIdFromFilename(filePath: string): string {
  const match = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu,
  );
  return match?.[1] ?? path.basename(filePath, ".jsonl");
}

async function existingFile(filePath: string | null): Promise<string | null> {
  if (!filePath) return null;
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? path.resolve(filePath) : null;
  } catch {
    return null;
  }
}

async function recentRolloutFiles(): Promise<string[]> {
  const root = codexSessionsRoot();
  const files: string[] = [];
  let years;
  try {
    years = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 2);
  } catch {
    return [];
  }

  for (const year of years) {
    const yearPath = path.join(root, year);
    const months = (await fs.readdir(yearPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 3);

    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      const days = (await fs.readdir(monthPath, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse()
        .slice(0, 14);

      for (const day of days) {
        const dayPath = path.join(monthPath, day);
        const dayFiles = await fs.readdir(dayPath, { withFileTypes: true });
        files.push(
          ...dayFiles
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => path.join(dayPath, entry.name)),
        );
      }
    }
  }
  return files;
}

async function locateRollout(sessionId?: string): Promise<string | null> {
  const files = await recentRolloutFiles();
  if (sessionId) {
    return files.find((filePath) => sessionIdFromFilename(filePath) === sessionId) ?? null;
  }

  const withStats = await Promise.all(
    files.map(async (filePath) => ({ filePath, stats: await fs.stat(filePath) })),
  );
  return (
    withStats.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0]
      ?.filePath ?? null
  );
}

export class RolloutContextProvider implements ContextProvider {
  private readonly caches = new Map<string, TailCache>();
  private readonly reading = new Map<string, Promise<ParsedRolloutState>>();

  constructor(private readonly registry = new SessionRegistry()) {}

  /** Project actions do not expose the selected chat ID. Pick a recent project log explicitly. */
  async latestSessionForDirectory(directory: string): Promise<string | null> {
    const root = path.resolve(directory);
    const files = await recentRolloutFiles();
    const recent = (await Promise.all(files.map(async file => ({file, modified: await fs.stat(file).then(s => s.mtimeMs).catch(() => 0)}))))
      .sort((a, b) => b.modified - a.modified).slice(0, 200);
    for (const {file} of recent) {
      try {
        const header = await this.readHeader(file);
        const record = header ? JSON.parse(header) : null;
        if (record?.type !== "session_meta" || typeof record.payload?.cwd !== "string") continue;
        const relative = path.relative(root, path.resolve(record.payload.cwd));
        if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return sessionIdFromFilename(file);
      } catch { /* A concurrently rotated or partial header is not a usable candidate. */ }
    }
    return null;
  }

  async listSessions(limit=20):Promise<Array<{sessionId:string;model:string|null;lastSeenAt:string;active:boolean;parentSessionId:string|null;agentName:string|null}>> {
    const registered=await this.registry.list(limit);
    const files=await recentRolloutFiles();
    const recent=(await Promise.all(files.map(async file=>({file,stats:await fs.stat(file)})))).sort((a,b)=>b.stats.mtimeMs-a.stats.mtimeMs).slice(0,limit);
    const result=new Map(registered.map(s=>[s.sessionId,{sessionId:s.sessionId,model:s.model,lastSeenAt:s.lastSeenAt,active:s.endedAt===null,parentSessionId:null as string|null,agentName:null as string|null}]));
    for(const {file,stats} of recent){
      const id=sessionIdFromFilename(file);const meta=await this.readHeader(file);
      const state=createParsedRolloutState(id,null);if(meta)parseRolloutLine(meta,"explicit",state);
      const previous=result.get(id);
      result.set(id,{sessionId:id,model:previous?.model??null,lastSeenAt:stats.mtime.toISOString(),active:previous?.active??false,parentSessionId:state.parentSessionId,agentName:state.agentName});
    }
    return [...result.values()].sort((a,b)=>b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0,limit);
  }

  async readItem(sessionId:string,itemId:string):Promise<{id:string;text:string;truncated:boolean;scope:string}> {
    await this.getContext({sessionId});
    const entry=[...this.caches.entries()].find(([,c])=>c.state.sessionId===sessionId&&c.state.locations.has(itemId));
    if(!entry)throw new Error("该记录不在保留范围内；请刷新后重试。");
    const [file,cache]=entry;const location=cache.state.locations.get(itemId)!;
    const handle=await fs.open(file,"r");let raw:Buffer;
    try{raw=Buffer.alloc(location.length);await handle.read(raw,0,raw.length,location.offset);}finally{await handle.close();}
    const payload=object(object(JSON.parse(raw.toString("utf8")))?.payload);if(!payload)throw new Error("记录无法解析。");
    const body=visibleText(payload);const expected=cache.state.activity.find(i=>i.id===itemId);
    if(!expected||digest(body)!==expected.hash)throw new Error("日志内容已变化，请重新读取。");
    return {id:itemId,text:body.slice(0,32768),truncated:body.length>32768,scope:"Codex 日志公开记录；不是完整模型请求；不解密 reasoning"};
  }

  private async readHeader(file:string):Promise<string|null>{
    const h=await fs.open(file,"r");try{const buffer=Buffer.alloc(256*1024);const {bytesRead}=await h.read(buffer,0,buffer.length,0);const end=buffer.subarray(0,bytesRead).indexOf(10);return end<0?null:buffer.subarray(0,end).toString("utf8");}finally{await h.close();}
  }

  async getContext(options: ContextProviderOptions = {}): Promise<ProviderResult> {
    if(options.sessionId&&!/^[a-zA-Z0-9_-]{1,128}$/u.test(options.sessionId))throw new Error("Invalid session ID");
    const warnings: string[] = [];
    const located = await this.locateSession(options.sessionId);
    if (!located) {
      return {
        session: null,
        selection: "unavailable",
        snapshots: [],
        compactions: [],
        hookEvents: [],
        warnings: [
          "No active Codex session was registered and no recent rollout file was found.",
        ],
      };
    }

    const transcriptPath = await existingFile(located.registration.transcriptPath);
    const fallbackPath = transcriptPath
      ? null
      : await locateRollout(located.registration.sessionId);
    const effectivePath = transcriptPath ?? fallbackPath;
    if (!effectivePath) {
      return {
        session: located.registration,
        selection: located.selection,
        snapshots: [],
        compactions: [],
        hookEvents: await this.registry.hookEvents(located.registration.sessionId),
        warnings: ["The registered Codex transcript is unavailable."],
      };
    }
    if (!transcriptPath) {
      warnings.push("The registered transcript path was unavailable; matched by session ID.");
    }

    const parsed = await this.readIncremental(
      effectivePath,
      located.selection,
      located.registration,
    );
    const hookEvents = await this.registry.hookEvents(located.registration.sessionId);
    const hookCompactions: CompactionMarker[] = hookEvents
      .filter((event) => event.eventName === "PostCompact")
      .map((event) => ({
        timestamp: event.timestamp,
        trigger:
          event.trigger === "manual" || event.trigger === "auto"
            ? event.trigger
            : "unknown",
        source: "hook",
      }));

    const compactions = [...parsed.compactions];
    for (const marker of hookCompactions) {
      const markerTime = Date.parse(marker.timestamp);
      const duplicate = compactions.some(
        (current) => Math.abs(Date.parse(current.timestamp) - markerTime) < 2_000,
      );
      if (!duplicate) compactions.push(marker);
    }

    const modelSnapshots = selectSnapshotsForModel(
      parsed.snapshots,
      located.registration.model,
    );
    if (parsed.snapshots.length > 0 && modelSnapshots.length === 0) {
      warnings.push(
        `Codex token snapshots were found, but none matched active model ${located.registration.model ?? "unknown"}; auxiliary-model values were not substituted.`,
      );
    }

    return {
      session: located.registration,
      selection: located.selection,
      snapshots: modelSnapshots.map((snapshot) => ({
        ...snapshot,
        model: snapshot.model ?? located.registration.model,
      })),
      compactions: compactions.slice(-MAX_COMPACTIONS),
      hookEvents,
      warnings,
      activity:summarizeActivity(parsed.activity,parsed.truncated,parsed.parentSessionId,parsed.agentName),
    };
  }

  private async locateSession(sessionId?: string): Promise<LocatedSession | null> {
    if (sessionId) {
      const registered = await this.registry.get(sessionId);
      if (registered) return { registration: registered, selection: "explicit" };

      const filePath = [...this.caches.entries()].find(([,cache])=>cache.state.sessionId===sessionId)?.[0] ?? await locateRollout(sessionId);
      if (!filePath) return null;
      const stats = await fs.stat(filePath);
      return {
        selection: "explicit",
        registration: {
          sessionId,
          transcriptPath: filePath,
          cwd: null,
          model: null,
          lastSeenAt: stats.mtime.toISOString(),
          lastHookEvent: "ExplicitSessionLookup",
          endedAt: null,
        },
      };
    }

    const active = (await this.registry.list()).find((session) => session.endedAt === null);
    if (active) return { registration: active, selection: "active-hook" };

    const latestPath = await locateRollout();
    if (!latestPath) return null;
    const stats = await fs.stat(latestPath);
    return {
      selection: "latest-rollout",
      registration: {
        sessionId: sessionIdFromFilename(latestPath),
        transcriptPath: latestPath,
        cwd: null,
        model: null,
        lastSeenAt: stats.mtime.toISOString(),
        lastHookEvent: "LatestRolloutFallback",
        endedAt: null,
      },
    };
  }

  private async readIncremental(
    filePath:string,selection:SessionSelection,registration:SessionRegistration,
  ):Promise<ParsedRolloutState>{
    const previous=this.reading.get(filePath);
    const job=(previous??Promise.resolve()).catch(()=>undefined).then(()=>this.readTail(filePath,selection,registration));
    this.reading.set(filePath,job);
    try{return await job;}finally{if(this.reading.get(filePath)===job)this.reading.delete(filePath);}
  }

  private async readTail(
    filePath: string,
    selection: SessionSelection,
    registration: SessionRegistration,
  ): Promise<ParsedRolloutState> {
    const stats = await fs.stat(filePath);
    let cache = this.caches.get(filePath);
    if (!cache || stats.size < cache.offset || stats.size-cache.offset>INITIAL_TAIL_BYTES) {
      const offset=Math.max(stats.size-INITIAL_TAIL_BYTES,0);
      cache = {
        offset,
        carry: Buffer.alloc(0),
        skipFirst:offset>0,
        state: createParsedRolloutState(registration.sessionId, registration.model),
      };
      cache.state.truncated=offset>0;
      if(offset>0){const header=await this.readHeader(filePath);if(header)parseRolloutLine(header,selection,cache.state);}
      this.caches.set(filePath, cache);
      while(this.caches.size>12)this.caches.delete(this.caches.keys().next().value!);
    }

    if (!cache) {
      throw new Error("Failed to initialize the rollout tail cache.");
    }

    if (stats.size === cache.offset) return cache.state;
    const length = stats.size - cache.offset;
    const handle = await fs.open(filePath, "r");
    let bytes: Buffer;
    let startOffset=cache.offset-cache.carry.length;
    try {
      const buffer = Buffer.alloc(length);
      const {bytesRead}=await handle.read(buffer, 0, length, cache.offset);
      bytes = Buffer.concat([cache.carry,buffer.subarray(0,bytesRead)]);
      cache.offset+=bytesRead;
    } finally {
      await handle.close();
    }

    if (cache.skipFirst) {
      const firstNewline=bytes.indexOf(10);
      if(firstNewline<0){cache.carry=Buffer.alloc(0);return cache.state;}
      startOffset+=firstNewline+1;bytes=bytes.subarray(firstNewline+1);cache.skipFirst=false;
    }
    let start=0;
    for(let end=bytes.indexOf(10,start);end>=0;end=bytes.indexOf(10,start)){
      const line=bytes.subarray(start,end).toString("utf8");
      if(line)parseRolloutLine(line,selection,cache.state,{offset:startOffset+start,length:end-start});
      start=end+1;
    }
    cache.carry=Buffer.from(bytes.subarray(start));
    if(cache.carry.length>INITIAL_TAIL_BYTES){cache.carry=Buffer.alloc(0);cache.skipFirst=true;cache.state.truncated=true;}

    cache.state.snapshots = cache.state.snapshots.slice(-MAX_SNAPSHOTS);
    cache.state.compactions = cache.state.compactions.slice(-MAX_COMPACTIONS);
    if(cache.state.activity.length>500){cache.state.activity=cache.state.activity.slice(-500);cache.state.truncated=true;}
    const ids=new Set(cache.state.activity.map(i=>i.id));for(const id of cache.state.locations.keys())if(!ids.has(id))cache.state.locations.delete(id);
    return cache.state;
  }
}
