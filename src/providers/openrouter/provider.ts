import {
  OpenRouter,
  tool as openRouterTool,
} from "@openrouter/agent";
import { z } from "zod/v4";

import type { ModelProvider } from "../../core/providers.js";
import { normalizeSchema } from "../../core/schema.js";
import type { SessionMetadata } from "../../core/storage.js";
import type { AnyToolDefinition } from "../../core/tool.js";
import type { GeneratedImage, Message, ModelResponse, ReasoningOptions, StopReason, ToolCall } from "../../core/types.js";
import { toInputItems } from "./items.js";
import {
  createStateAccessor,
  getExternalMessages,
  syncExternalMessagesIntoState,
} from "./state.js";
import type {
  OpenRouterClientLike,
  OpenRouterContinuationStrategy,
  OpenRouterInputItem,
  OpenRouterProviderOptions,
  OpenRouterStateEnvelope,
  OpenRouterStateStore,
  OpenRouterToolCallLike,
} from "./types.js";

interface SessionProgressRecord {
  syncedExternalMessageCount: number;
}

class InMemoryOpenRouterStateStore implements OpenRouterStateStore {
  private readonly states = new Map<string, Awaited<ReturnType<OpenRouterStateStore["load"]>>>();

  async load(sessionId: string) {
    return this.states.get(sessionId) ?? null;
  }

  async save(sessionId: string, envelope: Parameters<OpenRouterStateStore["save"]>[1]) {
    this.states.set(sessionId, JSON.parse(JSON.stringify(envelope)) as Parameters<OpenRouterStateStore["save"]>[1]);
  }

  async clear(sessionId: string) {
    this.states.delete(sessionId);
  }
}

export class OpenRouterProvider implements ModelProvider {
  private readonly client: OpenRouterClientLike;
  private readonly continuationStrategy: OpenRouterContinuationStrategy;
  private readonly stateStore: OpenRouterStateStore | undefined;
  private readonly invalidateOnModelChange: boolean;
  private readonly reasoning: ReasoningOptions | undefined;
  private readonly callOptions: Record<string, unknown> | undefined;
  private readonly sessionProgress = new Map<string, SessionProgressRecord>();

