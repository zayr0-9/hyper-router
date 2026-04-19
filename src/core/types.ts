export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  name?: string;
  date: Date;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolResult<TOutput = unknown> {
  ok: boolean;
  output?: TOutput;
  error?: string;
}

export interface AgentRunInput {
  sessionId: string;
  input: string;
  maxSteps?: number;
}

export type RunStatus =
  | "completed"
  | "needs_tool"
  | "waiting_for_user"
  | "max_steps_reached"
  | "failed"
  | "waiting_for_permission";

export type PauseReason =
  | "waiting_for_user"
  | "waiting_for_permission"
  | "waiting_for_tool";

export type StopReason =
  | "completed"
  | "max_steps_reached"
  | "provider_error"
  | "tool_failed"
  | "permission_denied";

export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
  
export interface ToolCall {
  id?: string;
  toolName: string;
  args: unknown;
}

export interface ModelResponse {
  message?: Message;
  toolCalls?: ToolCall[];
  stopReason?: string;
}

export interface AgentContext {
  sessionId: string;
  step: number;
}
