import { describe, expect, it, vi } from "vitest";

import { defineAgent } from "../src/core/agent.js";
import type { ModelProvider } from "../src/core/providers.js";
import { createRuntime } from "../src/core/runtime.js";
import { InMemoryStorage } from "../src/core/storage.js";
import { defineTool } from "../src/core/tool.js";
import type { Message, ModelResponse, ToolCall, ToolPermissionRequest } from "../src/core/types.js";

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

describe("AgentRuntime tool permissions", () => {
  it("executes tools without permission metadata by default", async () => {
    const execute = vi.fn(async (args: { text: string }) => ({
      ok: true,
      output: { echoed: args.text },
    }));
    const tool = defineTool<{ text: string }, { echoed: string }>({
      name: "echo",
      description: "Echo text.",
      execute,
    });

    const storage = new InMemoryStorage();
    const result = await createRuntime({
      agent: defineAgent({
        name: "default-permission-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage,
    }).run({
      sessionId: "default-permission-session",
      input: "Echo hello.",
      maxSteps: 2,
    });

    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledWith(
      { text: "hello" },
      expect.objectContaining({
        sessionId: "default-permission-session",
        step: 1,
        runId: expect.any(String),
        signal: expect.any(AbortSignal),
      }),
    );

    const toolMessage = (await storage.loadMessages("default-permission-session")).find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.toolCallId).toBe("call_echo");
    expect(toolMessage?.content).toBe(JSON.stringify({ ok: true, output: { echoed: "hello" } }));
  });

  it("calls the permission hook for ask tools and executes when allowed", async () => {
    const execute = vi.fn(async (args: { text: string }) => ({
      ok: true,
      output: { echoed: args.text },
    }));
    const requestToolPermission = vi.fn(async () => ({ type: "allow" as const }));
    const onToolPermissionRequested = vi.fn();
    const onToolPermissionResolved = vi.fn();

    const tool = defineTool<{ text: string }, { echoed: string }>({
      name: "echo",
      description: "Echo text.",
      inputSchema: { type: "object" },
      permission: { mode: "ask", metadata: { risk: "low" } },
      execute,
    });

    await createRuntime({
      agent: defineAgent({
        name: "ask-permission-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage: new InMemoryStorage(),
      hooks: {
        requestToolPermission,
        onToolPermissionRequested,
        onToolPermissionResolved,
      },
    }).run({
      sessionId: "ask-permission-session",
      input: "Echo hello.",
      maxSteps: 1,
    });

    const expectedRequest: ToolPermissionRequest = {
      id: "permission-call_echo",
      sessionId: "ask-permission-session",
      step: 1,
      toolCallId: "call_echo",
      toolName: "echo",
      args: { text: "hello" },
      description: "Echo text.",
      inputSchema: { type: "object" },
      metadata: { risk: "low" },
    };

    expect(requestToolPermission).toHaveBeenCalledWith(expectedRequest);
    expect(onToolPermissionRequested).toHaveBeenCalledWith(expectedRequest);
    expect(onToolPermissionResolved).toHaveBeenCalledWith(expectedRequest, { type: "allow" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("records a denied tool result and does not execute when the hook denies", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: { shouldNotRun: true } }));
    const tool = defineTool({
      name: "echo",
      description: "Echo text.",
      permission: { mode: "ask" },
      execute,
    });

    const storage = new InMemoryStorage();
    const result = await createRuntime({
      agent: defineAgent({
        name: "deny-permission-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage,
      hooks: {
        requestToolPermission: vi.fn(async () => ({ type: "deny" as const, reason: "not safe" })),
      },
    }).run({
      sessionId: "deny-permission-session",
      input: "Echo hello.",
      maxSteps: 2,
    });

    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();

    const toolMessage = (await storage.loadMessages("deny-permission-session")).find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.toolCallId).toBe("call_echo");
    expect(toolMessage?.content).toBe(JSON.stringify({ ok: false, error: "Permission denied: not safe" }));
  });

  it("denies explicit ask tools safely when no permission hook is configured", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: { shouldNotRun: true } }));
    const tool = defineTool({
      name: "echo",
      description: "Echo text.",
      permission: { mode: "ask" },
      execute,
    });

    const storage = new InMemoryStorage();
    await createRuntime({
      agent: defineAgent({
        name: "missing-hook-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage,
    }).run({
      sessionId: "missing-hook-session",
      input: "Echo hello.",
      maxSteps: 1,
    });

    expect(execute).not.toHaveBeenCalled();
    const toolMessage = (await storage.loadMessages("missing-hook-session")).find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toBe(
      JSON.stringify({
        ok: false,
        error: "Permission denied: Tool requires permission but no permission hook is configured.",
      }),
    );
  });

  it("denies never tools without calling permission hooks or execute", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: { shouldNotRun: true } }));
    const requestToolPermission = vi.fn(async () => ({ type: "allow" as const }));
    const tool = defineTool({
      name: "echo",
      description: "Echo text.",
      permission: { mode: "never", reason: "disabled by policy" },
      execute,
    });

    const storage = new InMemoryStorage();
    await createRuntime({
      agent: defineAgent({
        name: "never-permission-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage,
      hooks: { requestToolPermission },
    }).run({
      sessionId: "never-permission-session",
      input: "Echo hello.",
      maxSteps: 1,
    });

    expect(requestToolPermission).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const toolMessage = (await storage.loadMessages("never-permission-session")).find(
      (message) => message.role === "tool",
    );
    expect(toolMessage?.content).toBe(
      JSON.stringify({ ok: false, error: "Permission denied: disabled by policy" }),
    );
  });

  it("can force all tools through runtime default ask policy", async () => {
    const execute = vi.fn(async () => ({ ok: true, output: { allowed: true } }));
    const requestToolPermission = vi.fn(async () => ({ type: "allow" as const }));
    const tool = defineTool({
      name: "echo",
      description: "Echo text.",
      execute,
    });

    await createRuntime({
      agent: defineAgent({
        name: "global-policy-agent",
        instructions: "Use tools.",
        model: "stub-model",
        tools: [tool],
      }),
      provider: createSingleToolCallProvider(),
      storage: new InMemoryStorage(),
      toolPermission: { defaultMode: "ask" },
      hooks: { requestToolPermission },
    }).run({
      sessionId: "global-policy-session",
      input: "Echo hello.",
      maxSteps: 1,
    });

    expect(requestToolPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "global-policy-session",
        toolCallId: "call_echo",
        toolName: "echo",
      }),
    );
    expect(execute).toHaveBeenCalledOnce();
  });
});
