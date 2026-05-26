import { generateText } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";

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
  AmazonBedrockVAIProviderOptions,
  AmazonBedrockVAIProviderSpecificOptions,
} from "./types.js";

export class AmazonBedrockVAIProvider implements ModelProvider {
  private readonly provider;
  private readonly maxRetries: number | undefined;
  private readonly defaultProviderOptions: AmazonBedrockVAIProviderSpecificOptions | undefined;
  private readonly reasoning: ReasoningOptions | undefined;
  private readonly generateTextImpl: typeof generateText;

  constructor(options: AmazonBedrockVAIProviderOptions = {}) {
    this.provider =
      options.provider ??
      createAmazonBedrock({
        ...(options.region ? { region: options.region } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.accessKeyId ? { accessKeyId: options.accessKeyId } : {}),
        ...(options.secretAccessKey ? { secretAccessKey: options.secretAccessKey } : {}),
        ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
        ...(options.baseURL ? { baseURL: options.baseURL } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.credentialProvider ? { credentialProvider: options.credentialProvider } : {}),
      });

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
      model: this.provider(input.model),
      messages: this.toModelMessages(input.messages, { includeReasoning: this.shouldIncludeReasoningInMessages() }),
      ...(input.tools.length > 0 ? { tools: tools as any } : {}),
      ...(providerOptions
        ? {
            providerOptions: {
              bedrock: providerOptions as any,
            },
          }
        : {}),
      ...(this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {}),
    });

    const responseMessages = result.response.messages;
    const assistantMessage = this.findLastAssistantMessage(responseMessages);
    const normalizedToolCalls = this.normalizeToolCalls(await result.toolCalls);
    const reasoningContent = this.shouldCaptureReasoning()
      ? this.readAssistantReasoningContent(assistantMessage)
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
  ): string | undefined {
    return readAssistantReasoningContent({
      message,
      providerMetadataKey: "bedrock",
    });
  }

  private buildProviderOptions(): AmazonBedrockVAIProviderSpecificOptions | undefined {
    if (!this.reasoning && !this.defaultProviderOptions) {
      return undefined;
    }

    return this.mergeProviderOptions(this.defaultProviderOptions);
  }

  private mergeProviderOptions(
    providerOptions: AmazonBedrockVAIProviderSpecificOptions | undefined,
  ): AmazonBedrockVAIProviderSpecificOptions {
    if (this.reasoning === false) {
      return {
        ...(providerOptions as Record<string, unknown> | undefined),
        reasoningConfig: { type: "disabled" },
      } as AmazonBedrockVAIProviderSpecificOptions;
    }

    if (!this.reasoning) {
      return (providerOptions ?? {}) as AmazonBedrockVAIProviderSpecificOptions;
    }

    const reasoningConfig: Record<string, unknown> = {};
    if (this.reasoning.enabled === false) {
      reasoningConfig.type = "disabled";
    } else if (this.reasoning.enabled === true || this.reasoning.effort || this.reasoning.budgetTokens) {
      reasoningConfig.type = "enabled";
    }
    if (this.reasoning.effort) {
      reasoningConfig.maxReasoningEffort = this.reasoning.effort;
    }
    if (this.reasoning.budgetTokens !== undefined) {
      reasoningConfig.budgetTokens = this.reasoning.budgetTokens;
    }

    return {
      ...(providerOptions as Record<string, unknown> | undefined),
      ...(Object.keys(reasoningConfig).length > 0 ? { reasoningConfig } : {}),
    } as AmazonBedrockVAIProviderSpecificOptions;
  }

  private shouldCaptureReasoning(): boolean {
    return this.reasoning === false ? false : this.reasoning?.capture ?? true;
  }

  private shouldIncludeReasoningInMessages(): boolean {
    return this.reasoning === false ? false : this.reasoning?.includeInMessages ?? true;
  }
}

