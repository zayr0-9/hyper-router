import {
  OpenRouter,
  tool as openRouterTool,
} from "@openrouter/agent";
import { z } from "zod/v4";

import type { ModelProvider } from "../../core/providers.js";
import type { SessionMetadata } from "../../core/storage.js";
import type { ToolDefinition } from "../../core/tool.js";
import type { Message, ModelResponse, ToolCall } from "../../core/types.js";
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
  private readonly sessionProgress = new Map<string, SessionProgressRecord>();

  constructor(options: OpenRouterProviderOptions = {}) {
    this.continuationStrategy = options.continuation?.strategy ?? (options.continuation?.stateStore ? "hybrid" : "transcript");
    this.stateStore =
      this.continuationStrategy === "transcript"
        ? undefined
        : (options.continuation?.stateStore ?? new InMemoryOpenRouterStateStore());
    this.invalidateOnModelChange = options.continuation?.invalidateOnModelChange ?? true;

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
    tools: ToolDefinition<any, any>[];
    previousSessionMetadata?: SessionMetadata | null;
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
    const useState = Boolean(sessionId && this.stateStore && this.continuationStrategy !== "transcript");
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
          ? toInputItems(externalMessages)
          : toInputItems(input.messages);

    const callResult = useState && sessionId
      ? this.client.callModel({
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
          model: input.model,
          input: requestInput,
          tools: toolDefs,
        });

    const [text, toolCalls] = await Promise.all([callResult.getText(), callResult.getToolCalls()]);
    const normalizedToolCalls = this.normalizeToolCalls(toolCalls as OpenRouterToolCallLike[]);

    if (useState && sessionId) {
      this.getSessionProgress(sessionId).syncedExternalMessageCount = externalMessages.length;
    }

    const response: ModelResponse = {
      toolCalls: normalizedToolCalls,
      stopReason: normalizedToolCalls.length > 0 ? "tool_calls" : "completed",
    };

    if (text && text.trim().length > 0) {
      response.message = {
        role: "assistant",
        content: text,
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

  protected toZodInputSchema(inputSchema: unknown) {
    if (inputSchema && typeof inputSchema === "object") {
      return inputSchema as z.ZodObject<any>;
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
