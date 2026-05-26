import { z } from "zod/v4";

import type { ModelProvider } from "../../core/providers.js";
import { normalizeSchema } from "../../core/schema.js";
import type { SessionMetadata } from "../../core/storage.js";
import type { AnyToolDefinition } from "../../core/tool.js";
import type { Message, ModelResponse, ReasoningOptions, StopReason, ToolCall } from "../../core/types.js";
import type { GLMProviderOptions } from "./types.js";

const GENERAL_BASE_URL = "https://api.z.ai/api/paas/v4/";
const CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4/";

type GLMRole = "system" | "user" | "assistant" | "tool";

interface GLMMessage {
  role: GLMRole;
  content: string;
  reasoning_content?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: GLMToolCall[];
}

interface GLMToolCall {
  id?: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface GLMChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: GLMToolCall[];
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
}

export class GLMProvider implements ModelProvider {
  private readonly apiKey: string | undefined;
  private readonly baseURL: string;
  private readonly thinking: GLMProviderOptions["thinking"];
  private readonly reasoning: ReasoningOptions | undefined;
  private readonly rawBody: Record<string, unknown> | undefined;
  private readonly headers: [string, string][] | Record<string, string> | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GLMProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ZAI_API_KEY;
    this.baseURL = options.baseURL ?? (options.endpoint === "coding" ? CODING_BASE_URL : GENERAL_BASE_URL);
    this.thinking = options.thinking;
    this.reasoning = options.reasoning;
    this.rawBody = options.rawBody;
    this.headers = options.headers;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async generate(input: {
    sessionId?: string;
    model: string;
    messages: Message[];
    tools: AnyToolDefinition[];
    previousSessionMetadata?: SessionMetadata | null;
    ephemeral?: boolean;
  }): Promise<ModelResponse> {
    const response = await this.fetchImpl(this.chatCompletionsUrl(), {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model: input.model,
        messages: this.toGLMMessages(input.messages),
        ...(input.tools.length > 0 ? { tools: this.toGLMTools(input.tools) } : {}),
        ...this.rawBody,
        ...(this.getThinkingOptions() ? { thinking: this.getThinkingOptions() } : {}),
      }),
    });

    const text = await response.text();
    const json = this.parseResponse(text);

    if (!response.ok) {
      throw new Error(this.formatError(response.status, json, text));
    }

    const choice = json.choices?.[0];
    const message = choice?.message;
    const normalizedToolCalls = this.normalizeToolCalls(message?.tool_calls ?? []);
    const content = message?.content ?? "";
    const reasoningContent = this.shouldCaptureReasoning()
      ? message?.reasoning_content ?? undefined
      : undefined;

    const providerStopReason = choice?.finish_reason ?? undefined;
    const modelResponse: ModelResponse = {
      toolCalls: normalizedToolCalls,
      stopReason: this.normalizeFinishReason(providerStopReason),
      ...(providerStopReason ? { providerStopReason } : {}),
    };

    if (message || normalizedToolCalls.length > 0 || content.length > 0 || reasoningContent) {
      modelResponse.message = {
        role: "assistant",
        content,
        date: new Date(),
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(normalizedToolCalls.length > 0 ? { toolCalls: normalizedToolCalls } : {}),
      };
    }

    return modelResponse;
  }

  protected toGLMMessages(messages: Message[]): GLMMessage[] {
    return messages.map((message): GLMMessage => {
      if (message.role === "tool") {
        return {
          role: "tool",
          content: message.content,
          tool_call_id: message.toolCallId ?? `${message.name ?? "tool"}-result`,
          ...(message.name ? { name: message.name } : {}),
        };
      }

      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: message.content,
          ...(message.reasoningContent && this.shouldSendReasoningContent()
            ? { reasoning_content: message.reasoningContent }
            : {}),
          ...(message.toolCalls?.length ? { tool_calls: this.toGLMToolCalls(message.toolCalls) } : {}),
        };
      }

      return {
        role: message.role,
        content: message.content,
      };
    });
  }

  protected toGLMTools(tools: AnyToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.toJsonSchema(tool.inputSchema),
      },
    }));
  }

  protected toJsonSchema(inputSchema: unknown): Record<string, unknown> {
    const normalized = normalizeSchema(inputSchema);

    if (normalized.kind === "json-schema") {
      return normalized.schema;
    }

    if (normalized.kind === "zod") {
      return z.toJSONSchema(normalized.schema as z.ZodType) as Record<string, unknown>;
    }

    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  protected toGLMToolCalls(toolCalls: ToolCall[]): GLMToolCall[] {
    return toolCalls.map((toolCall) => ({
      ...(toolCall.id ? { id: toolCall.id } : {}),
      type: "function",
      function: {
        name: toolCall.toolName,
        arguments: JSON.stringify(toolCall.args ?? {}),
      },
    }));
  }

  protected normalizeToolCalls(toolCalls: GLMToolCall[]): ToolCall[] {
    return toolCalls.map((toolCall) => ({
      ...(toolCall.id ? { id: toolCall.id } : {}),
      toolName: toolCall.function.name,
      args: this.parseToolArguments(toolCall.function.arguments),
    }));
  }

  protected parseToolArguments(args: string): unknown {
    if (!args.trim()) {
      return {};
    }

    try {
      return JSON.parse(args) as unknown;
    } catch {
      return args;
    }
  }

  protected normalizeFinishReason(finishReason: string | null | undefined): StopReason {
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

  protected shouldSendReasoningContent(): boolean {
    return this.shouldIncludeReasoningInMessages()
      && this.getThinkingOptions()?.type === "enabled"
      && this.getThinkingOptions()?.clear_thinking === false;
  }

  private getThinkingOptions(): GLMProviderOptions["thinking"] {
    if (this.reasoning === false) {
      return { ...this.thinking, type: "disabled" };
    }

    if (!this.reasoning) {
      return this.thinking;
    }

    if (
      this.reasoning.enabled === undefined
      && !this.reasoning.effort
      && this.reasoning.budgetTokens === undefined
    ) {
      return this.thinking;
    }

    return {
      ...this.thinking,
      ...(this.reasoning.enabled === false ? { type: "disabled" as const } : {}),
      ...(this.reasoning.enabled === true || this.reasoning.effort || this.reasoning.budgetTokens
        ? { type: "enabled" as const }
        : {}),
      ...(this.reasoning.effort ? { effort: this.reasoning.effort } : {}),
      ...(this.reasoning.budgetTokens !== undefined ? { budget_tokens: this.reasoning.budgetTokens } : {}),
    };
  }

  private shouldCaptureReasoning(): boolean {
    return this.reasoning === false ? false : this.reasoning?.capture ?? true;
  }

  private shouldIncludeReasoningInMessages(): boolean {
    return this.reasoning === false ? false : this.reasoning?.includeInMessages ?? true;
  }

  private chatCompletionsUrl(): string {
    return new URL("chat/completions", this.baseURL).toString();
  }

  private buildHeaders(): Headers {
    const headers = new Headers(this.headers);
    headers.set("content-type", "application/json");

    if (this.apiKey && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${this.apiKey}`);
    }

    return headers;
  }

  private parseResponse(text: string): GLMChatResponse {
    if (!text.trim()) {
      return {};
    }

    try {
      return JSON.parse(text) as GLMChatResponse;
    } catch (error) {
      throw new Error(`Invalid Z.AI response JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private formatError(status: number, json: GLMChatResponse, text: string): string {
    const message = json.error?.message ?? text;
    return `Z.AI chat completion failed with status ${status}${message ? `: ${message}` : ""}`;
  }
}
