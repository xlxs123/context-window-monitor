import type { ContextProvider } from "./context-provider.js";
import { ContextHistoryTracker } from "./context-history-tracker.js";
import { ContextStatusBar } from "./context-status-bar.js";
import type { ContextDashboard } from "./context-types.js";
import { UNAVAILABLE_BREAKDOWN } from "./context-types.js";
import { ContextUsageService } from "./context-usage-service.js";

export class ContextMonitorService {
  constructor(
    private readonly provider: ContextProvider,
    private readonly usageService = new ContextUsageService(),
    private readonly historyTracker = new ContextHistoryTracker(),
    private readonly statusBar = new ContextStatusBar(),
  ) {}

  async dashboard(sessionId?: string): Promise<ContextDashboard> {
    const providerResult = await this.provider.getContext(
      sessionId ? { sessionId } : undefined,
    );
    const usage = this.usageService.calculate(providerResult);
    const exactBreakdown = this.usageService.breakdown(providerResult);
    const warnings = [...providerResult.warnings];

    if (usage.totalTokens === null) {
      warnings.push("Codex did not report the model context-window capacity.");
    }
    warnings.push(
      "System/history/files/tool-result token categories are not exposed and are shown as unavailable.",
    );

    return {
      schemaVersion: 1,
      usage,
      statusText: this.statusBar.format(usage),
      exactBreakdown,
      unavailableBreakdown: UNAVAILABLE_BREAKDOWN.map((category) => ({ ...category })),
      recentChanges: this.historyTracker.changes(
        providerResult.snapshots,
        providerResult.compactions,
        providerResult.hookEvents,
      ),
      compactions: this.historyTracker.compactions(
        providerResult.snapshots,
        providerResult.compactions,
        20,
      ),
      cumulativeTokens: exactBreakdown.cumulativeThreadTokens,
      warnings,
      refreshIntervalMs: 5_000,
      snapshots:providerResult.snapshots,
      ...(providerResult.activity?{activity:providerResult.activity}:{}),
    };
  }
}
