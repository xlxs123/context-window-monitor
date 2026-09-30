---
name: context-usage
description: Open the black Codex context dashboard or read exact context usage, remaining capacity, trends, recorded tool activity, and compaction events. Use for context monitoring, context window, tokens remaining, tool context, or compaction questions.
---

# Context Usage

Use `show_context_monitor` for the black dashboard. Pass the current Codex thread ID
when it is available; do not guess it from the latest unrelated task. The tool returns
a localhost dashboard URL in `_meta.dashboardUrl` and its text result. Open that exact
URL in the Codex browser panel with `open_in_codex` when available; otherwise provide
a clickable link. This local UI works even when the host does not render MCP Apps.
Never invent a persistent native status-bar or conversation-tab extension.

Use `get_context_usage` without `details` for a concise answer. For interactive
analysis, `details: true` includes the retained log metadata and real usage snapshots.
`list_context_sessions` discovers recent local sessions as well as hooked sessions.

Never reinterpret `cumulativeTokens` as the active context-window occupancy.
The active snapshot is `usedTokens`, sourced from the last server-reported model
input. If `precision` is not `exact`, repeat the precision label and the reason.

Do not infer System Instructions, Conversation History, Files, Tool Results, or
Other breakdowns. Report those categories as unavailable unless the tool itself
returns exact category values.

When the tool reports a compaction, distinguish the exact compaction event from
optional before/after values. Only state a reduction amount when `reducedTokens`
is present.

Recorded activity is not the model's complete current request. Character counts
are text sizes, not token estimates. Compaction deltas compare surrounding model
requests and can also include intervening additions. Do not assert a full content
diff or exact per-tool / per-agent tokens when those fields are unavailable.

Original text is hidden by default. Call `read_context_item` with `confirmReveal: true`
only when the user explicitly asks to reveal a selected record. Never read encrypted
reasoning, automatically export originals, or send local data to external services.
