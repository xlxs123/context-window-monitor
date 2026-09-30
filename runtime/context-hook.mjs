// src/providers/session-registry.ts
import { createHash } from "node:crypto";
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
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
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
    let text;
    try {
      text = await fs.readFile(this.eventsPath(sessionId), "utf8");
    } catch {
      return [];
    }
    return text.split(/\r?\n/u).filter(Boolean).slice(-limit).flatMap((line) => {
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

// src/context-hook.ts
var MAX_STDIN_BYTES = 1024 * 1024;
function objectValue(value) {
  return typeof value === "object" && value !== null ? value : null;
}
function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) return null;
    chunks.push(buffer);
  }
  if (size === 0) return null;
  try {
    return objectValue(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    return null;
  }
}
function sanitizedRecord(input) {
  const sessionId = optionalString(input.session_id);
  const eventName = optionalString(input.hook_event_name);
  if (!sessionId || !eventName) return null;
  const tool = objectValue(input.tool);
  return {
    sessionId,
    transcriptPath: optionalString(input.transcript_path),
    cwd: optionalString(input.cwd),
    model: optionalString(input.model),
    eventName,
    turnId: optionalString(input.turn_id),
    toolName: optionalString(input.tool_name) ?? optionalString(tool?.name),
    trigger: optionalString(input.trigger) ?? optionalString(input.source) ?? optionalString(input.reason),
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function main() {
  try {
    const input = await readInput();
    const record = input ? sanitizedRecord(input) : null;
    if (record) await new SessionRegistry().record(record);
  } catch (error) {
    if (process.env.CONTEXT_MONITOR_DEBUG === "1") {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Context Window Monitor hook: ${message}
`);
    }
  }
  process.stdout.write('{"continue":true}\n');
}
await main();
