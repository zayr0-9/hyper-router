import type {
  ConversationState,
  Item,
  OpenRouter,
} from "@openrouter/agent";

export interface OpenRouterClientLike {
  callModel: OpenRouter["callModel"];
}

export interface OpenRouterProviderOptions {
  apiKey?: string;
  client?: OpenRouterClientLike;
}

export interface OpenRouterToolCallLike {
  id?: string;
  name?: string;
  arguments?: unknown;
}

export type SerializedOpenRouterState = unknown;

export interface SessionStateRecord {
  state: SerializedOpenRouterState | null;
  syncedExternalMessageCount: number;
}

export type OpenRouterInputItem = Item;
export type OpenRouterStoredConversationState = ConversationState;
