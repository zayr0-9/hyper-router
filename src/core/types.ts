export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  reasoningContent?: string;
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
  ephemeral?: boolean;
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
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "refusal"
  | "provider_error"
  | "unknown";

export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningOptions =
  | false
  | {
      enabled?: boolean;
      effort?: ReasoningEffort;
      budgetTokens?: number;
      /** Whether to extract returned reasoning into assistant messages. Defaults to true. */
      capture?: boolean;
      /** Whether to send prior assistant reasoning back to providers. Defaults to true. */
      includeInMessages?: boolean;
    };
  
export interface ToolCall {
  id?: string;
  toolName: string;
  args: unknown;
}

export interface GeneratedImage {
  dataUrl?: string;
  url?: string;
  mimeType?: string;
}

export interface ModelResponse {
  message?: Message;
  toolCalls?: ToolCall[];
  stopReason?: StopReason;
  providerStopReason?: string;
  generatedImages?: GeneratedImage[];
}

export interface AgentContext {
  sessionId: string;
  step: number;
}
