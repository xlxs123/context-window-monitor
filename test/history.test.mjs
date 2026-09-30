import assert from "node:assert/strict";
import test from "node:test";

import { ContextHistoryTracker } from "../runtime/core/index.mjs";

function snapshot(timestamp, inputTokens) {
  const usage = {
    totalTokens: inputTokens,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
  return {
    sessionId: "session-1",
    timestamp,
    source: "rollout-log",
    selection: "active-hook",
    last: usage,
    cumulative: usage,
    modelContextWindow: 200_000,
    model: "gpt-test",
    turnId: "turn-1",
  };
}

test("attributes reductions to compaction only when an exact event exists", () => {
  const before = snapshot("2026-09-01T00:00:00.000Z", 176_420);
  const after = snapshot("2026-09-01T00:00:10.000Z", 92_180);
  const markers = [
    {
      timestamp: "2026-09-01T00:00:05.000Z",
      trigger: "auto",
      source: "rollout-log",
    },
  ];
  const tracker = new ContextHistoryTracker();
  const changes = tracker.changes([before, after], markers, []);
  assert.equal(changes[0].kind, "compaction");
  assert.equal(changes[0].deltaTokens, -84_240);

  const compacted = tracker.compactions([before, after], markers);
  assert.equal(compacted[0].reducedTokens, 84_240);
  assert.equal(compacted[0].precision, "exact");
});

test("does not guess a compaction when context drops without an event", () => {
  const tracker = new ContextHistoryTracker();
  const changes = tracker.changes(
    [
      snapshot("2026-09-01T00:00:00.000Z", 100_000),
      snapshot("2026-09-01T00:00:10.000Z", 70_000),
    ],
    [],
    [],
  );
  assert.equal(changes[0].kind, "decrease");
  assert.equal(changes[0].attribution, "observed-correlation");
});
