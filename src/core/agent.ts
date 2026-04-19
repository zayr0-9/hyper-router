import type { Message } from "./types.js";
import type { ToolDefinition } from "./tool.js";

export interface AgentDefinition {
  name: string;
  instructions: string;
  model: string;
  tools?: ToolDefinition<any, any>[];
  buildMessages?: (input: string) => Promise<Message[]> | Message[];
}

export function defineAgent(agent: AgentDefinition): AgentDefinition {
  return agent;
}
