import type { ReasoningOptions } from "../../core/types.js";

export interface GLMThinkingOptions {
  type?: "enabled" | "disabled";
  clear_thinking?: boolean;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  budget_tokens?: number;
}

export type GLMEndpoint = "general" | "coding";

export interface GLMProviderOptions {
  apiKey?: string;
  baseURL?: string;
  endpoint?: GLMEndpoint;
  thinking?: GLMThinkingOptions;
  reasoning?: ReasoningOptions;
  rawBody?: Record<string, unknown>;
  headers?: [string, string][] | Record<string, string>;
  fetch?: typeof fetch;
}
