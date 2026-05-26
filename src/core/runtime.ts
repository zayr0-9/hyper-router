import { createHash } from "node:crypto";

import type { AgentDefinition } from "./agent.js";
import type { ModelProvider } from "./providers.js";
import type { SessionMetadata, StorageAdapter } from "./storage.js";
import type {
  AgentRunInput,
  GeneratedImage,
  Message,
  RunStatus,
  StopReason,
  ToolCall,
  ToolResult,
} from "./types.js";

export interface RuntimeConfig {
  agent: AgentDefinition;
  provider: ModelProvider;
  storage: StorageAdapter;
}

export interface RuntimeResult {
  status: RunStatus;
  stopReason?: StopReason;
  providerStopReason?: string;
  messages: Message[];
  generatedImages?: GeneratedImage[];
}

export class AgentRuntime {
  constructor(private readonly config: RuntimeConfig) {}

  async run(input: AgentRunInput): Promise<RuntimeResult> {
    const maxSteps = input.maxSteps ?? 5;
    const isEphemeral = input.ephemeral ?? false;
    const previousMessages = isEphemeral
      ? []
      : (await this.config.storage.loadMessages(input.sessionId)).filter(
          (message) => message.role !== "system",
        );
    const previousSessionMetadata = isEphemeral
      ? null
      : this.config.storage.getSessionMetadata
        ? await this.config.storage.getSessionMetadata(input.sessionId)
        : null;
    const currentSessionMetadata = isEphemeral
      ? null
      : this.buildSessionMetadata(previousSessionMetadata);

    const baseMessages: Message[] = this.config.agent.buildMessages
      ? await this.config.agent.buildMessages(input.input)
      : [{ role: "user", content: input.input, date: new Date() }];
    // Ensure the system instructions are always the first message, followed by previous messages and then the new user input
    const messages: Message[] = [
      { role: "system", content: this.config.agent.instructions, date: new Date() },
      ...previousMessages,
      ...baseMessages,
    ];

    let status: RunStatus = "max_steps_reached";
    let stopReason: StopReason | undefined;
    let providerStopReason: string | undefined;
    const generatedImages: GeneratedImage[] = [];

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        const response = await this.config.provider.generate({
          sessionId: input.sessionId,
          model: this.config.agent.model,
          messages,
          tools: this.config.agent.tools ?? [],
          previousSessionMetadata: currentSessionMetadata,
          ephemeral: isEphemeral,
        });

        stopReason = response.stopReason;
        providerStopReason = response.providerStopReason;

        const toolCalls = this.canonicalizeToolCallIds(response.toolCalls ?? [], step);

        if (response.message) {
          messages.push(this.withCanonicalToolCallIds(response.message, toolCalls, step));
        } else if (toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: "",
            date: new Date(),
            toolCalls,
          });
        }

        if (response.generatedImages?.length) {
          generatedImages.push(...response.generatedImages);
        }

        if (toolCalls.length === 0) {
          status = "completed";
          break;
        }

        const toolMessages = await this.executeToolCalls(input.sessionId, step, toolCalls);
        messages.push(...toolMessages);
        status = "needs_tool";

        if (step === maxSteps) {
          status = "max_steps_reached";
          break;
        }
      }
    } catch (error) {
      status = "failed";

      if (!isEphemeral) {
        await this.persistRunState(input.sessionId, status, messages, currentSessionMetadata);
      }

      throw error;
    }

    if (!isEphemeral) {
      await this.persistRunState(input.sessionId, status, messages, currentSessionMetadata);
    }

    return {
      status,
      ...(stopReason ? { stopReason } : {}),
      ...(providerStopReason ? { providerStopReason } : {}),
      messages,
      ...(generatedImages.length > 0 ? { generatedImages } : {}),
    };
  }

  private async persistRunState(
    sessionId: string,
    status: RunStatus,
    messages: Message[],
    metadata: SessionMetadata | null,
  ): Promise<void> {
    const transcriptMessages = messages.filter((message) => message.role !== "system");

    await this.config.storage.saveMessages(sessionId, transcriptMessages);
    await this.config.storage.saveRun({
      sessionId,
      status,
    });
    await this.updateSessionMetadata(sessionId, metadata);
  }

  private async updateSessionMetadata(
    sessionId: string,
    metadata: SessionMetadata | null,
  ): Promise<void> {
    if (!this.config.storage.setSessionMetadata || !metadata) {
      return;
    }

    await this.config.storage.setSessionMetadata(sessionId, {
      ...metadata,
      updatedAt: new Date().toISOString(),
    });
  }

  private buildSessionMetadata(existingMetadata: SessionMetadata | null): SessionMetadata {
    return {
      ...existingMetadata,
      agentName: this.config.agent.name,
      model: this.config.agent.model,
      promptHash: this.hashValue(this.config.agent.instructions),
      promptSnapshot: this.config.agent.instructions,
      toolsetHash: this.hashValue(
        JSON.stringify(
          (this.config.agent.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? null,
          })),
        ),
      ),
      updatedAt: new Date().toISOString(),
    };
  }

  private hashValue(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private withCanonicalToolCallIds(
    message: Message,
    canonicalToolCalls: ToolCall[],
    step: number,
  ): Message {
    if (!message.toolCalls?.length) {
      return canonicalToolCalls.length > 0
        ? {
            ...message,
            toolCalls: canonicalToolCalls,
          }
        : message;
    }

    if (message.toolCalls.length === canonicalToolCalls.length) {
      return {
        ...message,
        toolCalls: message.toolCalls.map((toolCall, index) => ({
          ...toolCall,
          id: canonicalToolCalls[index]?.id ?? this.createToolCallId(toolCall, step, index),
        })),
      };
    }

    return {
      ...message,
      toolCalls: this.canonicalizeToolCallIds(message.toolCalls, step),
    };
  }

  private canonicalizeToolCallIds(toolCalls: ToolCall[], step: number): ToolCall[] {
    return toolCalls.map((toolCall, index) => ({
      ...toolCall,
      id: toolCall.id ?? this.createToolCallId(toolCall, step, index),
    }));
  }

  private createToolCallId(toolCall: ToolCall, step: number, index: number): string {
    return `${toolCall.toolName}-${step}-${index}`;
  }

  private async executeToolCalls(
    sessionId: string,
    step: number,
    toolCalls: ToolCall[],
  ): Promise<Message[]> {
    const tools = new Map((this.config.agent.tools ?? []).map((tool) => [tool.name, tool]));
    const messages: Message[] = [];

    for (const [index, toolCall] of toolCalls.entries()) {
      const toolCallId = toolCall.id ?? this.createToolCallId(toolCall, step, index);
      const tool = tools.get(toolCall.toolName);

      let result: ToolResult;
      if (!tool) {
        result = {
          ok: false,
          error: `Unknown tool: ${toolCall.toolName}`,
        };
      } else {
        try {
          result = await tool.execute(toolCall.args, { sessionId, step });
        } catch (error) {
          result = {
            ok: false,
            error: this.formatError(error),
          };
        }
      }

      messages.push({
        role: "tool",
        name: toolCall.toolName,
        content: JSON.stringify(result),
        date: new Date(),
        toolCallId,
      });
    }

    return messages;
  }
}

export function createRuntime(config: RuntimeConfig): AgentRuntime {
  return new AgentRuntime(config);
}
