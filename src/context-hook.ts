import { SessionRegistry, type HookInputRecord } from "./providers/session-registry.js";

const MAX_STDIN_BYTES = 1024 * 1024;

interface ObjectValue {
  [key: string]: unknown;
}

function objectValue(value: unknown): ObjectValue | null {
  return typeof value === "object" && value !== null ? (value as ObjectValue) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function readInput(): Promise<ObjectValue | null> {
  const chunks: Buffer[] = [];
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

function sanitizedRecord(input: ObjectValue): HookInputRecord | null {
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
    trigger:
      optionalString(input.trigger) ??
      optionalString(input.source) ??
      optionalString(input.reason),
    timestamp: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  try {
    const input = await readInput();
    const record = input ? sanitizedRecord(input) : null;
    if (record) await new SessionRegistry().record(record);
  } catch (error) {
    if (process.env.CONTEXT_MONITOR_DEBUG === "1") {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Context Window Monitor hook: ${message}\n`);
    }
  }

  // Every configured hook accepts this non-blocking result shape. No context is injected.
  process.stdout.write('{"continue":true}\n');
}

await main();
