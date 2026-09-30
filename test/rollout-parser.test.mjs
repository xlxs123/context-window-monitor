import assert from "node:assert/strict";
import test from "node:test";

import {
  createParsedRolloutState,
  parseRolloutLine,
  selectSnapshotsForModel,
} from "../runtime/core/index.mjs";

test("parses exact Codex rollout token_count values", () => {
  const state = createParsedRolloutState("session-1", "gpt-test");
  parseRolloutLine(
    JSON.stringify({
      timestamp: "2026-09-01T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 120000,
            cached_input_tokens: 90000,
            cache_write_input_tokens: 0,
            output_tokens: 4000,
            reasoning_output_tokens: 1500,
            total_tokens: 124000,
          },
          last_token_usage: {
            input_tokens: 78420,
            cached_input_tokens: 61200,
            cache_write_input_tokens: 0,
            output_tokens: 3810,
            reasoning_output_tokens: 1440,
            total_tokens: 82230,
          },
          model_context_window: 200000,
        },
      },
    }),
    "active-hook",
    state,
  );

  assert.equal(state.snapshots.length, 1);
  assert.equal(state.snapshots[0].last.inputTokens, 78420);
  assert.equal(state.snapshots[0].modelContextWindow, 200000);
  assert.equal(state.snapshots[0].cumulative.totalTokens, 124000);
});

test("parses App Server thread/tokenUsage/updated values", () => {
  const state = createParsedRolloutState("thread-1", null);
  parseRolloutLine(
    JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: {
            totalTokens: 1000,
            inputTokens: 900,
            cachedInputTokens: 200,
            cacheWriteInputTokens: 0,
            outputTokens: 100,
            reasoningOutputTokens: 20,
          },
          last: {
            totalTokens: 600,
            inputTokens: 500,
            cachedInputTokens: 100,
            cacheWriteInputTokens: 0,
            outputTokens: 100,
            reasoningOutputTokens: 20,
          },
          modelContextWindow: 4096,
        },
      },
    }),
    "explicit",
    state,
  );

  assert.equal(state.snapshots[0].source, "app-server-event");
  assert.equal(state.snapshots[0].last.inputTokens, 500);
  assert.equal(state.snapshots[0].modelContextWindow, 4096);
});

test("does not substitute an auxiliary-model snapshot for the active model", () => {
  const base = {
    sessionId: "thread-1",
    timestamp: "2026-09-01T00:00:00.000Z",
    source: "rollout-log",
    selection: "active-hook",
    last: {
      totalTokens: 500,
      inputTokens: 500,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    cumulative: {
      totalTokens: 500,
      inputTokens: 500,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    modelContextWindow: 4096,
    turnId: "turn-1",
  };
  const selected = selectSnapshotsForModel(
    [{ ...base, model: "codex-auto-review" }],
    "gpt-5.6-sol",
  );
  assert.deepEqual(selected, []);
});
