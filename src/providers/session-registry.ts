import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { HookEvent, SessionRegistration } from "../context-types.js";

const EVENT_ROTATE_BYTES = 256 * 1024;
const EVENT_KEEP_BYTES = 128 * 1024;

export interface HookInputRecord {
  sessionId: string;
  transcriptPath: string | null;
  cwd: string | null;
  model: string | null;
  eventName: string;
  turnId: string | null;
  toolName: string | null;
  trigger: string | null;
  timestamp: string;
}

function usableEnvironmentPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("${")) return null;
  return path.resolve(trimmed);
}

export function resolveDataDirectory(): string {
  return (
    usableEnvironmentPath(process.env.CONTEXT_MONITOR_DATA) ??
    usableEnvironmentPath(process.env.PLUGIN_DATA) ??
    path.join(homedir(), ".codex", "context-window-monitor")
  );
}

function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export class SessionRegistry {
  readonly dataDirectory: string;
  private readonly sessionsDirectory: string;
  private readonly eventsDirectory: string;

  constructor(dataDirectory = resolveDataDirectory()) {
    this.dataDirectory = dataDirectory;
    this.sessionsDirectory = path.join(dataDirectory, "sessions");
    this.eventsDirectory = path.join(dataDirectory, "events");
  }

  private registrationPath(sessionId: string): string {
    return path.join(this.sessionsDirectory, `${sessionKey(sessionId)}.json`);
  }

  private eventsPath(sessionId: string): string {
    return path.join(this.eventsDirectory, `${sessionKey(sessionId)}.jsonl`);
  }

  async record(input: HookInputRecord): Promise<void> {
    await fs.mkdir(this.sessionsDirectory, { recursive: true });
    await fs.mkdir(this.eventsDirectory, { recursive: true });

    const previous = await this.get(input.sessionId);
    const registration: SessionRegistration = {
      sessionId: input.sessionId,
      transcriptPath: input.transcriptPath ?? previous?.transcriptPath ?? null,
      cwd: input.cwd ?? previous?.cwd ?? null,
      model: input.model ?? previous?.model ?? null,
      lastSeenAt: input.timestamp,
      lastHookEvent: input.eventName,
      endedAt:
        input.eventName === "SessionEnd" ? input.timestamp : (previous?.endedAt ?? null),
    };

    await fs.writeFile(
      this.registrationPath(input.sessionId),
      `${JSON.stringify(registration, null, 2)}\n`,
      "utf8",
    );

    await this.rotateEventsIfNeeded(input.sessionId);
    const event: HookEvent = {
      timestamp: input.timestamp,
      sessionId: input.sessionId,
      eventName: input.eventName,
      turnId: input.turnId,
      toolName: input.toolName,
      trigger: input.trigger,
    };
    await fs.appendFile(this.eventsPath(input.sessionId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async get(sessionId: string): Promise<SessionRegistration | null> {
    return readJson<SessionRegistration>(this.registrationPath(sessionId));
  }

  async list(limit = 50): Promise<SessionRegistration[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.sessionsDirectory);
    } catch {
      return [];
    }

    const registrations = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => readJson<SessionRegistration>(path.join(this.sessionsDirectory, name))),
    );

    return registrations
      .filter((value): value is SessionRegistration => value !== null)
      .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
      .slice(0, limit);
  }

  async hookEvents(sessionId: string, limit = 200): Promise<HookEvent[]> {
    let text: string;
    try {
      text = await fs.readFile(this.eventsPath(sessionId), "utf8");
    } catch {
      return [];
    }

    return text
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HookEvent];
        } catch {
          return [];
        }
      });
  }

  private async rotateEventsIfNeeded(sessionId: string): Promise<void> {
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
}
