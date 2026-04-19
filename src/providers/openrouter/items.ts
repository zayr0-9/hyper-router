import type {
  FunctionCallOutputItem,
  OutputFunctionCallItem,
  OutputMessage,
} from "@openrouter/agent";

import type { Message } from "../../core/types.js";
import type { OpenRouterInputItem } from "./types.js";

export function toInputItems(messages: Message[]): OpenRouterInputItem[] {
  const items: OpenRouterInputItem[] = [];

  for (const [index, message] of messages.entries()) {
    if (message.role === "tool") {
      items.push({
        type: "function_call_output",
        callId: message.toolCallId ?? `${message.name ?? "tool"}-result`,
        output: message.content,
      } satisfies FunctionCallOutputItem);
      continue;
    }

    if (message.role === "assistant") {
      if (message.content && message.content.trim().length > 0) {
        items.push({
          id: toOpenRouterMessageItemId(message, index),
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: message.content,
              annotations: [],
            },
          ],
        } satisfies OutputMessage);
      }

      for (const toolCall of message.toolCalls ?? []) {
        items.push({
          type: "function_call",
          callId: toolCall.id ?? `${toolCall.toolName}-call`,
          name: toolCall.toolName,
          arguments: JSON.stringify(toolCall.args ?? {}),
        } satisfies OutputFunctionCallItem);
      }

      continue;
    }

    if (message.role === "system") {
      items.push({
        id: toOpenRouterMessageItemId(message, index),
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: message.content,
          },
        ],
      } satisfies OpenRouterInputItem);
      continue;
    }

    items.push({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: message.content,
        },
      ],
    } satisfies OpenRouterInputItem);
  }

  return items;
}

export function toOpenRouterMessageItemId(message: Message, index: number): string {
  return `${message.role}-${message.date.getTime()}-${index}`;
}