  constructor(options: OpenRouterProviderOptions = {}) {
    this.continuationStrategy = options.continuation?.strategy ?? (options.continuation?.stateStore ? "hybrid" : "transcript");
    this.stateStore =
      this.continuationStrategy === "transcript" || this.continuationStrategy === "ephemeral"
        ? undefined
        : (options.continuation?.stateStore ?? new InMemoryOpenRouterStateStore());
    this.invalidateOnModelChange = options.continuation?.invalidateOnModelChange ?? true;
    this.reasoning = options.reasoning;
    this.callOptions = options.callOptions;

    if (options.client) {
      this.client = options.client;
      return;
    }

    const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenRouterProvider: missing API key. Set OPENROUTER_API_KEY or pass { apiKey }.",
      );
    }

    this.client = new OpenRouter({ apiKey });
  }

  async generate(input: {
    sessionId?: string;
    model: string;
    messages: Message[];
    tools: AnyToolDefinition[];
    previousSessionMetadata?: SessionMetadata | null;
    ephemeral?: boolean;
  }): Promise<ModelResponse> {
    const toolDefs = input.tools.map((tool) =>
      openRouterTool({
        name: tool.name,
        description: tool.description,
        inputSchema: this.toZodInputSchema(tool.inputSchema),
        execute: false,
      }),
    );

    const sessionId = input.sessionId;
    const isEphemeral = input.ephemeral === true || this.continuationStrategy === "ephemeral";
    const useState = Boolean(!isEphemeral && sessionId && this.stateStore && this.continuationStrategy !== "transcript");
    const externalMessages = getExternalMessages(input.messages);
    const stateMetadata = this.toStateMetadata(input.previousSessionMetadata, input.model);

    let syncedExternalMessageCount = 0;
    let hasExistingState = false;

    if (useState && sessionId) {
      const progress = this.getSessionProgress(sessionId);
      syncedExternalMessageCount = progress.syncedExternalMessageCount;

      if (externalMessages.length < syncedExternalMessageCount) {
        await this.clearSessionState(sessionId, progress);
        syncedExternalMessageCount = 0;
      }

      const existingEnvelope = await this.stateStore!.load(sessionId);
      if (existingEnvelope && this.shouldInvalidateState(existingEnvelope, stateMetadata)) {
        await this.clearSessionState(sessionId, progress);
      }

      const currentEnvelope = await this.stateStore!.load(sessionId);
      hasExistingState = Boolean(currentEnvelope?.state);

      if (hasExistingState) {
        syncedExternalMessageCount = await syncExternalMessagesIntoState({
          sessionId,
          stateStore: this.stateStore!,
          messages: input.messages,
          syncedExternalMessageCount,
          metadata: stateMetadata,
        });
        progress.syncedExternalMessageCount = syncedExternalMessageCount;
      }
    }

    const requestInput: OpenRouterInputItem[] =
      useState && hasExistingState
        ? []
        : this.continuationStrategy === "state"
          ? toInputItems(externalMessages, { includeReasoning: this.shouldIncludeReasoningInMessages() })
          : toInputItems(input.messages, { includeReasoning: this.shouldIncludeReasoningInMessages() });

    const callResult = useState && sessionId
      ? this.client.callModel({
          ...this.buildCallOptions(),
          model: input.model,
          input: requestInput,
          tools: toolDefs,
          state: createStateAccessor<typeof toolDefs>({
            sessionId,
            stateStore: this.stateStore!,
            metadata: stateMetadata,
          }),
        })
      : this.client.callModel({
          ...this.buildCallOptions(),
          model: input.model,
          input: requestInput,
          tools: toolDefs,
        });

    const [text, toolCalls, fullResponse] = await Promise.all([
      callResult.getText(),
      callResult.getToolCalls(),
      callResult.getResponse(),
    ]);
    const normalizedToolCalls = this.normalizeToolCalls(toolCalls as OpenRouterToolCallLike[]);
    const generatedImages = this.extractGeneratedImages(fullResponse as { output?: Array<{ type?: unknown; result?: unknown }> });
    const reasoningContent = this.shouldCaptureReasoning()
      ? this.extractReasoningContent(fullResponse)
      : undefined;
    const providerStopReason = this.extractProviderStopReason(fullResponse);

    if (useState && sessionId) {
      this.getSessionProgress(sessionId).syncedExternalMessageCount = externalMessages.length;
    }

    const response: ModelResponse = {
      toolCalls: normalizedToolCalls,
      stopReason: normalizedToolCalls.length > 0 ? "tool_calls" : this.normalizeFinishReason(providerStopReason),
      ...(providerStopReason ? { providerStopReason } : {}),
      ...(generatedImages.length > 0 ? { generatedImages } : {}),
    };

    if (text && text.trim().length > 0) {
      response.message = {
        role: "assistant",
        content: text,
        date: new Date(),
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(normalizedToolCalls.length > 0 ? { toolCalls: normalizedToolCalls } : {}),
      };
    } else if (normalizedToolCalls.length > 0) {
      response.message = {
        role: "assistant",
        content: "",
        date: new Date(),
        ...(reasoningContent ? { reasoningContent } : {}),
        toolCalls: normalizedToolCalls,
      };
    }

    return response;
  }

  protected toZodInputSchema(inputSchema: unknown) {
    const normalized = normalizeSchema(inputSchema);

    if (normalized.kind === "zod") {
      return normalized.schema as z.ZodObject<any>;
    }

    if (normalized.kind === "json-schema") {
      throw new Error(
        "OpenRouterProvider requires a Zod tool schema. JSON Schema was provided. Use z.object(...) for this provider.",
      );
    }

    return z.object({}).passthrough();
  }

  protected normalizeToolCalls(toolCalls: OpenRouterToolCallLike[]): ToolCall[] {
    return toolCalls.map((toolCall) => ({
      ...(toolCall.id ? { id: toolCall.id } : {}),
      toolName: String(toolCall.name ?? "unknown_tool"),
      args: toolCall.arguments ?? {},
    }));
  }

  protected extractReasoningContent(response: unknown): string | undefined {
    const candidates: unknown[] = [];
    const output = (response as any)?.output;

    if (Array.isArray(output)) {
      for (const item of output) {
        candidates.push(item.reasoning, item.reasoning_content, item.reasoningContent);

        if (item.type === "reasoning") {
          candidates.push(item.text, item.content);
        }

        if (Array.isArray(item.content)) {
          for (const part of item.content) {
            candidates.push(part.reasoning, part.reasoning_content, part.reasoningContent);

            if (part.type === "reasoning") {
              candidates.push(part.text, part.content);
            }
          }
        }
      }
    }

    candidates.push(
      (response as any)?.reasoning,
      (response as any)?.reasoning_content,
      (response as any)?.reasoningContent,
    );

    return candidates
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n\n") || undefined;
  }

  protected extractProviderStopReason(response: unknown): string | undefined {
    const record = response as any;
    const candidates = [
      record?.finish_reason,
      record?.finishReason,
      record?.stop_reason,
      record?.stopReason,
      record?.status,
    ];

    return candidates.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
  }

  protected normalizeFinishReason(finishReason: string | undefined): StopReason {
    switch (finishReason) {
      case undefined:
      case "completed":
      case "complete":
      case "stop":
        return "stop";
      case "tool-calls":
      case "tool_calls":
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

  protected extractGeneratedImages(response: {
    output?: Array<{ type?: unknown; result?: unknown }>;
  }): GeneratedImage[] {
    return (response.output ?? [])
      .filter((item) => item.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 0)
      .map((item) => {
        const result = item.result as string;
        if (result.startsWith("data:")) {
          const mimeType = /^data:([^;,]+)/.exec(result)?.[1];
          return {
            dataUrl: result,
            ...(mimeType ? { mimeType } : {}),
          } satisfies GeneratedImage;
        }

        return {
          url: result,
        } satisfies GeneratedImage;
      });
  }

  private buildCallOptions(): Record<string, unknown> {
    const options = { ...(this.callOptions ?? {}) };

    if (this.reasoning === false) {
      return { ...options, reasoning: { enabled: false } };
    }

    if (this.reasoning) {
      options.reasoning = {
        ...(typeof options.reasoning === "object" && options.reasoning !== null ? options.reasoning : {}),
        ...(this.reasoning.enabled !== undefined ? { enabled: this.reasoning.enabled } : {}),
        ...(this.reasoning.effort ? { effort: this.reasoning.effort } : {}),
        ...(this.reasoning.budgetTokens !== undefined ? { budgetTokens: this.reasoning.budgetTokens } : {}),
      };
    }

    return options;
  }

  private shouldCaptureReasoning(): boolean {
    return this.reasoning === false ? false : this.reasoning?.capture ?? true;
  }

  private shouldIncludeReasoningInMessages(): boolean {
    return this.reasoning === false ? false : this.reasoning?.includeInMessages ?? true;
  }

  private toStateMetadata(
    previousSessionMetadata: SessionMetadata | null | undefined,
    model: string,
  ): Pick<SessionMetadata, "model" | "promptHash" | "toolsetHash"> {
    return {
      model,
      ...(previousSessionMetadata?.promptHash ? { promptHash: previousSessionMetadata.promptHash } : {}),
      ...(previousSessionMetadata?.toolsetHash ? { toolsetHash: previousSessionMetadata.toolsetHash } : {}),
    };
  }

  private shouldInvalidateState(
    envelope: OpenRouterStateEnvelope,
    metadata: Pick<SessionMetadata, "model" | "promptHash" | "toolsetHash">,
  ): boolean {
    const stored = envelope.metadata;
    if (!stored) {
      return false;
    }

    if (stored.promptHash !== metadata.promptHash || stored.toolsetHash !== metadata.toolsetHash) {
      return true;
    }

    if (this.invalidateOnModelChange && stored.model !== metadata.model) {
      return true;
    }

    return false;
  }

  private async clearSessionState(sessionId: string, progress?: SessionProgressRecord): Promise<void> {
    await this.stateStore?.clear?.(sessionId);
    (progress ?? this.getSessionProgress(sessionId)).syncedExternalMessageCount = 0;
  }

  private getSessionProgress(sessionId: string): SessionProgressRecord {
    const existing = this.sessionProgress.get(sessionId);
    if (existing) {
      return existing;
    }

    const record: SessionProgressRecord = {
      syncedExternalMessageCount: 0,
    };

    this.sessionProgress.set(sessionId, record);
    return record;
  }
}
