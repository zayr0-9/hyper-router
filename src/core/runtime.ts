import { createHash, randomUUID } from "node:crypto";

import type { AgentDefinition } from "./agent.js";
import type { ModelProvider } from "./providers.js";
import type { SessionMetadata, StorageAdapter } from "./storage.js";
import type { AnyToolDefinition, ToolPermissionMode } from "./tool.js";
import type {
  AgentRunInput,
  GeneratedImage,
  Message,
  RunStatus,
  StopReason,
  ToolCall,
  ToolCallFinishEvent,
  ToolCallStartEvent,
  ToolPermissionDecision,
  ToolPermissionRequest,
  ToolResult,
} from "./types.js";

export interface RuntimeHooks {
  requestToolPermission?: (
    request: ToolPermissionRequest,
  ) => Promise<ToolPermissionDecision> | ToolPermissionDecision;
  onToolPermissionRequested?: (request: ToolPermissionRequest) => Promise<void> | void;
  onToolPermissionResolved?: (
    request: ToolPermissionRequest,
    decision: ToolPermissionDecision,
  ) => Promise<void> | void;
  onToolCallStart?: (event: ToolCallStartEvent) => Promise<void> | void;
  onToolCallFinish?: (event: ToolCallFinishEvent) => Promise<void> | void;
}

export interface RuntimeToolPermissionConfig {
  defaultMode?: ToolPermissionMode;
}

export interface RuntimeConfig {
  agent: AgentDefinition;
  provider: ModelProvider;
  storage: StorageAdapter;
  toolPermission?: RuntimeToolPermissionConfig;
  hooks?: RuntimeHooks;
}

export interface RuntimeResult {
  status: RunStatus;
  stopReason?: StopReason;
  providerStopReason?: string;
  messages: Message[];
  generatedImages?: GeneratedImage[];
}

export interface ActiveRunInfo {
  runId: string;
  sessionId: string;
  startedAt: string;
}

interface ActiveRun extends ActiveRunInfo {
  controller: AbortController;
}

