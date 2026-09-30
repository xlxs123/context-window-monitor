// src/context-history-tracker.ts
var CORRELATION_WINDOW_MS = 45e3;
function toMillis(timestamp) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}
function markerBetween(markers, before, after) {
  const start = toMillis(before);
  const end = toMillis(after);
  return markers.find((marker) => {
    const value = toMillis(marker.timestamp);
    return value > start && value <= end;
  }) ?? null;
}
function nearestHook(hooks, timestamp) {
  const target = toMillis(timestamp);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hook of hooks) {
    const distance = target - toMillis(hook.timestamp);
    if (distance >= 0 && distance <= CORRELATION_WINDOW_MS && distance < bestDistance) {
      best = hook;
      bestDistance = distance;
    }
  }
  return best;
}
function observedLabel(hook) {
  if (!hook) {
    return {
      label: "Context snapshot updated",
      detail: "No exact per-category attribution is exposed by Codex."
    };
  }
  switch (hook.eventName) {
    case "UserPromptSubmit":
      return {
        label: "Observed after user message",
        detail: "The delta is exact; attribution is a time correlation, not a token category split."
      };
    case "PostToolUse":
      return {
        label: hook.toolName ? `Observed after tool call: ${hook.toolName}` : "Observed after tool call",
        detail: "The delta is exact; attribution is a time correlation, not a token category split."
      };
    case "Stop":
      return {
        label: "Observed near assistant completion",
        detail: "The delta is exact; attribution is a time correlation, not a token category split."
      };
    default:
      return {
        label: `Observed after ${hook.eventName}`,
        detail: "The delta is exact; attribution is a time correlation, not a token category split."
      };
  }
}
var ContextHistoryTracker = class {
  changes(snapshots, markers, hooks, limit = 12) {
    const changes = [];
    const ordered = [...snapshots].sort(
      (left, right) => toMillis(left.timestamp) - toMillis(right.timestamp)
    );
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      if (!current) continue;
      const before = ordered[index - 1] ?? null;
      if (!before) {
        changes.push({
          id: `snapshot-${current.timestamp}`,
          timestamp: current.timestamp,
          kind: "snapshot",
          deltaTokens: null,
          beforeTokens: null,
          afterTokens: current.last.inputTokens,
          label: "Initial context snapshot",
          detail: "Exact server-reported model input tokens.",
          attribution: "snapshot-only"
        });
        continue;
      }
      const delta = current.last.inputTokens - before.last.inputTokens;
      const marker = markerBetween(markers, before.timestamp, current.timestamp);
      if (marker) {
        changes.push({
          id: `compaction-${marker.timestamp}`,
          timestamp: marker.timestamp,
          kind: "compaction",
          deltaTokens: delta,
          beforeTokens: before.last.inputTokens,
          afterTokens: current.last.inputTokens,
          label: "Context compacted",
          detail: `Compaction event reported by Codex (${marker.trigger} trigger).`,
          attribution: "exact-event"
        });
        continue;
      }
      const observed = observedLabel(nearestHook(hooks, current.timestamp));
      changes.push({
        id: `change-${current.timestamp}`,
        timestamp: current.timestamp,
        kind: delta >= 0 ? "increase" : "decrease",
        deltaTokens: delta,
        beforeTokens: before.last.inputTokens,
        afterTokens: current.last.inputTokens,
        label: observed.label,
        detail: observed.detail,
        attribution: "observed-correlation"
      });
    }
    return changes.slice(-limit).reverse();
  }
  compactions(snapshots, markers, limit = 6) {
    const ordered = [...snapshots].sort(
      (left, right) => toMillis(left.timestamp) - toMillis(right.timestamp)
    );
    return [...markers].sort((left, right) => toMillis(right.timestamp) - toMillis(left.timestamp)).slice(0, limit).map((marker) => {
      const markerTime = toMillis(marker.timestamp);
      const before = [...ordered].reverse().find((snapshot) => toMillis(snapshot.timestamp) < markerTime);
      const after = ordered.find((snapshot) => toMillis(snapshot.timestamp) > markerTime);
      const beforeTokens = before?.last.inputTokens ?? null;
      const afterTokens = after?.last.inputTokens ?? null;
      const reducedTokens = beforeTokens !== null && afterTokens !== null && beforeTokens >= afterTokens ? beforeTokens - afterTokens : null;
      return {
        timestamp: marker.timestamp,
        trigger: marker.trigger,
        beforeTokens,
        afterTokens,
        reducedTokens,
        precision: reducedTokens === null ? "unavailable" : "exact",
        detail: reducedTokens === null ? "Compaction is exact; before/after snapshots were not both available." : "Compaction and both surrounding token snapshots were reported by Codex."
      };
    });
  }
};

