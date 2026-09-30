import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";

import { SessionRegistry } from "../runtime/core/index.mjs";

const usage = {
  input_tokens: 78_420,
  cached_input_tokens: 61_200,
  cache_write_input_tokens: 0,
  output_tokens: 3_810,
  reasoning_output_tokens: 1_440,
  total_tokens: 82_230,
};

test("MCP server exposes tools, exact data, and the UI resource", async (context) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "context-monitor-mcp-"));
  const rolloutPath = path.join(dataDirectory, "fixture-session.jsonl");
  await writeFile(
    rolloutPath,
    [
      {
        timestamp: "2026-09-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "fixture-session" },
      },
      {
        timestamp: "2026-09-01T00:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-test", turn_id: "turn-1" },
      },
      {
        timestamp: "2026-09-01T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: usage,
            last_token_usage: usage,
            model_context_window: 200_000,
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
    "utf8",
  );
  await new SessionRegistry(dataDirectory).record({
    sessionId: "fixture-session",
    transcriptPath: rolloutPath,
    cwd: dataDirectory,
    model: "gpt-test",
    eventName: "UserPromptSubmit",
    turnId: "turn-1",
    toolName: null,
    trigger: null,
    timestamp: "2026-09-01T00:00:01.500Z",
  });

  const child = spawn(process.execPath, ["runtime/mcp-server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, CONTEXT_MONITOR_DATA: dataDirectory, CONTEXT_MONITOR_DISABLE_AUTO_PROJECTS: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(async () => {
    child.kill();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  const pending = new Map();
  const stderr = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}\n${stderr.join("\n")}`));
      }, 5_000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };

  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "context-window-monitor-test", version: "1.0.0" },
  });
  assert.equal(initialized.result.serverInfo.name, "context-window-monitor");
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );

  const tools = await request("tools/list", {});
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name).sort(),
    ["get_context_usage", "list_context_sessions", "read_context_item", "show_context_monitor"],
  );

  const result = await request("tools/call", {
    name: "get_context_usage",
    arguments: { sessionId: "fixture-session" },
  });
  assert.equal(result.result.structuredContent.usage.precision, "exact");
  assert.equal(result.result.structuredContent.usage.usedTokens, 78_420);
  assert.equal(result.result.structuredContent.usage.remainingTokens, 121_580);

  const resource = await request("resources/read", { uri: "ui://context-window-monitor/v1.html" });
  assert.equal(resource.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.result.contents[0].text, /CODEX CONTEXT MONITOR/u);
  const shown=await request("tools/call",{name:"show_context_monitor",arguments:{sessionId:"fixture-session"}});
  const url=shown.result._meta.dashboardUrl;
  assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\//u);
  assert.equal((await fetch(url)).status,200);
  const api=new URL("api",url);
  const denied=await fetch(api,{method:"POST",headers:{Origin:"https://untrusted.example"},body:JSON.stringify({name:"get_context_usage"})});assert.equal(denied.status,403);
  const badPath=new URL("/api",url);assert.equal((await fetch(badPath)).status,404);
  const noReveal=await fetch(api,{method:"POST",body:JSON.stringify({name:"read_context_item",arguments:{sessionId:"fixture-session",itemId:"0"}})});assert.equal(noReveal.status,400);
});