export class AgentRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(private readonly config: RuntimeConfig) {}

  cancel(runId: string, reason?: unknown): boolean {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return false;
    }

    activeRun.controller.abort(reason);
    return true;
  }

  cancelAll(reason?: unknown): number {
    let cancelled = 0;
    for (const activeRun of this.activeRuns.values()) {
      if (!activeRun.controller.signal.aborted) {
        activeRun.controller.abort(reason);
        cancelled += 1;
      }
    }

    return cancelled;
  }

  getActiveRuns(): ActiveRunInfo[] {
    return [...this.activeRuns.values()].map(({ runId, sessionId, startedAt }) => ({
      runId,
      sessionId,
      startedAt,
    }));
  }

  async run(input: AgentRunInput): Promise<RuntimeResult> {
    const runId = input.runId ?? randomUUID();
    if (this.activeRuns.has(runId)) {
      throw new Error(`AgentRuntime run is already active: ${runId}`);
    }

    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const startedAt = new Date().toISOString();
    this.activeRuns.set(runId, {
      runId,
      sessionId: input.sessionId,
      startedAt,
      controller,
    });

    const maxSteps = input.maxSteps ?? 5;
    const isEphemeral = input.ephemeral ?? false;
    let currentSessionMetadata: SessionMetadata | null = null;
    let messages: Message[] = [];
    let status: RunStatus = "max_steps_reached";
    let stopReason: StopReason | undefined;
    let providerStopReason: string | undefined;
    const generatedImages: GeneratedImage[] = [];

    try {
      this.throwIfAborted(signal);

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
      currentSessionMetadata = isEphemeral
        ? null
        : this.buildSessionMetadata(previousSessionMetadata);

      this.throwIfAborted(signal);

      const baseMessages: Message[] = this.config.agent.buildMessages
        ? await this.config.agent.buildMessages(input.input)
        : [{ role: "user", content: input.input, date: new Date() }];
      // Ensure the system instructions are always the first message, followed by previous messages and then the new user input
      messages = [
        { role: "system", content: this.config.agent.instructions, date: new Date() },
        ...previousMessages,
        ...baseMessages,
      ];

      this.throwIfAborted(signal);

      for (let step = 1; step <= maxSteps; step += 1) {
        this.throwIfAborted(signal);
        const response = await this.config.provider.generate({
          sessionId: input.sessionId,
          runId,
          model: this.config.agent.model,
          messages,
          tools: this.config.agent.tools ?? [],
          previousSessionMetadata: currentSessionMetadata,
          ephemeral: isEphemeral,
          signal,
        });
        this.throwIfAborted(signal);

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

        const toolMessages = await this.executeToolCalls(input.sessionId, runId, signal, step, toolCalls);
        messages.push(...toolMessages);
        status = "needs_tool";

        if (step === maxSteps) {
          status = "max_steps_reached";
          break;
        }
      }
    } catch (error) {
      if (this.isAbortError(error) || signal.aborted) {
        status = "cancelled";
        stopReason = "cancelled";

        if (!isEphemeral) {
          await this.persistRunState(input.sessionId, status, messages, currentSessionMetadata);
        }

        return {
          status,
          stopReason,
          messages,
          ...(generatedImages.length > 0 ? { generatedImages } : {}),
        };
      }

      status = "failed";

      if (!isEphemeral) {
        await this.persistRunState(input.sessionId, status, messages, currentSessionMetadata);
      }

      throw error;
    } finally {
      this.activeRuns.delete(runId);
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
            permission: tool.permission ?? null,
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

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
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
    runId: string,
    signal: AbortSignal,
    step: number,
    toolCalls: ToolCall[],
  ): Promise<Message[]> {
    const tools = new Map((this.config.agent.tools ?? []).map((tool) => [tool.name, tool]));
    const messages: Message[] = [];

    for (const [index, toolCall] of toolCalls.entries()) {
      this.throwIfAborted(signal);
      const toolCallId = toolCall.id ?? this.createToolCallId(toolCall, step, index);
      const tool = tools.get(toolCall.toolName);
      const lifecycleBase = {
        sessionId,
        step,
        toolCallId,
        toolName: toolCall.toolName,
        args: toolCall.args,
      };

      let result: ToolResult;
      if (!tool) {
        result = {
          ok: false,
          error: `Unknown tool: ${toolCall.toolName}`,
        };
        await this.config.hooks?.onToolCallFinish?.({
          ...lifecycleBase,
          status: "unknown_tool",
          result,
          finishedAt: new Date().toISOString(),
        });
      } else {
        const permission = await this.resolveToolPermission({
          sessionId,
          step,
          toolCall,
          toolCallId,
          tool,
          signal,
        });

        if (permission.type === "deny") {
          result = {
            ok: false,
            error: permission.reason
              ? `Permission denied: ${permission.reason}`
              : `Permission denied for tool: ${toolCall.toolName}`,
          };
          await this.config.hooks?.onToolCallFinish?.({
            ...lifecycleBase,
            status: "denied",
            result,
            finishedAt: new Date().toISOString(),
          });
        } else {
          const startedAtMs = Date.now();
          const startedAt = new Date(startedAtMs).toISOString();

          await this.config.hooks?.onToolCallStart?.({
            ...lifecycleBase,
            status: "running",
            startedAt,
          });

          try {
            this.throwIfAborted(signal);
            result = await tool.execute(toolCall.args, { sessionId, step, runId, signal });
            this.throwIfAborted(signal);
          } catch (error) {
            result = {
              ok: false,
              error: this.formatError(error),
            };
          }

          const finishedAtMs = Date.now();
          await this.config.hooks?.onToolCallFinish?.({
            ...lifecycleBase,
            status: result.ok ? "completed" : "failed",
            result,
            startedAt,
            finishedAt: new Date(finishedAtMs).toISOString(),
            durationMs: finishedAtMs - startedAtMs,
          });
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

  private async resolveToolPermission(input: {
    sessionId: string;
    step: number;
    toolCall: ToolCall;
    toolCallId: string;
    tool: AnyToolDefinition;
    signal: AbortSignal;
  }): Promise<ToolPermissionDecision> {
    const mode = input.tool.permission?.mode ?? this.config.toolPermission?.defaultMode ?? "always";

    if (mode === "always") {
      return { type: "allow" };
    }

    if (mode === "never") {
      return {
        type: "deny",
        ...(input.tool.permission?.reason ? { reason: input.tool.permission.reason } : {}),
      };
    }

    this.throwIfAborted(input.signal);

    const request: ToolPermissionRequest = {
      id: `permission-${input.toolCallId}`,
      sessionId: input.sessionId,
      step: input.step,
      toolCallId: input.toolCallId,
      toolName: input.toolCall.toolName,
      args: input.toolCall.args,
      description: input.tool.description,
      ...(input.tool.inputSchema !== undefined ? { inputSchema: input.tool.inputSchema } : {}),
      ...(input.tool.permission?.metadata ? { metadata: input.tool.permission.metadata } : {}),
    };

    await this.config.hooks?.onToolPermissionRequested?.(request);
    this.throwIfAborted(input.signal);

    const decision = this.config.hooks?.requestToolPermission
      ? await this.config.hooks.requestToolPermission(request)
      : {
          type: "deny" as const,
          reason: "Tool requires permission but no permission hook is configured.",
        };

    this.throwIfAborted(input.signal);
    await this.config.hooks?.onToolPermissionResolved?.(request, decision);
    return decision;
  }
}

export function createRuntime(config: RuntimeConfig): AgentRuntime {
  return new AgentRuntime(config);
}
