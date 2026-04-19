import {
  appendToMessages,
  type ConversationState,
  type StateAccessor,
  type Tool as OpenRouterAgentTool,
} from "@openrouter/agent";

import { toInputItems } from "./items.js";
import type {
  OpenRouterStoredConversationState,
  SerializedOpenRouterState,
  SessionStateRecord,
} from "./types.js";
import type { Message } from "../../core/types.js";

export function createStateAccessor<TTools extends readonly OpenRouterAgentTool[]>(
  sessionRecord: SessionStateRecord,
): StateAccessor<TTools> {
  return {
    load: async () => deserializeState<TTools>(sessionRecord.state),
    save: async (state) => {
      sessionRecord.state = serializeState(state);
    },
  };
}

export function serializeState<TTools extends readonly OpenRouterAgentTool[]>(
  state: ConversationState<TTools>,
): SerializedOpenRouterState {
  return JSON.parse(JSON.stringify(state));
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

export function syncExternalMessagesIntoState(
  sessionRecord: SessionStateRecord,
  messages: Message[],
): void {
  if (!sessionRecord.state) {
    return;
  }

  const externalMessages = getExternalMessages(messages);
  const newExternalMessages = externalMessages.slice(sessionRecord.syncedExternalMessageCount);

  if (newExternalMessages.length === 0) {
    return;
  }

  const conversationState = sessionRecord.state as OpenRouterStoredConversationState;

  conversationState.messages = appendToMessages(
    conversationState.messages,
    toInputItems(newExternalMessages),
  );
  conversationState.updatedAt = Date.now();
  sessionRecord.state = serializeState(conversationState);
}