// src/context-status-bar.ts
var HEALTH_LABELS = {
  normal: "Normal",
  medium: "Medium",
  high: "High",
  danger: "Danger",
  unavailable: "Unavailable"
};
function compactNumber(value) {
  if (value < 1e3) return String(value);
  const divisor = value >= 1e6 ? 1e6 : 1e3;
  const suffix = value >= 1e6 ? "M" : "K";
  return `${(value / divisor).toFixed(value >= divisor * 100 ? 0 : 1)}${suffix}`;
}
var ContextStatusBar = class {
  format(usage) {
    if (usage.usedTokens === null || usage.totalTokens === null || usage.percentage === null) {
      return "Context: unavailable";
    }
    return `Context: ${compactNumber(usage.usedTokens)} / ${compactNumber(
      usage.totalTokens
    )} \xB7 ${usage.percentage.toFixed(1)}% \xB7 ${HEALTH_LABELS[usage.health]}`;
  }
};

// src/context-types.ts
var UNAVAILABLE_BREAKDOWN = [
  "System Instructions",
  "Conversation History",
  "Files / Attachments",
  "Tool Results",
  "Other Context"
].map((name) => ({
  name,
  value: null,
  precision: "unavailable"
}));

// src/context-usage-service.ts
var USED_DEFINITION = "Last server-reported model input tokens. No text-to-token estimation is used.";
function healthFor(percentage) {
  if (percentage === null) return "unavailable";
  if (percentage >= 90) return "danger";
  if (percentage >= 75) return "high";
  if (percentage >= 50) return "medium";
  return "normal";
}
function latestSnapshot(result) {
  return result.snapshots.at(-1) ?? null;
}
var ContextUsageService = class {
  calculate(result) {
    const snapshot = latestSnapshot(result);
    if (!snapshot) {
      return {
        precision: "unavailable",
        precisionDetail: "Codex has not reported a token-usage snapshot for this session.",
        usedTokens: null,
        totalTokens: null,
        remainingTokens: null,
        percentage: null,
        health: "unavailable",
        model: result.session?.model ?? null,
        sessionId: result.session?.sessionId ?? null,
        updatedAt: null,
        source: null,
        usedDefinition: USED_DEFINITION
      };
    }
    const usedTokens = snapshot.last.inputTokens;
    const totalTokens = snapshot.modelContextWindow;
    const remainingTokens = totalTokens === null ? null : Math.max(totalTokens - usedTokens, 0);
    const percentage = totalTokens === null || totalTokens <= 0 ? null : usedTokens / totalTokens * 100;
    const exactSession = snapshot.selection === "active-hook" || snapshot.selection === "explicit";
    return {
      precision: exactSession ? "exact" : "estimated",
      precisionDetail: exactSession ? "Exact Codex values matched to the active session by a lifecycle hook or explicit session ID." : "Token values are exact, but the current session was selected by latest-rollout fallback.",
      usedTokens,
      totalTokens,
      remainingTokens,
      percentage,
      health: healthFor(percentage),
      model: snapshot.model ?? result.session?.model ?? null,
      sessionId: snapshot.sessionId,
      updatedAt: snapshot.timestamp,
      source: snapshot.source,
      usedDefinition: USED_DEFINITION
    };
  }
  breakdown(result) {
    const snapshot = latestSnapshot(result);
    if (!snapshot) {
      return {
        currentModelInputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        uncachedInputTokens: null,
        lastOutputTokens: null,
        reasoningOutputTokens: null,
        cumulativeThreadTokens: null
      };
    }
    return {
      currentModelInputTokens: snapshot.last.inputTokens,
      cachedInputTokens: snapshot.last.cachedInputTokens,
      cacheWriteInputTokens: snapshot.last.cacheWriteInputTokens,
      uncachedInputTokens: Math.max(
        snapshot.last.inputTokens - snapshot.last.cachedInputTokens - snapshot.last.cacheWriteInputTokens,
        0
      ),
      lastOutputTokens: snapshot.last.outputTokens,
      reasoningOutputTokens: snapshot.last.reasoningOutputTokens,
      cumulativeThreadTokens: snapshot.cumulative.totalTokens
    };
  }
};

// src/context-monitor-service.ts
var ContextMonitorService = class {
  constructor(provider2, usageService = new ContextUsageService(), historyTracker = new ContextHistoryTracker(), statusBar = new ContextStatusBar()) {
    this.provider = provider2;
    this.usageService = usageService;
    this.historyTracker = historyTracker;
    this.statusBar = statusBar;
  }
  provider;
  usageService;
  historyTracker;
  statusBar;
  async dashboard(sessionId) {
    const providerResult = await this.provider.getContext(
      sessionId ? { sessionId } : void 0
    );
    const usage = this.usageService.calculate(providerResult);
    const exactBreakdown = this.usageService.breakdown(providerResult);
    const warnings = [...providerResult.warnings];
    if (usage.totalTokens === null) {
      warnings.push("Codex did not report the model context-window capacity.");
    }
    warnings.push(
      "System/history/files/tool-result token categories are not exposed and are shown as unavailable."
    );
    return {
      schemaVersion: 1,
      usage,
      statusText: this.statusBar.format(usage),
      exactBreakdown,
      unavailableBreakdown: UNAVAILABLE_BREAKDOWN.map((category) => ({ ...category })),
      recentChanges: this.historyTracker.changes(
        providerResult.snapshots,
        providerResult.compactions,
        providerResult.hookEvents
      ),
      compactions: this.historyTracker.compactions(
        providerResult.snapshots,
        providerResult.compactions,
        20
      ),
      cumulativeTokens: exactBreakdown.cumulativeThreadTokens,
      warnings,
      refreshIntervalMs: 5e3,
      snapshots: providerResult.snapshots,
      ...providerResult.activity ? { activity: providerResult.activity } : {}
    };
  }
};

