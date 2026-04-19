import type { Message, ModelResponse } from "./types.js";
import type { ToolDefinition } from "./tool.js";

export interface ModelProvider {
  generate(input: {
    sessionId?: string;
    model: string;
    messages: Message[];
    tools: ToolDefinition<any, any>[];
  }): Promise<ModelResponse>;
}

export class StubProvider implements ModelProvider {
  async generate(input: {
    sessionId?: string;
    model: string;
    messages: Message[];
    tools: ToolDefinition<any, any>[];
  }): Promise<ModelResponse> {
    const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");

    return {
      message: {
        role: "assistant",
        content: `Stub response from ${input.model}: ${lastUserMessage?.content ?? ""}`,
        date: new Date(),
      },
      stopReason: "completed",
    };
  }
}
