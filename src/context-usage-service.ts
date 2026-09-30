import type {
  ContextHealth,
  ContextUsage,
  ExactBreakdown,
  ProviderResult,
  RawContextSnapshot,
} from "./context-types.js";

const USED_DEFINITION =
  "Last server-reported model input tokens. No text-to-token estimation is used.";

function healthFor(percentage: number | null): ContextHealth {
  if (percentage === null) return "unavailable";
  if (percentage >= 90) return "danger";
  if (percentage >= 75) return "high";
  if (percentage >= 50) return "medium";
  return "normal";
}

function latestSnapshot(result: ProviderResult): RawContextSnapshot | null {
  return result.snapshots.at(-1) ?? null;
}

export class ContextUsageService {
  calculate(result: ProviderResult): ContextUsage {
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
        usedDefinition: USED_DEFINITION,
      };
    }

    const usedTokens = snapshot.last.inputTokens;
    const totalTokens = snapshot.modelContextWindow;
    const remainingTokens =
      totalTokens === null ? null : Math.max(totalTokens - usedTokens, 0);
    const percentage =
      totalTokens === null || totalTokens <= 0
        ? null
        : (usedTokens / totalTokens) * 100;
    const exactSession =
      snapshot.selection === "active-hook" || snapshot.selection === "explicit";

    return {
      precision: exactSession ? "exact" : "estimated",
      precisionDetail: exactSession
        ? "Exact Codex values matched to the active session by a lifecycle hook or explicit session ID."
        : "Token values are exact, but the current session was selected by latest-rollout fallback.",
      usedTokens,
      totalTokens,
      remainingTokens,
      percentage,
      health: healthFor(percentage),
      model: snapshot.model ?? result.session?.model ?? null,
      sessionId: snapshot.sessionId,
      updatedAt: snapshot.timestamp,
      source: snapshot.source,
      usedDefinition: USED_DEFINITION,
    };
  }

  breakdown(result: ProviderResult): ExactBreakdown {
    const snapshot = latestSnapshot(result);
    if (!snapshot) {
      return {
        currentModelInputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        uncachedInputTokens: null,
        lastOutputTokens: null,
        reasoningOutputTokens: null,
        cumulativeThreadTokens: null,
      };
    }

    return {
      currentModelInputTokens: snapshot.last.inputTokens,
      cachedInputTokens: snapshot.last.cachedInputTokens,
      cacheWriteInputTokens: snapshot.last.cacheWriteInputTokens,
      uncachedInputTokens: Math.max(
        snapshot.last.inputTokens -
          snapshot.last.cachedInputTokens -
          snapshot.last.cacheWriteInputTokens,
        0,
      ),
      lastOutputTokens: snapshot.last.outputTokens,
      reasoningOutputTokens: snapshot.last.reasoningOutputTokens,
      cumulativeThreadTokens: snapshot.cumulative.totalTokens,
    };
  }
}
