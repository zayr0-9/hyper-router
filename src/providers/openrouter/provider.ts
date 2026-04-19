import {
  OpenRouter,
  tool as openRouterTool,
} from "@openrouter/agent";
import { z } from "zod/v4";

import type { ModelProvider } from "../../core/providers.js";
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
  OpenRouterInputItem,
  OpenRouterProviderOptions,
  OpenRouterToolCallLike,
  SessionStateRecord,
} from "./types.js";

export class OpenRouterProvider implements ModelProvider {
  private readonly client: OpenRouterClientLike;
  private readonly sessions = new Map<string, SessionStateRecord>();

  constructor(options: OpenRouterProviderOptions = {}) {
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
    const sessionRecord = sessionId ? this.getSessionRecord(sessionId) : undefined;

    if (sessionRecord && getExternalMessages(input.messages).length < sessionRecord.syncedExternalMessageCount) {
      sessionRecord.state = null;
      sessionRecord.syncedExternalMessageCount = 0;
    }

    const hasExistingState = Boolean(sessionRecord?.state);

    if (sessionRecord?.state) {
      syncExternalMessagesIntoState(sessionRecord, input.messages);
    }

    const requestInput: OpenRouterInputItem[] = hasExistingState ? [] : toInputItems(input.messages);

    const callResult = sessionId
      ? this.client.callModel({
          model: input.model,
          input: requestInput,
          tools: toolDefs,
          state: createStateAccessor<typeof toolDefs>(sessionRecord!),
        })
      : this.client.callModel({
          model: input.model,
          input: requestInput,
          tools: toolDefs,
        });

    const [text, toolCalls] = await Promise.all([callResult.getText(), callResult.getToolCalls()]);
    const normalizedToolCalls = this.normalizeToolCalls(toolCalls as OpenRouterToolCallLike[]);

    if (sessionRecord) {
      sessionRecord.syncedExternalMessageCount = getExternalMessages(input.messages).length;
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

  private getSessionRecord(sessionId: string): SessionStateRecord {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const record: SessionStateRecord = {
      state: null,
      syncedExternalMessageCount: 0,
    };

    this.sessions.set(sessionId, record);
    return record;
  }
}
