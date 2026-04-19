import type { AgentContext, ToolResult } from "./types.js";

export interface ToolDefinition<TArgs = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema?: unknown;
  execute: (args: TArgs, context: AgentContext) => Promise<ToolResult<TOutput>>;
}

export function defineTool<TArgs = unknown, TOutput = unknown>(
  tool: ToolDefinition<TArgs, TOutput>,
): ToolDefinition<TArgs, TOutput> {
  return tool;
}
