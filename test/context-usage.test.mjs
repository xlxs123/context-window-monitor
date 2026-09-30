import assert from "node:assert/strict";
import test from "node:test";

import { ContextUsageService } from "../runtime/core/index.mjs";

const breakdown = {
  totalTokens: 82_230,
  inputTokens: 78_420,
  cachedInputTokens: 61_200,
  cacheWriteInputTokens: 0,
  outputTokens: 3_810,
  reasoningOutputTokens: 1_440,
};

function providerResult(selection, total = 200_000) {
  return {
    session: null,
    selection,
    snapshots: [
      {
        sessionId: "session-1",
        timestamp: "2026-09-01T00:00:00.000Z",
        source: "rollout-log",
        selection,
        last: breakdown,
        cumulative: breakdown,
        modelContextWindow: total,
        model: "gpt-test",
        turnId: "turn-1",
      },
    ],
    compactions: [],
    hookEvents: [],
    warnings: [],
  };
}

test("calculates occupancy from last input tokens, not cumulative total", () => {
  const result = providerResult("active-hook");
  result.snapshots[0].cumulative = { ...breakdown, totalTokens: 900_000 };
  const usage = new ContextUsageService().calculate(result);
  assert.equal(usage.usedTokens, 78_420);
  assert.equal(usage.remainingTokens, 121_580);
  assert.equal(usage.percentage, 39.21);
  assert.equal(usage.precision, "exact");
  assert.equal(usage.health, "normal");
});

test("marks latest-rollout session selection as estimated", () => {
  const usage = new ContextUsageService().calculate(providerResult("latest-rollout"));
  assert.equal(usage.precision, "estimated");
  assert.match(usage.precisionDetail, /Token values are exact/u);
});

test("uses requested health thresholds", () => {
  const service = new ContextUsageService();
  assert.equal(service.calculate(providerResult("active-hook", 150_000)).health, "medium");
  assert.equal(service.calculate(providerResult("active-hook", 100_000)).health, "high");
  assert.equal(service.calculate(providerResult("active-hook", 85_000)).health, "danger");
});
