import type { ContextHealth, ContextUsage } from "./context-types.js";

const HEALTH_LABELS: Record<ContextHealth, string> = {
  normal: "Normal",
  medium: "Medium",
  high: "High",
  danger: "Danger",
  unavailable: "Unavailable",
};

function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  const divisor = value >= 1_000_000 ? 1_000_000 : 1_000;
  const suffix = value >= 1_000_000 ? "M" : "K";
  return `${(value / divisor).toFixed(value >= divisor * 100 ? 0 : 1)}${suffix}`;
}

export class ContextStatusBar {
  format(usage: ContextUsage): string {
    if (
      usage.usedTokens === null ||
      usage.totalTokens === null ||
      usage.percentage === null
    ) {
      return "Context: unavailable";
    }

    return `Context: ${compactNumber(usage.usedTokens)} / ${compactNumber(
      usage.totalTokens,
    )} · ${usage.percentage.toFixed(1)}% · ${HEALTH_LABELS[usage.health]}`;
  }
}
