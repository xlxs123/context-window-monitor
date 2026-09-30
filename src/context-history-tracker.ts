import type {
  CompactionMarker,
  CompactionRecord,
  ContextChange,
  HookEvent,
  RawContextSnapshot,
} from "./context-types.js";

const CORRELATION_WINDOW_MS = 45_000;

function toMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function markerBetween(
  markers: CompactionMarker[],
  before: string,
  after: string,
): CompactionMarker | null {
  const start = toMillis(before);
  const end = toMillis(after);
  return (
    markers.find((marker) => {
      const value = toMillis(marker.timestamp);
      return value > start && value <= end;
    }) ?? null
  );
}

function nearestHook(hooks: HookEvent[], timestamp: string): HookEvent | null {
  const target = toMillis(timestamp);
  let best: HookEvent | null = null;
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

function observedLabel(hook: HookEvent | null): { label: string; detail: string } {
  if (!hook) {
    return {
      label: "Context snapshot updated",
      detail: "No exact per-category attribution is exposed by Codex.",
    };
  }

  switch (hook.eventName) {
    case "UserPromptSubmit":
      return {
        label: "Observed after user message",
        detail: "The delta is exact; attribution is a time correlation, not a token category split.",
      };
    case "PostToolUse":
      return {
        label: hook.toolName
          ? `Observed after tool call: ${hook.toolName}`
          : "Observed after tool call",
        detail: "The delta is exact; attribution is a time correlation, not a token category split.",
      };
    case "Stop":
      return {
        label: "Observed near assistant completion",
        detail: "The delta is exact; attribution is a time correlation, not a token category split.",
      };
    default:
      return {
        label: `Observed after ${hook.eventName}`,
        detail: "The delta is exact; attribution is a time correlation, not a token category split.",
      };
  }
}

export class ContextHistoryTracker {
  changes(
    snapshots: RawContextSnapshot[],
    markers: CompactionMarker[],
    hooks: HookEvent[],
    limit = 12,
  ): ContextChange[] {
    const changes: ContextChange[] = [];
    const ordered = [...snapshots].sort(
      (left, right) => toMillis(left.timestamp) - toMillis(right.timestamp),
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
          attribution: "snapshot-only",
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
          attribution: "exact-event",
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
        attribution: "observed-correlation",
      });
    }

    return changes.slice(-limit).reverse();
  }

  compactions(
    snapshots: RawContextSnapshot[],
    markers: CompactionMarker[],
    limit = 6,
  ): CompactionRecord[] {
    const ordered = [...snapshots].sort(
      (left, right) => toMillis(left.timestamp) - toMillis(right.timestamp),
    );

    return [...markers]
      .sort((left, right) => toMillis(right.timestamp) - toMillis(left.timestamp))
      .slice(0, limit)
      .map((marker) => {
        const markerTime = toMillis(marker.timestamp);
        const before = [...ordered]
          .reverse()
          .find((snapshot) => toMillis(snapshot.timestamp) < markerTime);
        const after = ordered.find((snapshot) => toMillis(snapshot.timestamp) > markerTime);
        const beforeTokens = before?.last.inputTokens ?? null;
        const afterTokens = after?.last.inputTokens ?? null;
        const reducedTokens =
          beforeTokens !== null && afterTokens !== null && beforeTokens >= afterTokens
            ? beforeTokens - afterTokens
            : null;

        return {
          timestamp: marker.timestamp,
          trigger: marker.trigger,
          beforeTokens,
          afterTokens,
          reducedTokens,
          precision: reducedTokens === null ? "unavailable" : "exact",
          detail:
            reducedTokens === null
              ? "Compaction is exact; before/after snapshots were not both available."
              : "Compaction and both surrounding token snapshots were reported by Codex.",
        };
      });
  }
}
