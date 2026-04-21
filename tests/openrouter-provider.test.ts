import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import type { SessionMetadata } from "../src/core/storage.js";
import type { Message } from "../src/core/types.js";
import type { ToolDefinition } from "../src/core/tool.js";
import { toInputItems } from "../src/providers/openrouter/items.js";
import { OpenRouterProvider } from "../src/providers/openrouter/index.js";
import type { OpenRouterClientLike, OpenRouterStateStore } from "../src/providers/openrouter/types.js";

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
  getResponse: () => Promise<{ output: Array<{ type: string; result?: string | null }> }>;
};

type MockStateAccessor = {
  load: () => Promise<{ messages?: unknown } | null>;
  save?: (state: unknown) => Promise<void>;
};

function createMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    model: "openai/gpt-5-mini",
    promptHash: "prompt-hash-1",
    toolsetHash: "toolset-hash-1",
    ...overrides,
  };
}

function createMemoryStateStore(): OpenRouterStateStore {
  const store = new Map<string, Awaited<ReturnType<OpenRouterStateStore["load"]>>>();

  return {
    load: vi.fn(async (sessionId: string) => store.get(sessionId) ?? null),
    save: vi.fn(async (sessionId: string, envelope) => {
      store.set(sessionId, JSON.parse(JSON.stringify(envelope)) as typeof envelope);
    }),
    clear: vi.fn(async (sessionId: string) => {
      store.delete(sessionId);
    }),
  };
}

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
          getResponse: async () => ({ output: [] }),
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
      output: '{"ok":true,"output":{"echoed":"hello"}}',
    });
  });

  it("preserves assistant text alongside tool calls", () => {
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
        id: "assistant-1735689600000-0",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "I should call a tool.",
            annotations: [],
          },
        ],
      },
      {
        type: "function_call",
        callId: "call_123",
        name: "echo",
        arguments: JSON.stringify({ text: "hello" }),
      },
    ]);
  });

  it("emits assistant text-only messages as assistant items", () => {
    const items = toInputItems([
      {
        role: "assistant",
        content: "Done.",
        date: new Date("2025-01-01T00:00:03.000Z"),
      },
    ]);

    expect(items).toEqual([
      {
        id: "assistant-1735689603000-0",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Done.",
            annotations: [],
          },
        ],
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

  it("rejects JSON Schema tool definitions with a clear error", () => {
    const provider = new TestProvider({
      client: createMockClient(),
    });

    expect(() =>
      provider.exposeSchema({
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      }),
    ).toThrowError(
      "OpenRouterProvider requires a Zod tool schema. JSON Schema was provided. Use z.object(...) for this provider.",
    );
  });

  it("rejects invalid tool schemas early", () => {
    const provider = new TestProvider({
      client: createMockClient(),
    });

    expect(() => provider.exposeSchema({ nope: true })).toThrowError(
      "Invalid tool inputSchema: expected Zod schema, JSON Schema object, or undefined.",
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

    const getResponse = vi.fn(async () => ({
      output: [],
    }));

    const callModel = vi.fn(() => ({
      getText,
      getToolCalls,
      getResponse,
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
      previousSessionMetadata: null,
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

  it("exposes generated images on ModelResponse", async () => {
    const provider = new OpenRouterProvider({
      client: createMockClient(() => ({
        getText: async () => "Here is your image.",
        getToolCalls: async () => [],
        getResponse: async () => ({
          output: [
            {
              type: "image_generation_call",
              result: "data:image/png;base64,abc123",
            },
          ],
        }),
      })),
    });

    const result = await provider.generate({
      model: "google/gemini-2.5-flash-image",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: null,
    });

    expect(result.generatedImages).toEqual([
      {
        dataUrl: "data:image/png;base64,abc123",
        mimeType: "image/png",
      },
    ]);
  });

  it("handles empty text with no tool calls", async () => {
    const provider = new OpenRouterProvider({
      client: createMockClient(() => ({
        getText: async () => "   ",
        getToolCalls: async () => [],
        getResponse: async () => ({ output: [] }),
      })),
    });

    const result = await provider.generate({
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: null,
    });

    expect(result.message).toBeUndefined();
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("completed");
  });

  it("uses StateAccessor for session-backed calls in hybrid mode", async () => {
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
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: {
        strategy: "hybrid",
      },
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
      previousSessionMetadata: createMetadata(),
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

  it("defaults to transcript mode and skips StateAccessor", async () => {
    let capturedRequest: MockCallModelRequest | undefined;

    const provider = new OpenRouterProvider({
      client: createMockClient((request) => {
        capturedRequest = request;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
    });

    await provider.generate({
      sessionId: "session-transcript",
      model: "openai/gpt-5-mini",
      messages: [
        {
          role: "user",
          content: "Hello",
          date: new Date("2025-01-01T00:00:00.000Z"),
        },
      ],
      tools: [],
      previousSessionMetadata: createMetadata(),
    });

    expect(capturedRequest?.state).toBeUndefined();
    expect(capturedRequest?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Hello",
          },
        ],
      },
    ]);
  });

  it("resumes with stateful item history and only sends incremental external input in state mode", async () => {
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
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: {
        strategy: "state",
      },
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
      previousSessionMetadata: createMetadata(),
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
      previousSessionMetadata: createMetadata(),
    });

    expect(requests).toHaveLength(2);
    const firstRequest = requests[0];
    expect(firstRequest).toBeDefined();
    expect(firstRequest?.state).toBeDefined();
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
          role: "assistant",
          content: "I will use a tool.",
        },
        {
          type: "function_call_output",
          callId: "call_abc",
          output: JSON.stringify({ ok: true, output: { echoed: "hello" } }),
        },
      ]),
    );
  });
});

  it("invalidates native state when prompt hash changes in hybrid mode", async () => {
    const stateStore = createMemoryStateStore();
    await stateStore.save("session-invalidated", {
      state: {
        id: "session-invalidated",
        messages: [
          {
            role: "user",
            content: "Old state",
          },
        ],
        status: "complete",
        createdAt: 0,
        updatedAt: 0,
      },
      metadata: {
        model: "openai/gpt-5-mini",
        promptHash: "old-prompt",
        toolsetHash: "toolset-hash-1",
      },
    });

    let capturedRequest: MockCallModelRequest | undefined;
    const provider = new OpenRouterProvider({
      client: createMockClient((request) => {
        capturedRequest = request;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: {
        strategy: "hybrid",
        stateStore,
      },
    });

    await provider.generate({
      sessionId: "session-invalidated",
      model: "openai/gpt-5-mini",
      messages: [
        {
          role: "system",
          content: "You are helpful.",
          date: new Date("2025-01-01T00:00:00.000Z"),
        },
        {
          role: "user",
          content: "New input",
          date: new Date("2025-01-01T00:00:01.000Z"),
        },
      ],
      tools: [],
      previousSessionMetadata: createMetadata({ promptHash: "new-prompt" }),
    });

    expect(stateStore.clear).toHaveBeenCalledWith("session-invalidated");
    expect(capturedRequest?.input).toEqual([
      {
        id: "system-1735689600000-0",
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: "You are helpful.",
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "New input",
          },
        ],
      },
    ]);
  });

  it("optionally keeps native state across model changes", async () => {
    const stateStore = createMemoryStateStore();
    await stateStore.save("session-model-lenient", {
      state: {
        id: "session-model-lenient",
        messages: [
          {
            role: "user",
            content: "Start",
          },
        ],
        status: "in_progress",
        createdAt: 0,
        updatedAt: 0,
      },
      metadata: {
        model: "openai/gpt-5-mini",
        promptHash: "prompt-hash-1",
        toolsetHash: "toolset-hash-1",
      },
    });

    let capturedRequest: MockCallModelRequest | undefined;
    const provider = new OpenRouterProvider({
      client: createMockClient((request) => {
        capturedRequest = request;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: {
        strategy: "hybrid",
        stateStore,
        invalidateOnModelChange: false,
      },
    });

    await provider.generate({
      sessionId: "session-model-lenient",
      model: "anthropic/claude-3.5-sonnet",
      messages: [
        {
          role: "system",
          content: "You are helpful.",
          date: new Date("2025-01-01T00:00:00.000Z"),
        },
        {
          role: "user",
          content: "Follow up",
          date: new Date("2025-01-01T00:00:01.000Z"),
        },
      ],
      tools: [],
      previousSessionMetadata: createMetadata({
        model: "anthropic/claude-3.5-sonnet",
      }),
    });

    expect(stateStore.clear).not.toHaveBeenCalled();
    expect(capturedRequest?.input).toEqual([]);
    expect(capturedRequest?.state).toBeDefined();
  });