// src/providers/rollout-context-provider.ts
import { promises as fs2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path2 from "node:path";

// src/providers/activity-tracker.ts
import { createHash } from "node:crypto";
var object = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
var text = (v) => typeof v === "string" ? v : null;
var digest = (v) => createHash("sha256").update(v).digest("hex");
function visibleText(payload) {
  if (typeof payload.arguments === "string") return payload.arguments;
  if (typeof payload.input === "string") return payload.input;
  if (typeof payload.output === "string") return payload.output;
  if (Array.isArray(payload.output)) return payload.output.map((v) => visibleText(object(v) ?? {})).join("\n");
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.message === "string") return payload.message;
  const blocks = Array.isArray(payload.content) ? payload.content : Array.isArray(payload.summary) ? payload.summary : [];
  return blocks.map((v) => text(object(v)?.text) ?? "").filter(Boolean).join("\n");
}
function activityItem(root, id, timestamp) {
  const payload = object(root.payload);
  if (!payload) return null;
  const type = text(payload.type) ?? String(root.type);
  if (root.type !== "response_item" && root.type !== "compacted") return null;
  let category = "other";
  const role = text(payload.role);
  if (type === "message" && ["system", "developer", "user", "assistant"].includes(role ?? "")) category = role;
  else if (type === "reasoning") category = "reasoning";
  else if (["function_call", "custom_tool_call", "web_search_call"].includes(type)) category = "tool_call";
  else if (["function_call_output", "custom_tool_call_output"].includes(type)) category = "tool_result";
  else if (root.type === "compacted" || ["compaction", "context_compaction"].includes(type)) category = "compaction";
  const body = visibleText(payload);
  let file = null;
  if (category === "tool_call") try {
    const args = object(JSON.parse(text(payload.arguments) ?? text(payload.input) ?? "null"));
    file = text(args?.path) ?? text(args?.file_path) ?? null;
  } catch {
  }
  return { id, timestamp, category, type, role, name: text(payload.name) ?? role ?? type, callId: text(payload.call_id), messageId: text(payload.id), characters: body.length, hash: digest(body), file, tokens: null };
}
function summarizeActivity(items, truncated, parentSessionId, agentName) {
  const calls = new Map(items.filter((i) => i.category === "tool_call" && i.callId).map((i) => [i.callId, i.name]));
  const normalized = items.map((i) => i.category === "tool_result" ? { ...i, name: calls.get(i.callId) ?? "\u672A\u5173\u8054\u5DE5\u5177\u7ED3\u679C" } : i);
  const tools = /* @__PURE__ */ new Map();
  const files = /* @__PURE__ */ new Map();
  const hashes = /* @__PURE__ */ new Map();
  for (const i of normalized) {
    if (i.category === "tool_call" || i.category === "tool_result") {
      const t = tools.get(i.name) ?? { name: i.name, calls: 0, results: 0, argumentCharacters: 0, resultCharacters: 0, tokens: null };
      if (i.category === "tool_call") {
        t.calls++;
        t.argumentCharacters += i.characters;
      } else {
        t.results++;
        t.resultCharacters += i.characters;
      }
      tools.set(i.name, t);
    }
    if (i.file) {
      const f = files.get(i.file) ?? { path: i.file, calls: 0, characters: 0 };
      f.calls++;
      f.characters += i.characters;
      files.set(i.file, f);
    }
    if (i.characters >= 256) hashes.set(i.hash, [...hashes.get(i.hash) ?? [], i]);
  }
  return { items: normalized, truncated, scope: "\u6700\u8FD1\u4FDD\u7559\u7684\u65E5\u5FD7\u8BB0\u5F55\uFF1B\u4E0D\u4EE3\u8868\u5F53\u524D\u6A21\u578B\u5B8C\u6574\u4E0A\u4E0B\u6587", parentSessionId, agentName, tools: [...tools.values()].sort((a, b) => b.resultCharacters - a.resultCharacters), files: [...files.values()].sort((a, b) => b.calls - a.calls), duplicates: [...hashes.values()].filter((a) => a.length > 1).map((a) => ({ hash: a[0].hash, ids: a.map((i) => i.id), characters: a.slice(1).reduce((n, i) => n + i.characters, 0) })) };
}

