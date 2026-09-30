import type { ContextProvider, ContextProviderOptions } from "../context-provider.js";
import type { ProviderResult, SessionRegistration } from "../context-types.js";
import {
  createParsedRolloutState,
  parseRolloutLine,
} from "./rollout-event-parser.js";

/**
 * Adapter for custom Codex clients that already own an App Server connection.
 * The bundled plugin cannot subscribe to the host application's connection, so
 * production plugin reads use RolloutContextProvider instead.
 */
export class AppServerContextProvider implements ContextProvider {
  private readonly state;
  private readonly registration: SessionRegistration;

  constructor(sessionId: string, model: string | null = null) {
    this.state = createParsedRolloutState(sessionId, model);
    this.registration = {
      sessionId,
      transcriptPath: null,
      cwd: null,
      model,
      lastSeenAt: new Date().toISOString(),
      lastHookEvent: "AppServerInitialize",
      endedAt: null,
    };
  }

  ingest(message: unknown): void {
    const envelope =
      typeof message === "object" && message !== null
        ? { timestamp: new Date().toISOString(), ...message }
        : message;
    parseRolloutLine(JSON.stringify(envelope), "explicit", this.state);
    this.registration.lastSeenAt = new Date().toISOString();
  }

  async getContext(options: ContextProviderOptions = {}): Promise<ProviderResult> {
    if (options.sessionId && options.sessionId !== this.registration.sessionId) {
      return {
        session: null,
        selection: "unavailable",
        snapshots: [],
        compactions: [],
        hookEvents: [],
        warnings: ["The requested session is not attached to this App Server adapter."],
      };
    }

    return {
      session: { ...this.registration },
      selection: "explicit",
      snapshots: [...this.state.snapshots],
      compactions: [...this.state.compactions],
      hookEvents: [],
      warnings: [],
    };
  }
}
