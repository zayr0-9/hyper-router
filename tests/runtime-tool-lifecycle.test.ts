import { describe, expect, it, vi } from "vitest";

import { defineAgent } from "../src/core/agent.js";
import type { ModelProvider } from "../src/core/providers.js";
import { createRuntime } from "../src/core/runtime.js";
import { InMemoryStorage } from "../src/core/storage.js";
import { defineTool } from "../src/core/tool.js";
import type { Message, ModelResponse, ToolCall } from "../src/core/types.js";

function createSingleToolCallProvider(toolName = "echo"): ModelProvider {
  return {
    generate: vi.fn(async ({ messages }): Promise<ModelResponse> => {
      const toolResult = messages.find((message: Message) => message.role === "tool");

      if (!toolResult) {
        const toolCalls: ToolCall[] = [
          {
            id: `call_${toolName}`,
            toolName,
            args: { text: "hello" },
          },
        ];

        return {
          message: {
            role: "assistant",
            content: "I will call a tool.",
            date: new Date("2025-01-01T00:00:10.000Z"),
            toolCalls,
          },
          toolCalls,
          stopReason: "tool_calls",
        };
      }

      return {
        message: {
          role: "assistant",
          content: `Tool said: ${toolResult.content}`,
          date: new Date("2025-01-01T00:00:20.000Z"),
        },
        stopReason: "stop",
      };
    }),
  };
}

describe("AgentRuntime tool call lifecycle hooks", () => {
  it("does nothing when lifecycle hooks are omitted", async () => {
    const execute = vi.fn(async (args: { text: string }) => ({
      ok: true,
      output: { echoed: args.text },
    }));
    const tool = defineTool<{ text: string }, { echoed: string }>({
      name: "echo",
      description: "Echo text.",
      execute,
    });

    const result = await createRuntime({
      agent: defineAgent({
        name: "optional-lifecycle-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage: new InMemoryStorage(),
    }).run({
      sessionId: "optional-lifecycle-session",
      input: "Echo hello.",
      maxSteps: 2,
    });

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("emits start and finish around successful tool execution", async () => {
    const events: string[] = [];
    const execute = vi.fn(async (args: { text: string }) => {
      events.push("execute");
      return {
        ok: true,
        output: { echoed: args.text },
      };
    });
    const onToolCallStart = vi.fn(() => {
      events.push("start");
    });
    const onToolCallFinish = vi.fn(() => {
      events.push("finish");
    });
    const tool = defineTool<{ text: string }, { echoed: string }>({
      name: "echo",
      description: "Echo text.",
      execute,
    });

    const storage = new InMemoryStorage();
    const result = await createRuntime({
      agent: defineAgent({
        name: "success-lifecycle-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage,
      hooks: {
        onToolCallStart,
        onToolCallFinish,
      },
    }).run({
      sessionId: "success-lifecycle-session",
      input: "Echo hello.",
      maxSteps: 2,
    });

    expect(result.status).toBe("completed");
    expect(events).toEqual(["start", "execute", "finish"]);
    expect(onToolCallStart).toHaveBeenCalledWith({
      sessionId: "success-lifecycle-session",
      step: 1,
      toolCallId: "call_echo",
      toolName: "echo",
      args: { text: "hello" },
      status: "running",
      startedAt: expect.any(String),
    });
    expect(onToolCallFinish).toHaveBeenCalledWith({
      sessionId: "success-lifecycle-session",
      step: 1,
      toolCallId: "call_echo",
      toolName: "echo",
      args: { text: "hello" },
      status: "completed",
      result: { ok: true, output: { echoed: "hello" } },
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      durationMs: expect.any(Number),
    });

    const toolMessage = (await storage.loadMessages("success-lifecycle-session")).find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toBe(JSON.stringify({ ok: true, output: { echoed: "hello" } }));
  });

  it("emits failed finish when a tool throws", async () => {
    const execute = vi.fn(async () => {
      throw new Error("boom");
    });
    const onToolCallStart = vi.fn();
    const onToolCallFinish = vi.fn();
    const tool = defineTool({
      name: "echo",
      description: "Echo text.",
      execute,
    });

    const storage = new InMemoryStorage();
    await createRuntime({
      agent: defineAgent({
        name: "throw-lifecycle-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage,
      hooks: {
        onToolCallStart,
        onToolCallFinish,
      },
    }).run({
      sessionId: "throw-lifecycle-session",
      input: "Echo hello.",
      maxSteps: 1,
    });

    expect(onToolCallStart).toHaveBeenCalledOnce();
    expect(onToolCallFinish).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "throw-lifecycle-session",
        toolCallId: "call_echo",
        toolName: "echo",
        status: "failed",
        result: { ok: false, error: "boom" },
      }),
    );

    const toolMessage = (await storage.loadMessages("throw-lifecycle-session")).find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toBe(JSON.stringify({ ok: false, error: "boom" }));
  });

  it("emits denied finish without start when permission denies a tool", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: { shouldNotRun: true } }));
    const onToolCallStart = vi.fn();
    const onToolCallFinish = vi.fn();
    const tool = defineTool({
      name: "echo",
      description: "Echo text.",
      permission: { mode: "ask" },
      execute,
    });

    await createRuntime({
      agent: defineAgent({
        name: "denied-lifecycle-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage: new InMemoryStorage(),
      hooks: {
        requestToolPermission: vi.fn(async () => ({ type: "deny" as const, reason: "not safe" })),
        onToolCallStart,
        onToolCallFinish,
      },
    }).run({
      sessionId: "denied-lifecycle-session",
      input: "Echo hello.",
      maxSteps: 1,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(onToolCallStart).not.toHaveBeenCalled();
    expect(onToolCallFinish).toHaveBeenCalledWith({
      sessionId: "denied-lifecycle-session",
      step: 1,
      toolCallId: "call_echo",
      toolName: "echo",
      args: { text: "hello" },
      status: "denied",
      result: { ok: false, error: "Permission denied: not safe" },
      finishedAt: expect.any(String),
    });
  });

  it("emits unknown_tool finish without start for missing tools", async () => {
    const onToolCallStart = vi.fn();
    const onToolCallFinish = vi.fn();

    await createRuntime({
      agent: defineAgent({
        name: "unknown-lifecycle-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [],
      }),
      provider: createSingleToolCallProvider("missing_tool"),
      storage: new InMemoryStorage(),
      hooks: {
        onToolCallStart,
        onToolCallFinish,
      },
    }).run({
      sessionId: "unknown-lifecycle-session",
      input: "Call missing tool.",
      maxSteps: 1,
    });

    expect(onToolCallStart).not.toHaveBeenCalled();
    expect(onToolCallFinish).toHaveBeenCalledWith({
      sessionId: "unknown-lifecycle-session",
      step: 1,
      toolCallId: "call_missing_tool",
      toolName: "missing_tool",
      args: { text: "hello" },
      status: "unknown_tool",
      result: { ok: false, error: "Unknown tool: missing_tool" },
      finishedAt: expect.any(String),
    });
  });
});
