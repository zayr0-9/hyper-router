import {
  appendToMessages,
  type ConversationState,
  type StateAccessor,
  type Tool as OpenRouterAgentTool,
} from "@openrouter/agent";

import { toInputItems } from "./items.js";
import type {
  OpenRouterStateEnvelope,
  OpenRouterStateStore,
  OpenRouterStoredConversationState,
  SerializedOpenRouterState,
} from "./types.js";
import type { Message } from "../../core/types.js";
import type { SessionMetadata } from "../../core/storage.js";

export function createStateAccessor<TTools extends readonly OpenRouterAgentTool[]>(options: {
  sessionId: string;
  stateStore: OpenRouterStateStore;
  metadata?: Pick<SessionMetadata, "model" | "promptHash" | "toolsetHash">;
}): StateAccessor<TTools> {
  return {
    load: async () => deserializeState<TTools>((await options.stateStore.load(options.sessionId))?.state ?? null),
    save: async (state) => {
      await options.stateStore.save(options.sessionId, createStateEnvelope(state, options.metadata));
    },
  };
}

export function serializeState<TTools extends readonly OpenRouterAgentTool[]>(
  state: ConversationState<TTools>,
): SerializedOpenRouterState {
  return JSON.parse(JSON.stringify(state)) as SerializedOpenRouterState;
}

export function createStateEnvelope<TTools extends readonly OpenRouterAgentTool[]>(
  state: ConversationState<TTools>,
  metadata?: Pick<SessionMetadata, "model" | "promptHash" | "toolsetHash">,
): OpenRouterStateEnvelope {
  return {
    state: serializeState(state),
    ...(metadata ? { metadata } : {}),
  };
}

export function deserializeState<TTools extends readonly OpenRouterAgentTool[]>(
  state: SerializedOpenRouterState | null,
): ConversationState<TTools> | null {
  if (!state) {
    return null;
  }

  return state as ConversationState<TTools>;
}

export function getExternalMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.role === "user" || message.role === "tool");
}

export async function syncExternalMessagesIntoState(options: {
  sessionId: string;
  stateStore: OpenRouterStateStore;
  messages: Message[];
  syncedExternalMessageCount: number;
  metadata?: Pick<SessionMetadata, "model" | "promptHash" | "toolsetHash">;
}): Promise<number> {
  const envelope = await options.stateStore.load(options.sessionId);
  if (!envelope) {
    return options.syncedExternalMessageCount;
  }

  const externalMessages = getExternalMessages(options.messages);
  const newExternalMessages = externalMessages.slice(options.syncedExternalMessageCount);

  if (newExternalMessages.length === 0) {
    return externalMessages.length;
  }

  const conversationState = envelope.state as OpenRouterStoredConversationState;

  conversationState.messages = appendToMessages(
    conversationState.messages,
    toInputItems(newExternalMessages),
  );
  conversationState.updatedAt = Date.now();
  await options.stateStore.save(
    options.sessionId,
    createStateEnvelope(conversationState, options.metadata ?? envelope.metadata),
  );

  return externalMessages.length;
}
