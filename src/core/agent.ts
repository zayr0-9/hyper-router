import type { Message } from "./types.js";
import type { AnyToolDefinition } from "./tool.js";

export interface AgentDefinition {
  name: string;
  instructions: string;
  model: string;
  tools?: AnyToolDefinition[];
  buildMessages?: (input: string) => Promise<Message[]> | Message[];
}

export function defineAgent(agent: AgentDefinition): AgentDefinition {
  return agent;
}