// src/providers/rollout-event-parser.ts
function objectValue(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function numberFrom(object2, camel, snake) {
  return nonNegativeNumber(object2[camel] ?? object2[snake]);
}
function tokenBreakdown(value) {
  const object2 = objectValue(value);
  if (!object2) return null;
  const totalTokens = numberFrom(object2, "totalTokens", "total_tokens");
  const inputTokens = numberFrom(object2, "inputTokens", "input_tokens");
  const cachedInputTokens = numberFrom(
    object2,
    "cachedInputTokens",
    "cached_input_tokens"
  );
  const cacheWriteInputTokens = numberFrom(
    object2,
    "cacheWriteInputTokens",
    "cache_write_input_tokens"
  );
  const outputTokens = numberFrom(object2, "outputTokens", "output_tokens");
  const reasoningOutputTokens = numberFrom(
    object2,
    "reasoningOutputTokens",
    "reasoning_output_tokens"
  );
  if (totalTokens === null || inputTokens === null || cachedInputTokens === null || cacheWriteInputTokens === null || outputTokens === null || reasoningOutputTokens === null) {
    return null;
  }
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens
  };
}
function normalizeTimestamp(value) {
  const stringTimestamp = stringValue(value);
  if (stringTimestamp && Number.isFinite(Date.parse(stringTimestamp))) {
    return new Date(stringTimestamp).toISOString();
  }
  return (/* @__PURE__ */ new Date()).toISOString();
}
function addCompaction(state, marker) {
  const duplicate = state.compactions.some(
    (current) => current.timestamp === marker.timestamp && current.trigger === marker.trigger
  );
  if (!duplicate) state.compactions.push(marker);
}
function parseAppServerEvent(root, timestamp, selection, state) {
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
      turnId: state.turnId
    });
    return true;
  }
  if (method === "item/completed" && params) {
    const item = objectValue(params.item);
    if (item?.type === "contextCompaction") {
      addCompaction(state, {
        timestamp,
        trigger: "unknown",
        source: "app-server-event"
      });
    }
    return true;
  }
  return false;
}
function parseRolloutLine(line, selection, state, location) {
  let root;
  try {
    const parsed = objectValue(JSON.parse(line));
    if (!parsed) return;
    root = parsed;
  } catch {
    return;
  }
  const timestamp = normalizeTimestamp(root.timestamp);
  const item = activityItem(root, location ? String(location.offset) : `record-${state.activity.length}`, timestamp);
  if (item) {
    state.activity.push(item);
    if (location) state.locations.set(item.id, location);
  }
  if (parseAppServerEvent(root, timestamp, selection, state)) return;
  const envelopeType = stringValue(root.type);
  const payload = objectValue(root.payload);
  if (!payload) return;
  if (envelopeType === "session_meta") {
    state.sessionId = stringValue(payload.id) ?? state.sessionId;
    const spawn = object(object(object(payload.source)?.subagent)?.thread_spawn);
    state.parentSessionId = stringValue(spawn?.parent_thread_id);
    state.agentName = stringValue(spawn?.agent_nickname) ?? stringValue(spawn?.agent_path);
    return;
  }
  if (envelopeType === "turn_context") {
    state.model = stringValue(payload.model) ?? state.model;
    state.turnId = stringValue(payload.turn_id) ?? state.turnId;
    return;
  }
  const payloadType = stringValue(payload.type);
  if (envelopeType === "event_msg" && payloadType === "task_started") state.contextWindow = nonNegativeNumber(payload.model_context_window);
  if (envelopeType === "token_usage_record") {
    const last = tokenBreakdown(payload.usage);
    const cumulative = tokenBreakdown(payload.thread_token_usage);
    if (last && cumulative && state.sessionId) {
      state.snapshots.push({ sessionId: state.sessionId, timestamp, source: "rollout-log", selection, last, cumulative, modelContextWindow: state.contextWindow, model: state.model, turnId: stringValue(payload.turn_id) ?? state.turnId });
    }
    return;
  }
  if (envelopeType === "event_msg" && payloadType === "token_count") {
    const info = objectValue(payload.info);
    const last = tokenBreakdown(info?.last_token_usage);
    const cumulative = tokenBreakdown(info?.total_token_usage);
    const sessionId = state.sessionId;
    if (!info || !last || !cumulative || !sessionId) return;
    state.contextWindow = nonNegativeNumber(info.model_context_window);
    const previous = state.snapshots.at(-1);
    if (previous && JSON.stringify(previous.last) === JSON.stringify(last) && JSON.stringify(previous.cumulative) === JSON.stringify(cumulative)) {
      previous.modelContextWindow = state.contextWindow;
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
      turnId: state.turnId
    });
    return;
  }
  const isCompaction = envelopeType === "compacted" || envelopeType === "response_item" && ["compaction", "compaction_trigger", "context_compaction"].includes(
    payloadType ?? ""
  ) || envelopeType === "event_msg" && ["context_compacted", "thread_compacted"].includes(payloadType ?? "");
  if (isCompaction) {
    const rawTrigger = stringValue(payload.trigger) ?? stringValue(payload.compaction_trigger);
    addCompaction(state, {
      timestamp,
      trigger: rawTrigger === "auto" || rawTrigger === "manual" ? rawTrigger : "unknown",
      source: "rollout-log"
    });
  }
}
function createParsedRolloutState(sessionId, model) {
  return {
    snapshots: [],
    compactions: [],
    model,
    sessionId,
    turnId: null,
    contextWindow: null,
    activity: [],
    locations: /* @__PURE__ */ new Map(),
    truncated: false,
    parentSessionId: null,
    agentName: null
  };
}

