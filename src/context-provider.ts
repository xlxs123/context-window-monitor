import type { ProviderResult } from "./context-types.js";

export interface ContextProviderOptions {
  sessionId?: string;
}

export interface ContextProvider {
  getContext(options?: ContextProviderOptions): Promise<ProviderResult>;
}
