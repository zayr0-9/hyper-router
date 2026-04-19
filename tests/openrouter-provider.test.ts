import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import type { Message } from "../src/core/types.js";
import type { ToolDefinition } from "../src/core/tool.js";
import { toInputItems } from "../src/providers/openrouter/items.js";
import { OpenRouterProvider } from "../src/providers/openrouter/index.js";
import { toToolOutputValue } from "../src/providers/openrouter/tool-output.js";
import type { OpenRouterClientLike } from "../src/providers/openrouter/types.js";

function createMessages(): Message[] {
  return [
    {
      role: "system",
      content: "You are helpful.",
      date: new Date("2025-01-01T00:00:00.000Z"),
    },
    {
      role: "user",
      content: "Hello",
      date: new Date("2025-01-01T00:00:01.000Z"),
    },
    {
      role: "tool",
      name: "echo",
      content: '{"ok":true,"output":{"echoed":"hello"}}',
      toolCallId: "call_echo",
      date: new Date("2025-01-01T00:00:02.000Z"),
    },
  ];
}

function createEchoTool(): ToolDefinition<{ text: string }, { echoed: string }> {
  return {
    name: "echo",
    description: "Echoes text",
    inputSchema: z.object({
      text: z.string(),
    }),
    execute: vi.fn(async (args) => ({
      ok: true,
      output: {
        echoed: args.text,
      },
    })),
  };
}

type MockCallModelResult = {
  getText: () => Promise<string>;
  getToolCalls: () => Promise<unknown[]>;
};

type MockStateAccessor = {
  load: () => Promise<{ messages?: unknown } | null>;
  save?: (state: unknown) => Promise<void>;
};

type MockCallModelRequest = {
  input?: unknown;
  state?: MockStateAccessor;
};

class TestProvider extends OpenRouterProvider {
  public exposeSchema(inputSchema: unknown) {
    return this.toZodInputSchema(inputSchema);
  }
}

function createMockClient(
  implementation?: (request: MockCallModelRequest) => MockCallModelResult,
): OpenRouterClientLike {
  return {
    callModel: vi.fn(
      implementation ??
        (() => ({
          getText: async () => "",
          getToolCalls: async () => [],
        })),
    ) as unknown as OpenRouterClientLike["callModel"],
  };
}