// src/providers/session-registry.ts
import { createHash as createHash2 } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
var EVENT_ROTATE_BYTES = 256 * 1024;
var EVENT_KEEP_BYTES = 128 * 1024;
function usableEnvironmentPath(value) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("${")) return null;
  return path.resolve(trimmed);
}
function resolveDataDirectory() {
  return usableEnvironmentPath(process.env.CONTEXT_MONITOR_DATA) ?? usableEnvironmentPath(process.env.PLUGIN_DATA) ?? path.join(homedir(), ".codex", "context-window-monitor");
}
function sessionKey(sessionId) {
  return createHash2("sha256").update(sessionId).digest("hex").slice(0, 32);
}
async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}
var SessionRegistry = class {
  dataDirectory;
  sessionsDirectory;
  eventsDirectory;
  constructor(dataDirectory = resolveDataDirectory()) {
    this.dataDirectory = dataDirectory;
    this.sessionsDirectory = path.join(dataDirectory, "sessions");
    this.eventsDirectory = path.join(dataDirectory, "events");
  }
  registrationPath(sessionId) {
    return path.join(this.sessionsDirectory, `${sessionKey(sessionId)}.json`);
  }
  eventsPath(sessionId) {
    return path.join(this.eventsDirectory, `${sessionKey(sessionId)}.jsonl`);
  }
  async record(input) {
    await fs.mkdir(this.sessionsDirectory, { recursive: true });
    await fs.mkdir(this.eventsDirectory, { recursive: true });
    const previous = await this.get(input.sessionId);
    const registration = {
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath ?? previous?.transcriptPath ?? null,
      cwd: input.cwd ?? previous?.cwd ?? null,
      model: input.model ?? previous?.model ?? null,
      lastSeenAt: input.timestamp,
      lastHookEvent: input.eventName,
      endedAt: input.eventName === "SessionEnd" ? input.timestamp : previous?.endedAt ?? null
    };
    await fs.writeFile(
      this.registrationPath(input.sessionId),
      `${JSON.stringify(registration, null, 2)}
`,
      "utf8"
    );
    await this.rotateEventsIfNeeded(input.sessionId);
    const event = {
      timestamp: input.timestamp,
      sessionId: input.sessionId,
      eventName: input.eventName,
      turnId: input.turnId,
      toolName: input.toolName,
      trigger: input.trigger
    };
    await fs.appendFile(this.eventsPath(input.sessionId), `${JSON.stringify(event)}
`, "utf8");
  }
  async get(sessionId) {
    return readJson(this.registrationPath(sessionId));
  }
  async list(limit = 50) {
    let names;
    try {
      names = await fs.readdir(this.sessionsDirectory);
    } catch {
      return [];
    }
    const registrations = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(this.sessionsDirectory, name)))
    );
    return registrations.filter((value) => value !== null).sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt)).slice(0, limit);
  }
  async hookEvents(sessionId, limit = 200) {
    let text2;
    try {
      text2 = await fs.readFile(this.eventsPath(sessionId), "utf8");
    } catch {
      return [];
    }
    return text2.split(/\r?\n/u).filter(Boolean).slice(-limit).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
  async rotateEventsIfNeeded(sessionId) {
    const eventPath = this.eventsPath(sessionId);
    let stats;
    try {
      stats = await fs.stat(eventPath);
    } catch {
      return;
    }
    if (stats.size <= EVENT_ROTATE_BYTES) return;
    const handle = await fs.open(eventPath, "r");
    try {
      const start = Math.max(stats.size - EVENT_KEEP_BYTES, 0);
      const buffer = Buffer.alloc(stats.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      let tail = buffer.toString("utf8");
      if (start > 0) {
        const firstNewline = tail.indexOf("\n");
        tail = firstNewline >= 0 ? tail.slice(firstNewline + 1) : "";
      }
      await fs.writeFile(eventPath, tail, "utf8");
    } finally {
      await handle.close();
    }
  }
};

// src/providers/rollout-context-provider.ts
var INITIAL_TAIL_BYTES = 2 * 1024 * 1024;
var MAX_SNAPSHOTS = 80;
var MAX_COMPACTIONS = 20;
function selectSnapshotsForModel(snapshots, activeModel) {
  if (!activeModel) return snapshots;
  return snapshots.filter(
    (snapshot) => snapshot.model === null || snapshot.model === activeModel
  );
}
function usableEnvironmentPath2(value) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("${")) return null;
  return path2.resolve(trimmed);
}
function codexSessionsRoot() {
  const codexDirectory = usableEnvironmentPath2(process.env.CODEX_HOME) ?? path2.join(homedir2(), ".codex");
  return path2.join(codexDirectory, "sessions");
}
function sessionIdFromFilename(filePath) {
  const match = path2.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu
  );
  return match?.[1] ?? path2.basename(filePath, ".jsonl");
}
async function existingFile(filePath) {
  if (!filePath) return null;
  try {
    const stats = await fs2.stat(filePath);
    return stats.isFile() ? path2.resolve(filePath) : null;
  } catch {
    return null;
  }
}
async function recentRolloutFiles() {
  const root = codexSessionsRoot();
  const files = [];
  let years;
  try {
    years = (await fs2.readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 2);
  } catch {
    return [];
  }
  for (const year of years) {
    const yearPath = path2.join(root, year);
    const months = (await fs2.readdir(yearPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 3);
    for (const month of months) {
      const monthPath = path2.join(yearPath, month);
      const days = (await fs2.readdir(monthPath, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 14);
      for (const day of days) {
        const dayPath = path2.join(monthPath, day);
        const dayFiles = await fs2.readdir(dayPath, { withFileTypes: true });
        files.push(
          ...dayFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path2.join(dayPath, entry.name))
        );
      }
    }
  }
  return files;
}
async function locateRollout(sessionId) {
  const files = await recentRolloutFiles();
  if (sessionId) {
    return files.find((filePath) => sessionIdFromFilename(filePath) === sessionId) ?? null;
  }
  const withStats = await Promise.all(
    files.map(async (filePath) => ({ filePath, stats: await fs2.stat(filePath) }))
  );
  return withStats.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0]?.filePath ?? null;
}
var RolloutContextProvider = class {
  constructor(registry = new SessionRegistry()) {
    this.registry = registry;
  }
  registry;
  caches = /* @__PURE__ */ new Map();
  reading = /* @__PURE__ */ new Map();
  /** Project actions do not expose the selected chat ID. Pick a recent project log explicitly. */
  async latestSessionForDirectory(directory) {
    const root = path2.resolve(directory);
    const files = await recentRolloutFiles();
    const recent = (await Promise.all(files.map(async (file) => ({ file, modified: await fs2.stat(file).then((s) => s.mtimeMs).catch(() => 0) })))).sort((a, b) => b.modified - a.modified).slice(0, 200);
    for (const { file } of recent) {
      try {
        const header = await this.readHeader(file);
        const record = header ? JSON.parse(header) : null;
        if (record?.type !== "session_meta" || typeof record.payload?.cwd !== "string") continue;
        const relative = path2.relative(root, path2.resolve(record.payload.cwd));
        if (relative === "" || !relative.startsWith(`..${path2.sep}`) && relative !== ".." && !path2.isAbsolute(relative)) return sessionIdFromFilename(file);
      } catch {
      }
    }
    return null;
  }
  async listSessions(limit = 20) {
    const registered = await this.registry.list(limit);
    const files = await recentRolloutFiles();
    const recent = (await Promise.all(files.map(async (file) => ({ file, stats: await fs2.stat(file) })))).sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs).slice(0, limit);
    const result = new Map(registered.map((s) => [s.sessionId, { sessionId: s.sessionId, model: s.model, lastSeenAt: s.lastSeenAt, active: s.endedAt === null, parentSessionId: null, agentName: null }]));
    for (const { file, stats } of recent) {
      const id = sessionIdFromFilename(file);
      const meta = await this.readHeader(file);
      const state = createParsedRolloutState(id, null);
      if (meta) parseRolloutLine(meta, "explicit", state);
      const previous = result.get(id);
      result.set(id, { sessionId: id, model: previous?.model ?? null, lastSeenAt: stats.mtime.toISOString(), active: previous?.active ?? false, parentSessionId: state.parentSessionId, agentName: state.agentName });
    }
    return [...result.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, limit);
  }
  async readItem(sessionId, itemId) {
    await this.getContext({ sessionId });
    const entry = [...this.caches.entries()].find(([, c]) => c.state.sessionId === sessionId && c.state.locations.has(itemId));
    if (!entry) throw new Error("\u8BE5\u8BB0\u5F55\u4E0D\u5728\u4FDD\u7559\u8303\u56F4\u5185\uFF1B\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002");
    const [file, cache] = entry;
    const location = cache.state.locations.get(itemId);
    const handle = await fs2.open(file, "r");
    let raw;
    try {
      raw = Buffer.alloc(location.length);
      await handle.read(raw, 0, raw.length, location.offset);
    } finally {
      await handle.close();
    }
    const payload = object(object(JSON.parse(raw.toString("utf8")))?.payload);
    if (!payload) throw new Error("\u8BB0\u5F55\u65E0\u6CD5\u89E3\u6790\u3002");
    const body = visibleText(payload);
    const expected = cache.state.activity.find((i) => i.id === itemId);
    if (!expected || digest(body) !== expected.hash) throw new Error("\u65E5\u5FD7\u5185\u5BB9\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u8BFB\u53D6\u3002");
    return { id: itemId, text: body.slice(0, 32768), truncated: body.length > 32768, scope: "Codex \u65E5\u5FD7\u516C\u5F00\u8BB0\u5F55\uFF1B\u4E0D\u662F\u5B8C\u6574\u6A21\u578B\u8BF7\u6C42\uFF1B\u4E0D\u89E3\u5BC6 reasoning" };
  }
  async readHeader(file) {
    const h = await fs2.open(file, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const { bytesRead } = await h.read(buffer, 0, buffer.length, 0);
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      return end < 0 ? null : buffer.subarray(0, end).toString("utf8");
    } finally {
      await h.close();
    }
  }
  async getContext(options = {}) {
    if (options.sessionId && !/^[a-zA-Z0-9_-]{1,128}$/u.test(options.sessionId)) throw new Error("Invalid session ID");
    const warnings = [];
    const located = await this.locateSession(options.sessionId);
    if (!located) {
      return {
        session: null,
        selection: "unavailable",
        snapshots: [],
        compactions: [],
        hookEvents: [],
        warnings: [
          "No active Codex session was registered and no recent rollout file was found."
        ]
      };
    }
    const transcriptPath = await existingFile(located.registration.transcriptPath);
    const fallbackPath = transcriptPath ? null : await locateRollout(located.registration.sessionId);
    const effectivePath = transcriptPath ?? fallbackPath;
    if (!effectivePath) {
      return {
        session: located.registration,
        selection: located.selection,
        snapshots: [],
        compactions: [],
        hookEvents: await this.registry.hookEvents(located.registration.sessionId),
        warnings: ["The registered Codex transcript is unavailable."]
      };
    }
    if (!transcriptPath) {
      warnings.push("The registered transcript path was unavailable; matched by session ID.");
    }
    const parsed = await this.readIncremental(
      effectivePath,
      located.selection,
      located.registration
    );
    const hookEvents = await this.registry.hookEvents(located.registration.sessionId);
    const hookCompactions = hookEvents.filter((event) => event.eventName === "PostCompact").map((event) => ({
      timestamp: event.timestamp,
      trigger: event.trigger === "manual" || event.trigger === "auto" ? event.trigger : "unknown",
      source: "hook"
    }));
    const compactions = [...parsed.compactions];
    for (const marker of hookCompactions) {
      const markerTime = Date.parse(marker.timestamp);
      const duplicate = compactions.some(
        (current) => Math.abs(Date.parse(current.timestamp) - markerTime) < 2e3
      );
      if (!duplicate) compactions.push(marker);
    }
    const modelSnapshots = selectSnapshotsForModel(
      parsed.snapshots,
      located.registration.model
    );
    if (parsed.snapshots.length > 0 && modelSnapshots.length === 0) {
      warnings.push(
        `Codex token snapshots were found, but none matched active model ${located.registration.model ?? "unknown"}; auxiliary-model values were not substituted.`
      );
    }
    return {
      session: located.registration,
      selection: located.selection,
      snapshots: modelSnapshots.map((snapshot) => ({
        ...snapshot,
        model: snapshot.model ?? located.registration.model
      })),
      compactions: compactions.slice(-MAX_COMPACTIONS),
      hookEvents,
      warnings,
      activity: summarizeActivity(parsed.activity, parsed.truncated, parsed.parentSessionId, parsed.agentName)
    };
  }
  async locateSession(sessionId) {
    if (sessionId) {
      const registered = await this.registry.get(sessionId);
      if (registered) return { registration: registered, selection: "explicit" };
      const filePath = [...this.caches.entries()].find(([, cache]) => cache.state.sessionId === sessionId)?.[0] ?? await locateRollout(sessionId);
      if (!filePath) return null;
      const stats2 = await fs2.stat(filePath);
      return {
        selection: "explicit",
        registration: {
          sessionId,
          transcriptPath: filePath,
          cwd: null,
          model: null,
          lastSeenAt: stats2.mtime.toISOString(),
          lastHookEvent: "ExplicitSessionLookup",
          endedAt: null
        }
      };
    }
    const active = (await this.registry.list()).find((session2) => session2.endedAt === null);
    if (active) return { registration: active, selection: "active-hook" };
    const latestPath = await locateRollout();
    if (!latestPath) return null;
    const stats = await fs2.stat(latestPath);
    return {
      selection: "latest-rollout",
      registration: {
        sessionId: sessionIdFromFilename(latestPath),
        transcriptPath: latestPath,
        cwd: null,
        model: null,
        lastSeenAt: stats.mtime.toISOString(),
        lastHookEvent: "LatestRolloutFallback",
        endedAt: null
      }
    };
  }
  async readIncremental(filePath, selection, registration) {
    const previous = this.reading.get(filePath);
    const job = (previous ?? Promise.resolve()).catch(() => void 0).then(() => this.readTail(filePath, selection, registration));
    this.reading.set(filePath, job);
    try {
      return await job;
    } finally {
      if (this.reading.get(filePath) === job) this.reading.delete(filePath);
    }
  }
  async readTail(filePath, selection, registration) {
    const stats = await fs2.stat(filePath);
    let cache = this.caches.get(filePath);
    if (!cache || stats.size < cache.offset || stats.size - cache.offset > INITIAL_TAIL_BYTES) {
      const offset = Math.max(stats.size - INITIAL_TAIL_BYTES, 0);
      cache = {
        offset,
        carry: Buffer.alloc(0),
        skipFirst: offset > 0,
        state: createParsedRolloutState(registration.sessionId, registration.model)
      };
      cache.state.truncated = offset > 0;
      if (offset > 0) {
        const header = await this.readHeader(filePath);
        if (header) parseRolloutLine(header, selection, cache.state);
      }
      this.caches.set(filePath, cache);
      while (this.caches.size > 12) this.caches.delete(this.caches.keys().next().value);
    }
    if (!cache) {
      throw new Error("Failed to initialize the rollout tail cache.");
    }
    if (stats.size === cache.offset) return cache.state;
    const length = stats.size - cache.offset;
    const handle = await fs2.open(filePath, "r");
    let bytes;
    let startOffset = cache.offset - cache.carry.length;
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cache.offset);
      bytes = Buffer.concat([cache.carry, buffer.subarray(0, bytesRead)]);
      cache.offset += bytesRead;
    } finally {
      await handle.close();
    }
    if (cache.skipFirst) {
      const firstNewline = bytes.indexOf(10);
      if (firstNewline < 0) {
        cache.carry = Buffer.alloc(0);
        return cache.state;
      }
      startOffset += firstNewline + 1;
      bytes = bytes.subarray(firstNewline + 1);
      cache.skipFirst = false;
    }
    let start = 0;
    for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
      const line = bytes.subarray(start, end).toString("utf8");
      if (line) parseRolloutLine(line, selection, cache.state, { offset: startOffset + start, length: end - start });
      start = end + 1;
    }
    cache.carry = Buffer.from(bytes.subarray(start));
    if (cache.carry.length > INITIAL_TAIL_BYTES) {
      cache.carry = Buffer.alloc(0);
      cache.skipFirst = true;
      cache.state.truncated = true;
    }
    cache.state.snapshots = cache.state.snapshots.slice(-MAX_SNAPSHOTS);
    cache.state.compactions = cache.state.compactions.slice(-MAX_COMPACTIONS);
    if (cache.state.activity.length > 500) {
      cache.state.activity = cache.state.activity.slice(-500);
      cache.state.truncated = true;
    }
    const ids = new Set(cache.state.activity.map((i) => i.id));
    for (const id of cache.state.locations.keys()) if (!ids.has(id)) cache.state.locations.delete(id);
    return cache.state;
  }
};

