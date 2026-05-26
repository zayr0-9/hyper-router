import { tool, type FlexibleSchema, type ModelMessage } from "ai";

import { normalizeSchema } from "../../core/schema.js";
import type { AnyToolDefinition } from "../../core/tool.js";
import type { Message, StopReason, ToolCall } from "../../core/types.js";

export interface VercelToolCallLike {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export function toAiSdkTools(tools: AnyToolDefinition[]): Record<string, unknown> {
  return Object.fromEntries(
    tools.map((toolDefinition) => [
      toolDefinition.name,
      tool({
        description: toolDefinition.description,
        inputSchema: toToolSchema(toolDefinition.inputSchema),
      }),
    ]),
  );
}

export function toToolSchema(schema: unknown): FlexibleSchema<Record<string, unknown>> {
  const normalized = normalizeSchema(schema);

  if (normalized.kind === "zod") {
    return normalized.schema as FlexibleSchema<Record<string, unknown>>;
  }

  if (normalized.kind === "json-schema") {
    return normalized.schema as FlexibleSchema<Record<string, unknown>>;
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  } as unknown as FlexibleSchema<Record<string, unknown>>;
}

export function toModelMessages(
  messages: Message[],
  options: { includeReasoning?: boolean } = {},
): ModelMessage[] {
  const includeReasoning = options.includeReasoning ?? true;

  return messages.map((message): ModelMessage => {
    if (message.role === "tool") {
      return {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: message.toolCallId ?? `${message.name ?? "tool"}-result`,
            toolName: message.name ?? "tool",
            output: toToolResultOutput(message.content),
          },
        ],
      };
    }

    if (message.role === "assistant") {
      const contentParts: Array<
        | { type: "reasoning"; text: string }
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];

      if (includeReasoning && message.reasoningContent && message.reasoningContent.trim().length > 0) {
        contentParts.push({
          type: "reasoning",
          text: message.reasoningContent,
        });
      }

      if (message.content.length > 0) {
        contentParts.push({
          type: "text",
          text: message.content,
        });
      }

      for (const toolCall of message.toolCalls ?? []) {
        contentParts.push({
          type: "tool-call",
          toolCallId: toolCall.id ?? `${toolCall.toolName}-call`,
          toolName: toolCall.toolName,
          input: toolCall.args ?? {},
        });
      }

      return {
        role: "assistant" as const,
        content:
          contentParts.length === 1 && contentParts[0]?.type === "text"
            ? contentParts[0].text
            : contentParts,
      };
    }

    return {
      role: message.role,
      content: message.content,
    };
  });
}

export function toToolResultOutput(
  content: string,
): { type: "text"; value: string } | { type: "json"; value: any } {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed) || isRecord(parsed)) {
      return {
        type: "json",
        value: parsed,
      };
    }

    return {
      type: "text",
      value: content,
    };
  } catch {
    return {
      type: "text",
      value: content,
    };
  }
}

export function normalizeVercelToolCalls(toolCalls: VercelToolCallLike[]): ToolCall[] {
  return toolCalls.map((toolCall) => ({
    id: toolCall.toolCallId,
    toolName: toolCall.toolName,
    args: toolCall.input,
  }));
}

export function findLastAssistantMessage(messages: Array<{ role: string; content: unknown }>) {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

export function readAssistantContent(message: { content: unknown }): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return "";
  }

  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export function normalizeFinishReason(finishReason: string | undefined): StopReason {
  switch (finishReason) {
    case "stop":
    case "tool_calls":
      return finishReason;
    case "tool-calls":
      return "tool_calls";
    case "length":
    case "max_tokens":
      return "length";
    case "content-filter":
    case "content_filter":
      return "content_filter";
    case "refusal":
      return "refusal";
    case "error":
    case "provider_error":
      return "provider_error";
    default:
      return "unknown";
  }
}

export function readAssistantReasoningContent(options: {
  message: { content: unknown; providerMetadata?: unknown } | undefined;
  result?: unknown;
  providerMetadataKey: string;
  extraCandidates?: (result: unknown) => unknown[];
}): string | undefined {
  const candidates: unknown[] = [];
  const { message, providerMetadataKey } = options;

  if (message) {
    const record = message as any;
    candidates.push(
      record.reasoningContent,
      record.reasoning_content,
      record.providerMetadata?.[providerMetadataKey]?.reasoningContent,
      record.providerMetadata?.[providerMetadataKey]?.reasoning_content,
      record.providerOptions?.[providerMetadataKey]?.reasoningContent,
      record.providerOptions?.[providerMetadataKey]?.reasoning_content,
    );

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const partRecord = part as any;
        candidates.push(
          partRecord.reasoningContent,
          partRecord.reasoning_content,
          partRecord.providerMetadata?.[providerMetadataKey]?.reasoningContent,
          partRecord.providerMetadata?.[providerMetadataKey]?.reasoning_content,
        );

        if (partRecord.type === "reasoning") {
          candidates.push(partRecord.text);
        }
      }
    }
  }

  if (options.extraCandidates) {
    candidates.push(...options.extraCandidates(options.result));
  }

  return joinReasoningCandidates(candidates);
}

export function joinReasoningCandidates(candidates: unknown[]): string | undefined {
  return candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n") || undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