describe("OpenRouterProvider", () => {
  it("throws when no api key or client is provided", () => {
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    try {
      expect(() => new OpenRouterProvider()).toThrowError(
        "OpenRouterProvider: missing API key. Set OPENROUTER_API_KEY or pass { apiKey }.",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previous;
      }
    }
  });

  it("maps internal messages into OpenRouter input items", () => {
    const items = toInputItems(createMessages());

    expect(items[0]).toEqual({
      id: "system-1735689600000-0",
      type: "message",
      role: "system",
      content: [
        {
          type: "input_text",
          text: "You are helpful.",
        },
      ],
    });
    expect(items[1]).toEqual({
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Hello",
        },
      ],
    });
    expect(items[2]).toEqual({
      type: "function_call_output",
      callId: "call_echo",
      output: JSON.stringify({ echoed: "hello" }),
    });
  });

  it("emits assistant tool calls as function_call items", () => {
    const items = toInputItems([
      {
        role: "assistant",
        content: "I should call a tool.",
        date: new Date("2025-01-01T00:00:00.000Z"),
        toolCalls: [
          {
            id: "call_123",
            toolName: "echo",
            args: { text: "hello" },
          },
        ],
      },
    ]);

    expect(items).toEqual([
      {
        type: "function_call",
        callId: "call_123",
        name: "echo",
        arguments: JSON.stringify({ text: "hello" }),
      },
    ]);
  });

  it("converts zod object schemas for tool definitions", () => {
    const provider = new TestProvider({
      client: createMockClient(),
    });

    const schema = z.object({ text: z.string() });
    const converted = provider.exposeSchema(schema);

    expect(converted).toBe(schema);
    expect(converted.safeParse({ text: "hello" }).success).toBe(true);
  });

  it("falls back to a permissive object schema when no input schema is provided", () => {
    const provider = new TestProvider({
      client: createMockClient(),
    });

    const converted = provider.exposeSchema(undefined);
    const parsed = converted.safeParse({ anything: 123, nested: { ok: true } });

    expect(parsed.success).toBe(true);
  });

  it("unwraps successful tool result payloads", () => {
    expect(toToolOutputValue(JSON.stringify({ ok: true, output: { echoed: "hello" } }))).toBe(
      JSON.stringify({ echoed: "hello" }),
    );
  });

  it("converts failed tool results into error payloads", () => {
    expect(toToolOutputValue(JSON.stringify({ ok: false, error: "boom" }))).toBe(
      JSON.stringify({ error: "boom" }),
    );
  });

  it("normalizes text and tool calls into ModelResponse", async () => {
    const getText = vi.fn(async () => "Tool requested.");
    const getToolCalls = vi.fn(async () => [
      {
        name: "echo",
        arguments: { text: "hello" },
      },
    ]);

    const callModel = vi.fn(() => ({
      getText,
      getToolCalls,
    }));

    const provider = new OpenRouterProvider({
      client: {
        callModel,
      } as unknown as OpenRouterClientLike,
    });

    const result = await provider.generate({
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [createEchoTool()],
    });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result.message?.role).toBe("assistant");
    expect(result.message?.content).toBe("Tool requested.");
    expect(result.toolCalls).toEqual([
      {
        toolName: "echo",
        args: { text: "hello" },
      },
    ]);
    expect(result.stopReason).toBe("tool_calls");
  });

  it("handles empty text with no tool calls", async () => {
    const provider = new OpenRouterProvider({
      client: createMockClient(() => ({
        getText: async () => "   ",
        getToolCalls: async () => [],
      })),
    });

    const result = await provider.generate({
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
    });

    expect(result.message).toBeUndefined();
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("completed");
  });

  it("passes state accessor and initial item input for session-backed calls", async () => {
    let capturedRequest: MockCallModelRequest | undefined;

    const provider = new OpenRouterProvider({
      client: createMockClient((request) => {
        capturedRequest = request;
        return {
          getText: async () => "I will call a tool.",
          getToolCalls: async () => [
            {
              id: "call_123",
              name: "echo",
              arguments: { text: "hello" },
            },
          ],
        };
      }),
    });

    const result = await provider.generate({
      sessionId: "session-1",
      model: "openai/gpt-5-mini",
      messages: [
        {
          role: "user",
          content: "Call echo with hello",
          date: new Date("2025-01-01T00:00:00.000Z"),
        },
      ],
      tools: [createEchoTool()],
    });

    expect(capturedRequest?.state).toBeDefined();
    expect(capturedRequest?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Call echo with hello",
          },
        ],
      },
    ]);
    expect(result.message?.toolCalls).toEqual([
      {
        id: "call_123",
        toolName: "echo",
        args: { text: "hello" },
      },
    ]);
  });

  it("resumes with stateful item history and only sends incremental external input", async () => {
    const requests: MockCallModelRequest[] = [];

    const provider = new OpenRouterProvider({
      client: createMockClient((request) => {
        requests.push(request);
        return {
          getText: async () => {
            if (requests.length === 1) {
              await request.state?.save?.({
                  id: "session-2",
                  messages: [
                    {
                      role: "user",
                      content: "Start",
                    },
                    {
                      role: "assistant",
                      content: "I will use a tool.",
                    },
                    {
                      type: "function_call",
                      callId: "call_abc",
                      name: "echo",
                      arguments: JSON.stringify({ text: "hello" }),
                    },
                  ],
                  status: "in_progress",
                  createdAt: 0,
                  updatedAt: 0,
                });

              return "I will use a tool.";
            }

            return "done";
          },
          getToolCalls: async () =>
            requests.length === 1
              ? [
                  {
                    id: "call_abc",
                    name: "echo",
                    arguments: { text: "hello" },
                  },
                ]
              : [],
        };
      }),
    });

    await provider.generate({
      sessionId: "session-2",
      model: "openai/gpt-5-mini",
      messages: [
        {
          role: "user",
          content: "Start",
          date: new Date("2025-01-01T00:00:00.000Z"),
        },
      ],
      tools: [createEchoTool()],
    });

    await provider.generate({
      sessionId: "session-2",
      model: "openai/gpt-5-mini",
      messages: [
        {
          role: "user",
          content: "Start",
          date: new Date("2025-01-01T00:00:00.000Z"),
        },
        {
          role: "assistant",
          content: "I will use a tool.",
          date: new Date("2025-01-01T00:00:01.000Z"),
          toolCalls: [
            {
              id: "call_abc",
              toolName: "echo",
              args: { text: "hello" },
            },
          ],
        },
        {
          role: "tool",
          name: "echo",
          content: JSON.stringify({ ok: true, output: { echoed: "hello" } }),
          toolCallId: "call_abc",
          date: new Date("2025-01-01T00:00:02.000Z"),
        },
      ],
      tools: [createEchoTool()],
    });

    expect(requests).toHaveLength(2);
    const firstRequest = requests[0];
    expect(firstRequest).toBeDefined();
    expect(firstRequest?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Start",
          },
        ],
      },
    ]);
    const secondRequest = requests[1];
    expect(secondRequest).toBeDefined();
    expect(secondRequest?.input).toEqual([]);

    expect(secondRequest?.state).toBeDefined();

    const loadedState = await secondRequest?.state?.load();
    expect(Array.isArray(loadedState?.messages)).toBe(true);
    expect(loadedState?.messages).toEqual(
      expect.arrayContaining([
        {
          role: "user",
          content: "Start",
        },
        {
          type: "function_call_output",
          callId: "call_abc",
          output: JSON.stringify({ echoed: "hello" }),
        },
      ]),
    );
  });
});
