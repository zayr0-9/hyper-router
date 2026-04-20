import type {
  ConversationState,
  Item,
  OpenRouter,
} from "@openrouter/agent";

import type { SessionMetadata } from "../../core/storage.js";

export interface OpenRouterClientLike {
  callModel: OpenRouter["callModel"];
}

export type OpenRouterContinuationStrategy = "transcript" | "state" | "hybrid" | "ephemeral";

export type SerializedOpenRouterState = ConversationState;

export interface OpenRouterStateEnvelope {
  state: SerializedOpenRouterState;
  metadata?: Pick<SessionMetadata, "model" | "promptHash" | "toolsetHash">;
}

export interface OpenRouterStateStore {
  load(sessionId: string): Promise<OpenRouterStateEnvelope | null>;
  save(sessionId: string, envelope: OpenRouterStateEnvelope): Promise<void>;
  clear?(sessionId: string): Promise<void>;
}

export interface OpenRouterContinuationOptions {
  strategy?: OpenRouterContinuationStrategy;
  stateStore?: OpenRouterStateStore;
  invalidateOnModelChange?: boolean;
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  client?: OpenRouterClientLike;
  continuation?: OpenRouterContinuationOptions;
}

export interface OpenRouterToolCallLike {
  id?: string;
  name?: string;
  arguments?: unknown;
}

export type OpenRouterInputItem = Item;
export type OpenRouterStoredConversationState = ConversationState;
