import type { AgentDefinition } from "./agent.js";
import type { ModelProvider } from "./providers.js";
import type { StorageAdapter } from "./storage.js";
import type { AgentRunInput, Message, RunStatus, ToolCall, ToolResult } from "./types.js";

export interface RuntimeConfig {
  agent: AgentDefinition;
  provider: ModelProvider;
  storage: StorageAdapter;
}

export interface RuntimeResult {
  status: RunStatus;
  messages: Message[];
}

export class AgentRuntime {
  constructor(private readonly config: RuntimeConfig) {}

  async run(input: AgentRunInput): Promise<RuntimeResult> {
    const maxSteps = input.maxSteps ?? 5;
    const previousMessages = await this.config.storage.loadMessages(input.sessionId);

    const baseMessages: Message[] = this.config.agent.buildMessages
      ? await this.config.agent.buildMessages(input.input)
      : [{ role: "user", content: input.input, date: new Date() }];

    const messages: Message[] = [
      { role: "system", content: this.config.agent.instructions, date: new Date() },
      ...previousMessages,
      ...baseMessages,
    ];

    let status: RunStatus = "max_steps_reached";

    for (let step = 1; step <= maxSteps; step += 1) {
      const response = await this.config.provider.generate({
        sessionId: input.sessionId,
        model: this.config.agent.model,
        messages,
        tools: this.config.agent.tools ?? [],
      });

      if (response.message) {
        messages.push(response.message);
      }

      const toolCalls = response.toolCalls ?? [];
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

    await this.config.storage.saveMessages(input.sessionId, messages);
    await this.config.storage.saveRun({
      sessionId: input.sessionId,
      status,
      messages,
    });

    return { status, messages };
  }

  private async executeToolCalls(
    sessionId: string,
    step: number,
    toolCalls: ToolCall[],
  ): Promise<Message[]> {
    const tools = new Map((this.config.agent.tools ?? []).map((tool) => [tool.name, tool]));
    const messages: Message[] = [];

    for (const toolCall of toolCalls) {
      const tool = tools.get(toolCall.toolName);

      let result: ToolResult;
      if (!tool) {
        result = {
          ok: false,
          error: `Unknown tool: ${toolCall.toolName}`,
        };
      } else {
        result = await tool.execute(toolCall.args, { sessionId, step });
      }

      messages.push({
        role: "tool",
        name: toolCall.toolName,
        content: JSON.stringify(result),
        date: new Date(),
        ...(toolCall.id ? { toolCallId: toolCall.id } : {}),
      });
    }

    return messages;
  }
}

export function createRuntime(config: RuntimeConfig): AgentRuntime {
  return new AgentRuntime(config);
}
