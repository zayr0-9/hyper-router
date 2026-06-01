import type { AgentContext, ToolResult } from "./types.js";

export type ToolPermissionMode = "always" | "ask" | "never";

export interface ToolPermissionPolicy {
  mode: ToolPermissionMode;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition<TArgs = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema?: unknown;
  permission?: ToolPermissionPolicy;
  execute: (args: TArgs, context: AgentContext) => Promise<ToolResult<TOutput>>;
}

export type AnyToolDefinition = ToolDefinition<any, unknown>;

export function defineTool<TArgs = unknown, TOutput = unknown>(
  tool: ToolDefinition<TArgs, TOutput>,
): ToolDefinition<TArgs, TOutput> {
  return tool;
}
