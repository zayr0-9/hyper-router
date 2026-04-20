import { generateText, tool, type FlexibleSchema, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import type { ModelProvider } from "../../core/providers.js";
import type { SessionMetadata } from "../../core/storage.js";
import type { ToolDefinition } from "../../core/tool.js";
import type { Message, ModelResponse, ToolCall } from "../../core/types.js";
import type {
  OpenAIVAIApiMode,
  OpenAIVAIProviderOptions,
  OpenAIVAIProviderSpecificOptions,
} from "./types.js";

export class OpenAIVAIProvider implements ModelProvider {
  private readonly provider;
  private readonly apiMode: OpenAIVAIApiMode;
  private readonly maxRetries: number | undefined;
  private readonly defaultProviderOptions: OpenAIVAIProviderSpecificOptions | undefined;
  private readonly generateTextImpl: typeof generateText;

  constructor(options: OpenAIVAIProviderOptions = {}) {
    this.provider =
      options.provider ??
      createOpenAI({
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        ...(options.name ? { name: options.name } : {}),
        ...(options.organization ? { organization: options.organization } : {}),
        ...(options.project ? { project: options.project } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });

    this.apiMode = options.api ?? "auto";
    this.maxRetries = options.maxRetries;
    this.defaultProviderOptions = options.providerOptions;
    this.generateTextImpl = options.generateTextImpl ?? generateText;
  }

  async generate(input: {
    sessionId?: string;
    model: string;
    messages: Message[];
    tools: ToolDefinition<any, any>[];
    previousSessionMetadata?: SessionMetadata | null;
    ephemeral?: boolean;
  }): Promise<ModelResponse> {
    const tools = this.toAiSdkTools(input.tools);
    const result = await this.generateTextImpl({
      model: this.getModel(input.model),
      messages: this.toModelMessages(input.messages),
      tools: tools as any,
      ...(this.defaultProviderOptions
        ? {
            providerOptions: {
              openai: this.defaultProviderOptions,
            },
          }
        : {}),
      ...(this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {}),
    });

    const responseMessages = result.response.messages;
    const assistantMessage = this.findLastAssistantMessage(responseMessages);
    const normalizedToolCalls = this.normalizeToolCalls(await result.toolCalls);

    const response: ModelResponse = {
      toolCalls: normalizedToolCalls,
      stopReason: this.normalizeFinishReason(result.finishReason),
    };

    if (assistantMessage) {
      const assistantContent = this.readAssistantContent(assistantMessage);
      response.message = {
        role: "assistant",
        content: assistantContent,
        date: new Date(),
        ...(normalizedToolCalls.length > 0 ? { toolCalls: normalizedToolCalls } : {}),
      };
    } else if (normalizedToolCalls.length > 0) {
      response.message = {
        role: "assistant",
        content: "",
        date: new Date(),
        toolCalls: normalizedToolCalls,
      };
    }

    return response;
  }

  protected toAiSdkTools(tools: ToolDefinition<any, any>[]): Record<string, unknown> {
    return Object.fromEntries(
      tools.map((toolDefinition) => [
        toolDefinition.name,
        tool({
          description: toolDefinition.description,
          inputSchema: this.toToolSchema(toolDefinition.inputSchema),
        }),
      ]),
    );
  }

  protected toToolSchema(schema: unknown): FlexibleSchema<Record<string, unknown>> {
    return (schema ?? { type: "object", properties: {}, additionalProperties: true }) as FlexibleSchema<
      Record<string, unknown>
    >;
  }

  protected toModelMessages(messages: Message[]): ModelMessage[] {
    return messages.map((message): ModelMessage => {
      if (message.role === "tool") {
        return {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: message.toolCallId ?? `${message.name ?? "tool"}-result`,
              toolName: message.name ?? "tool",
              output: this.toToolResultOutput(message.content),
            },
          ],
        };
      }

      if (message.role === "assistant") {
        const contentParts: Array<
          | { type: "text"; text: string }
          | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
        > = [];

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
          content: contentParts.length === 1 && contentParts[0]?.type === "text"
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

  protected toToolResultOutput(content: string): { type: "text"; value: string } | { type: "json"; value: any } {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        return {
          type: "json",
          value: parsed,
        };
      }

      if (this.isRecord(parsed)) {
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

  protected normalizeToolCalls(
    toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
  ): ToolCall[] {
    return toolCalls.map((toolCall) => ({
      id: toolCall.toolCallId,
      toolName: toolCall.toolName,
      args: toolCall.input,
    }));
  }

  protected findLastAssistantMessage(
    messages: Array<{ role: string; content: unknown }>,
  ) {
    return [...messages].reverse().find((message) => message.role === "assistant");
  }

  protected readAssistantContent(
    message: { content: unknown },
  ): string {
    if (typeof message.content === "string") {
      return message.content;
    }

    if (!Array.isArray(message.content)) {
      return "";
    }

    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          this.isRecord(part) && part.type === "text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("");
  }

  protected normalizeFinishReason(finishReason: string): string {
    return finishReason === "tool-calls" ? "tool_calls" : finishReason;
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  private getModel(model: string) {
    switch (this.apiMode) {
      case "responses":
        return this.provider.responses(model);
      case "chat":
        return this.provider.chat(model);
      case "completion":
        return this.provider.completion(model);
      case "auto":
      default:
        return this.provider(model);
    }
  }
}

export { OpenAIVAIProvider as OpenAIProvider };
