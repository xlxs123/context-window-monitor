import type {
  CompactionMarker,
  RawContextSnapshot,
  SessionSelection,
  TokenUsageBreakdown,
  ActivityItem,
} from "../context-types.js";
import { activityItem, object } from "./activity-tracker.js";

interface ObjectValue {
  [key: string]: unknown;
}

export interface ParsedRolloutState {
  snapshots: RawContextSnapshot[];
  compactions: CompactionMarker[];
  model: string | null;
  sessionId: string | null;
  turnId: string | null;
  contextWindow: number | null;
  activity: ActivityItem[];
  locations: Map<string,{offset:number;length:number}>;
  truncated: boolean;
  parentSessionId: string | null;
  agentName: string | null;
}

function objectValue(value: unknown): ObjectValue | null {
  return typeof value === "object" && value !== null ? (value as ObjectValue) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function numberFrom(object: ObjectValue, camel: string, snake: string): number | null {
  return nonNegativeNumber(object[camel] ?? object[snake]);
}

function tokenBreakdown(value: unknown): TokenUsageBreakdown | null {
  const object = objectValue(value);
  if (!object) return null;

  const totalTokens = numberFrom(object, "totalTokens", "total_tokens");
  const inputTokens = numberFrom(object, "inputTokens", "input_tokens");
  const cachedInputTokens = numberFrom(
    object,
    "cachedInputTokens",
    "cached_input_tokens",
  );
  const cacheWriteInputTokens = numberFrom(
    object,
    "cacheWriteInputTokens",
    "cache_write_input_tokens",
  );
  const outputTokens = numberFrom(object, "outputTokens", "output_tokens");
  const reasoningOutputTokens = numberFrom(
    object,
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  );

  if (
    totalTokens === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    cacheWriteInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null
  ) {
    return null;
  }

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
  };
}

function normalizeTimestamp(value: unknown): string {
  const stringTimestamp = stringValue(value);
  if (stringTimestamp && Number.isFinite(Date.parse(stringTimestamp))) {
    return new Date(stringTimestamp).toISOString();
  }
  return new Date().toISOString();
}

function addCompaction(
  state: ParsedRolloutState,
  marker: CompactionMarker,
): void {
  const duplicate = state.compactions.some(
    (current) =>
      current.timestamp === marker.timestamp && current.trigger === marker.trigger,
  );
  if (!duplicate) state.compactions.push(marker);
}

function parseAppServerEvent(
  root: ObjectValue,
  timestamp: string,
  selection: SessionSelection,
  state: ParsedRolloutState,
): boolean {
  const method = stringValue(root.method);
  const params = objectValue(root.params);
  if (method === "thread/tokenUsage/updated" && params) {
    const usage = objectValue(params.tokenUsage);
    if (!usage) return true;
    const last = tokenBreakdown(usage.last);
    const cumulative = tokenBreakdown(usage.total);
    const sessionId = stringValue(params.threadId) ?? state.sessionId;
    if (!last || !cumulative || !sessionId) return true;

    state.sessionId = sessionId;
    state.turnId = stringValue(params.turnId) ?? state.turnId;
    state.snapshots.push({
      sessionId,
      timestamp,
      source: "app-server-event",
      selection,
      last,
      cumulative,
      modelContextWindow: nonNegativeNumber(usage.modelContextWindow),
      model: state.model,
      turnId: state.turnId,
    });
    return true;
  }

  if (method === "item/completed" && params) {
    const item = objectValue(params.item);
    if (item?.type === "contextCompaction") {
      addCompaction(state, {
        timestamp,
        trigger: "unknown",
        source: "app-server-event",
      });
    }
    return true;
  }
  return false;
}

export function parseRolloutLine(
  line: string,
  selection: SessionSelection,
  state: ParsedRolloutState,
  location?: {offset:number;length:number},
): void {
  let root: ObjectValue;
  try {
    const parsed = objectValue(JSON.parse(line));
    if (!parsed) return;
    root = parsed;
  } catch {
    return;
  }

  const timestamp = normalizeTimestamp(root.timestamp);
  const item=activityItem(root,location?String(location.offset):`record-${state.activity.length}`,timestamp);
  if(item){state.activity.push(item);if(location)state.locations.set(item.id,location);}
  if (parseAppServerEvent(root, timestamp, selection, state)) return;

  const envelopeType = stringValue(root.type);
  const payload = objectValue(root.payload);
  if (!payload) return;

  if (envelopeType === "session_meta") {
    state.sessionId = stringValue(payload.id) ?? state.sessionId;
    const spawn=object(object(object(payload.source)?.subagent)?.thread_spawn);
    state.parentSessionId=stringValue(spawn?.parent_thread_id);
    state.agentName=stringValue(spawn?.agent_nickname)??stringValue(spawn?.agent_path);
    return;
  }

  if (envelopeType === "turn_context") {
    state.model = stringValue(payload.model) ?? state.model;
    state.turnId = stringValue(payload.turn_id) ?? state.turnId;
    return;
  }

  const payloadType = stringValue(payload.type);
  if(envelopeType==="event_msg"&&payloadType==="task_started")state.contextWindow=nonNegativeNumber(payload.model_context_window);
  if(envelopeType==="token_usage_record"){
    const last=tokenBreakdown(payload.usage);const cumulative=tokenBreakdown(payload.thread_token_usage);
    if(last&&cumulative&&state.sessionId){
      state.snapshots.push({sessionId:state.sessionId,timestamp,source:"rollout-log",selection,last,cumulative,modelContextWindow:state.contextWindow,model:state.model,turnId:stringValue(payload.turn_id)??state.turnId});
    }
    return;
  }
  if (envelopeType === "event_msg" && payloadType === "token_count") {
    const info = objectValue(payload.info);
    const last = tokenBreakdown(info?.last_token_usage);
    const cumulative = tokenBreakdown(info?.total_token_usage);
    const sessionId = state.sessionId;
    if (!info || !last || !cumulative || !sessionId) return;

    state.contextWindow=nonNegativeNumber(info.model_context_window);
    // New runtimes emit both token_usage_record and token_count for the same report.
    const previous=state.snapshots.at(-1);
    if(previous&&JSON.stringify(previous.last)===JSON.stringify(last)&&JSON.stringify(previous.cumulative)===JSON.stringify(cumulative)){
      previous.modelContextWindow=state.contextWindow;
      return;
    }
    state.snapshots.push({
      sessionId,
      timestamp,
      source: "rollout-log",
      selection,
      last,
      cumulative,
      modelContextWindow: nonNegativeNumber(info.model_context_window),
      model: state.model,
      turnId: state.turnId,
    });
    return;
  }

  const isCompaction = envelopeType === "compacted" ||
    (envelopeType === "response_item" &&
      ["compaction", "compaction_trigger", "context_compaction"].includes(
        payloadType ?? "",
      )) ||
    (envelopeType === "event_msg" &&
      ["context_compacted", "thread_compacted"].includes(payloadType ?? ""));

  if (isCompaction) {
    const rawTrigger = stringValue(payload.trigger) ?? stringValue(payload.compaction_trigger);
    addCompaction(state, {
      timestamp,
      trigger: rawTrigger === "auto" || rawTrigger === "manual" ? rawTrigger : "unknown",
      source: "rollout-log",
    });
  }
}

export function createParsedRolloutState(
  sessionId: string | null,
  model: string | null,
): ParsedRolloutState {
  return {
    snapshots: [],
    compactions: [],
    model,
    sessionId,
    turnId: null,
    contextWindow: null,
    activity: [],
    locations: new Map(),
    truncated: false,
    parentSessionId: null,
    agentName: null,
  };
}
