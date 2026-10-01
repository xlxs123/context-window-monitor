export type Precision = "exact" | "estimated" | "unavailable";

export type ContextHealth =
  | "normal"
  | "medium"
  | "high"
  | "danger"
  | "unavailable";

export type SessionSelection =
  | "explicit"
  | "active-hook"
  | "latest-rollout"
  | "unavailable";

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RawContextSnapshot {
  sessionId: string;
  timestamp: string;
  source: "app-server-event" | "rollout-log";
  selection: SessionSelection;
  last: TokenUsageBreakdown;
  cumulative: TokenUsageBreakdown;
  modelContextWindow: number | null;
  model: string | null;
  turnId: string | null;
}

export interface CompactionMarker {
  timestamp: string;
  trigger: "manual" | "auto" | "unknown";
  source: "app-server-event" | "rollout-log" | "hook";
}

export interface HookEvent {
  timestamp: string;
  sessionId: string;
  eventName: string;
  turnId: string | null;
  toolName: string | null;
  trigger: string | null;
}

export interface SessionRegistration {
  sessionId: string;
  transcriptPath: string | null;
  cwd: string | null;
  model: string | null;
  lastSeenAt: string;
  lastHookEvent: string;
  endedAt: string | null;
}

export interface ProviderResult {
  session: SessionRegistration | null;
  selection: SessionSelection;
  snapshots: RawContextSnapshot[];
  compactions: CompactionMarker[];
  hookEvents: HookEvent[];
  warnings: string[];
  activity?: ActivityReport;
}

export type ActivityCategory = "system" | "developer" | "user" | "assistant" | "reasoning" | "tool_call" | "tool_result" | "compaction" | "other";
export type FileOperationKind = "read" | "write" | "search" | "image" | "other";
export interface ActivityFileOperation {
  path: string;
  kind: FileOperationKind;
  addedLines: number | null;
  removedLines: number | null;
}
export interface ActivityItem {
  id: string;
  timestamp: string;
  category: ActivityCategory;
  type: string;
  role: string | null;
  name: string;
  callId: string | null;
  messageId: string | null;
  characters: number;
  hash: string;
  file: string | null;
  fileOperations?: ActivityFileOperation[];
  tokens: null;
}
export interface ActivityReport {
  items: ActivityItem[];
  truncated: boolean;
  scope: string;
  parentSessionId: string | null;
  agentName: string | null;
  tools: Array<{name:string;calls:number;results:number;argumentCharacters:number;resultCharacters:number;tokens:null}>;
  files: Array<{path:string;calls:number;characters:number;readCalls?:number;writeCalls?:number;searchCalls?:number;imageCalls?:number;addedLines?:number|null;removedLines?:number|null;lastAt?:string|null;itemIds?:string[]}>;
  duplicates: Array<{hash:string;ids:string[];characters:number}>;
}

export interface ContextUsage {
  precision: Precision;
  precisionDetail: string;
  usedTokens: number | null;
  totalTokens: number | null;
  remainingTokens: number | null;
  percentage: number | null;
  health: ContextHealth;
  model: string | null;
  sessionId: string | null;
  updatedAt: string | null;
  source: RawContextSnapshot["source"] | null;
  usedDefinition: string;
}

export type ChangeKind =
  | "increase"
  | "decrease"
  | "compaction"
  | "snapshot";

export interface ContextChange {
  id: string;
  timestamp: string;
  kind: ChangeKind;
  deltaTokens: number | null;
  beforeTokens: number | null;
  afterTokens: number;
  label: string;
  detail: string;
  attribution: "exact-event" | "observed-correlation" | "snapshot-only";
}

export interface CompactionRecord {
  timestamp: string;
  trigger: "manual" | "auto" | "unknown";
  beforeTokens: number | null;
  afterTokens: number | null;
  reducedTokens: number | null;
  precision: Precision;
  detail: string;
}

export interface ExactBreakdown {
  currentModelInputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  uncachedInputTokens: number | null;
  lastOutputTokens: number | null;
  reasoningOutputTokens: number | null;
  cumulativeThreadTokens: number | null;
}

export interface UnavailableBreakdownCategory {
  name:
    | "System Instructions"
    | "Conversation History"
    | "Files / Attachments"
    | "Tool Results"
    | "Other Context";
  value: null;
  precision: "unavailable";
}

export interface ContextDashboard extends Record<string, unknown> {
  schemaVersion: 1;
  usage: ContextUsage;
  statusText: string;
  exactBreakdown: ExactBreakdown;
  unavailableBreakdown: UnavailableBreakdownCategory[];
  recentChanges: ContextChange[];
  compactions: CompactionRecord[];
  cumulativeTokens: number | null;
  warnings: string[];
  refreshIntervalMs: number;
  snapshots?: RawContextSnapshot[];
  activity?: ActivityReport;
}

export const UNAVAILABLE_BREAKDOWN: UnavailableBreakdownCategory[] = [
  "System Instructions",
  "Conversation History",
  "Files / Attachments",
  "Tool Results",
  "Other Context",
].map((name) => ({
  name: name as UnavailableBreakdownCategory["name"],
  value: null,
  precision: "unavailable" as const,
}));