// src/dashboard-server.ts
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
async function startDashboard(monitor, provider2) {
  const capability = randomBytes(24).toString("hex");
  const prefix = `/${capability}/`;
  const script = await readFile(new URL("./ui/context-details-panel.js", import.meta.url), "utf8");
  const server2 = createServer(async (req, res) => {
    const address2 = server2.address();
    if (!address2 || typeof address2 === "string") {
      res.writeHead(503).end();
      return;
    }
    const host = `127.0.0.1:${address2.port}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== host || req.headers.origin && req.headers.origin !== `http://${host}` || req.headers["sec-fetch-site"] === "cross-site") {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const relative = url.pathname.slice(prefix.length);
    if (req.method === "GET" && relative === "health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ application: "context-window-monitor", version: "0.3.0", pid: process.pid }));
      return;
    }
    if (req.method === "GET" && relative === "") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex \u4E0A\u4E0B\u6587\u76D1\u63A7</title><link rel="icon" href="data:,"></head><body><div id="root" data-local-dashboard="true"></div><script type="module" src="app.js"></script></body></html>');
      return;
    }
    if (req.method === "GET" && relative === "app.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" }).end(script);
      return;
    }
    if (req.method !== "POST" || relative !== "api") {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) {
          res.writeHead(413).end();
          return;
        }
      }
      const data = JSON.parse(body);
      const args = data.arguments ?? {};
      let value;
      if (data.name === "get_context_usage") value = await monitor.dashboard(typeof args.sessionId === "string" ? args.sessionId : void 0);
      else if (data.name === "list_context_sessions") value = { sessions: await provider2.listSessions(20) };
      else if (data.name === "read_context_item" && args.confirmReveal === true && typeof args.sessionId === "string" && typeof args.itemId === "string") value = await provider2.readItem(args.sessionId, args.itemId);
      else throw new Error("Unsupported operation");
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ structuredContent: value }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise((resolve, reject) => {
    server2.once("error", reject);
    server2.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server2.address();
  if (!address || typeof address === "string") throw new Error("No local dashboard address");
  return { url: `http://127.0.0.1:${address.port}${prefix}`, close: () => new Promise((resolve, reject) => {
    server2.close((e) => e ? reject(e) : resolve());
    server2.closeAllConnections();
  }) };
}

// src/dashboard.ts
var provider = new RolloutContextProvider();
var server = await startDashboard(new ContextMonitorService(provider), provider);
var session = process.argv[2];
console.log(`${server.url}${session ? `?session=${encodeURIComponent(session)}` : ""}`);
for (const event of ["SIGINT", "SIGTERM"]) process.on(event, () => {
  void server.close().then(() => process.exit(0));
});
