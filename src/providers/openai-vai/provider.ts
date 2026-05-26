import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

import type { ModelProvider } from "../../core/providers.js";
import type { SessionMetadata } from "../../core/storage.js";
import type { AnyToolDefinition } from "../../core/tool.js";
import type { Message, ModelResponse, ReasoningOptions } from "../../core/types.js";
import {
  findLastAssistantMessage,
  normalizeFinishReason,
  normalizeVercelToolCalls,
  readAssistantContent,
  readAssistantReasoningContent,
  toAiSdkTools,
  toModelMessages,
} from "../vercel-ai/shared.js";
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
  private readonly reasoning: ReasoningOptions | undefined;
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
    this.reasoning = options.reasoning;
    this.generateTextImpl = options.generateTextImpl ?? generateText;
  }

  async generate(input: {
    sessionId?: string;
    model: string;
    messages: Message[];
    tools: AnyToolDefinition[];
    previousSessionMetadata?: SessionMetadata | null;
    ephemeral?: boolean;
  }): Promise<ModelResponse> {
    const tools = this.toAiSdkTools(input.tools);
    const providerOptions = this.buildProviderOptions();
    const result = await this.generateTextImpl({
      model: this.getModel(input.model),
      messages: this.toModelMessages(input.messages, { includeReasoning: this.shouldIncludeReasoningInMessages() }),
      ...(input.tools.length > 0 ? { tools: tools as any } : {}),
      ...(providerOptions
        ? {
            providerOptions: {
              openai: providerOptions as any,
            },
          }
        : {}),
      ...(this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {}),
    });

    const responseMessages = result.response.messages;
    const assistantMessage = this.findLastAssistantMessage(responseMessages);
    const normalizedToolCalls = this.normalizeToolCalls(await result.toolCalls);
    const reasoningContent = this.shouldCaptureReasoning()
      ? this.readAssistantReasoningContent(assistantMessage, result)
      : undefined;
    const providerStopReason = result.finishReason;

    const response: ModelResponse = {
      toolCalls: normalizedToolCalls,
      stopReason: this.normalizeFinishReason(providerStopReason),
      ...(providerStopReason ? { providerStopReason } : {}),
    };

    if (assistantMessage) {
      const assistantContent = this.readAssistantContent(assistantMessage);
      response.message = {
        role: "assistant",
        content: assistantContent,
        date: new Date(),
        ...(reasoningContent ? { reasoningContent } : {}),
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

  protected toAiSdkTools = toAiSdkTools;
  protected toModelMessages = toModelMessages;
  protected normalizeToolCalls = normalizeVercelToolCalls;
  protected findLastAssistantMessage = findLastAssistantMessage;
  protected readAssistantContent = readAssistantContent;
  protected normalizeFinishReason = normalizeFinishReason;

  protected readAssistantReasoningContent(
    message: { content: unknown; providerMetadata?: unknown } | undefined,
    result?: unknown,
  ): string | undefined {
    return readAssistantReasoningContent({
      message,
      result,
      providerMetadataKey: "openai",
      extraCandidates: (candidateResult) => {
        const resultRecord = candidateResult as any;
        return [
          resultRecord?.response?.body?.choices?.[0]?.message?.reasoning_content,
          resultRecord?.steps?.at?.(-1)?.response?.body?.choices?.[0]?.message?.reasoning_content,
        ];
      },
    });
  }

  private buildProviderOptions(): OpenAIVAIProviderSpecificOptions | undefined {
    if (!this.reasoning && !this.defaultProviderOptions) {
      return undefined;
    }

    return this.mergeProviderOptions(this.defaultProviderOptions);
  }

  private mergeProviderOptions(
    providerOptions: OpenAIVAIProviderSpecificOptions | undefined,
  ): OpenAIVAIProviderSpecificOptions {
    if (this.reasoning === false) {
      return {
        ...(providerOptions as Record<string, unknown> | undefined),
        reasoningEffort: "none",
      } as OpenAIVAIProviderSpecificOptions;
    }

    if (!this.reasoning) {
      return (providerOptions ?? {}) as OpenAIVAIProviderSpecificOptions;
    }

    const reasoningPatch: Record<string, unknown> = {};
    if (this.reasoning.enabled === false) {
      reasoningPatch.reasoningEffort = "none";
    } else if (this.reasoning.effort) {
      reasoningPatch.reasoningEffort = this.reasoning.effort;
    }

    return {
      ...(providerOptions as Record<string, unknown> | undefined),
      ...reasoningPatch,
    } as OpenAIVAIProviderSpecificOptions;
  }

  private shouldCaptureReasoning(): boolean {
    return this.reasoning === false ? false : this.reasoning?.capture ?? true;
  }

  private shouldIncludeReasoningInMessages(): boolean {
    return this.reasoning === false ? false : this.reasoning?.includeInMessages ?? true;
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
