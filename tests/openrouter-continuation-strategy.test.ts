import { describe, expect, it, vi } from "vitest";

import type { SessionMetadata } from "../src/core/storage.js";
import type { Message } from "../src/core/types.js";
import { OpenRouterProvider } from "../src/providers/openrouter/index.js";
import type {
  OpenRouterClientLike,
  OpenRouterStateStore,
} from "../src/providers/openrouter/types.js";

function createMetadata(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    model: "openai/gpt-5-mini",
    promptHash: "prompt-hash-1",
    toolsetHash: "toolset-hash-1",
    ...overrides,
  };
}

function createMessages(): Message[] {
  return [
    {
      role: "system",
      content: "You are helpful.",
      date: new Date("2025-01-01T00:00:00.000Z"),
    },
    {
      role: "user",
      content: "Start",
      date: new Date("2025-01-01T00:00:01.000Z"),
    },
    {
      role: "assistant",
      content: "I will use a tool.",
      date: new Date("2025-01-01T00:00:02.000Z"),
    },
    {
      role: "tool",
      name: "echo",
      content: JSON.stringify({ ok: true, output: { echoed: "hello" } }),
      toolCallId: "call_echo",
      date: new Date("2025-01-01T00:00:03.000Z"),
    },
  ];
}

type MockCallModelRequest = {
  input?: unknown;
  state?: {
    load: () => Promise<unknown>;
    save: (state: unknown) => Promise<void>;
  };
};

function createMockClient(
  implementation?: (request: MockCallModelRequest) => {
    getText: () => Promise<string>;
    getToolCalls: () => Promise<unknown[]>;
    getResponse: () => Promise<{ output: Array<{ type: string; result?: string | null }> }>;
  },
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

describe("OpenRouter continuation strategy selection", () => {
  it("defaults to transcript mode when no continuation config is provided", async () => {
    let request: MockCallModelRequest | undefined;
    const provider = new OpenRouterProvider({
      client: createMockClient((captured) => {
        request = captured;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
    });

    await provider.generate({
      sessionId: "s1",
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata(),
    });

    expect(request?.state).toBeUndefined();
    expect(request?.input).toEqual([
      {
        id: "system-1735689600000-0",
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "You are helpful." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Start" }],
      },
      {
        id: "assistant-1735689602000-2",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I will use a tool.", annotations: [] }],
      },
      {
        type: "function_call_output",
        callId: "call_echo",
        output: '{"ok":true,"output":{"echoed":"hello"}}',
      },
    ]);
  });

  it("defaults to hybrid mode when a stateStore is provided", async () => {
    let request: MockCallModelRequest | undefined;
    const stateStore = createMemoryStateStore();
    const provider = new OpenRouterProvider({
      client: createMockClient((captured) => {
        request = captured;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: { stateStore },
    });

    await provider.generate({
      sessionId: "s2",
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata(),
    });

    expect(request?.state).toBeDefined();
    expect(request?.input).toEqual([
      {
        id: "system-1735689600000-0",
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "You are helpful." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Start" }],
      },
      {
        id: "assistant-1735689602000-2",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I will use a tool.", annotations: [] }],
      },
      {
        type: "function_call_output",
        callId: "call_echo",
        output: '{"ok":true,"output":{"echoed":"hello"}}',
      },
    ]);
  });

  it("state mode bootstraps from external messages only", async () => {
    let request: MockCallModelRequest | undefined;
    const provider = new OpenRouterProvider({
      client: createMockClient((captured) => {
        request = captured;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: { strategy: "state" },
    });

    await provider.generate({
      sessionId: "s3",
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata(),
    });

    expect(request?.state).toBeDefined();
    expect(request?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Start" }],
      },
      {
        type: "function_call_output",
        callId: "call_echo",
        output: '{"ok":true,"output":{"echoed":"hello"}}',
      },
    ]);
  });
});

describe("OpenRouter continuation invalidation rules", () => {
  it("invalidates on prompt hash mismatch and falls back to transcript replay", async () => {
    const stateStore = createMemoryStateStore();
    await stateStore.save("prompt-mismatch", {
      state: {
        id: "prompt-mismatch",
        messages: [{ role: "user", content: "Old state" }],
        status: "complete",
        createdAt: 0,
        updatedAt: 0,
      },
      metadata: createMetadata({ promptHash: "old-prompt" }),
    });

    let request: MockCallModelRequest | undefined;
    const provider = new OpenRouterProvider({
      client: createMockClient((captured) => {
        request = captured;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: { strategy: "hybrid", stateStore },
    });

    await provider.generate({
      sessionId: "prompt-mismatch",
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata({ promptHash: "new-prompt" }),
    });

    expect(stateStore.clear).toHaveBeenCalledWith("prompt-mismatch");
    expect(request?.state).toBeDefined();
    expect(Array.isArray(request?.input)).toBe(true);
    expect((request?.input as Array<unknown>).length).toBe(4);
  });

  it("invalidates on toolset hash mismatch", async () => {
    const stateStore = createMemoryStateStore();
    await stateStore.save("toolset-mismatch", {
      state: {
        id: "toolset-mismatch",
        messages: [{ role: "user", content: "Old state" }],
        status: "complete",
        createdAt: 0,
        updatedAt: 0,
      },
      metadata: createMetadata({ toolsetHash: "old-toolset" }),
    });

    const provider = new OpenRouterProvider({
      client: createMockClient(),
      continuation: { strategy: "hybrid", stateStore },
    });

    await provider.generate({
      sessionId: "toolset-mismatch",
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata({ toolsetHash: "new-toolset" }),
    });

    expect(stateStore.clear).toHaveBeenCalledWith("toolset-mismatch");
  });

  it("invalidates on model mismatch by default", async () => {
    const stateStore = createMemoryStateStore();
    await stateStore.save("model-mismatch", {
      state: {
        id: "model-mismatch",
        messages: [{ role: "user", content: "Old state" }],
        status: "complete",
        createdAt: 0,
        updatedAt: 0,
      },
      metadata: createMetadata({ model: "openai/gpt-5-mini" }),
    });

    const provider = new OpenRouterProvider({
      client: createMockClient(),
      continuation: { strategy: "hybrid", stateStore },
    });

    await provider.generate({
      sessionId: "model-mismatch",
      model: "anthropic/claude-3.5-sonnet",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata({ model: "anthropic/claude-3.5-sonnet" }),
    });

    expect(stateStore.clear).toHaveBeenCalledWith("model-mismatch");
  });

  it("can keep native state across model changes when configured", async () => {
    const stateStore = createMemoryStateStore();
    await stateStore.save("model-lenient", {
      state: {
        id: "model-lenient",
        messages: [{ role: "user", content: "Old state" }],
        status: "in_progress",
        createdAt: 0,
        updatedAt: 0,
      },
      metadata: createMetadata({ model: "openai/gpt-5-mini" }),
    });

    let request: MockCallModelRequest | undefined;
    const provider = new OpenRouterProvider({
      client: createMockClient((captured) => {
        request = captured;
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
      sessionId: "model-lenient",
      model: "anthropic/claude-3.5-sonnet",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata({ model: "anthropic/claude-3.5-sonnet" }),
    });

    expect(stateStore.clear).not.toHaveBeenCalled();
    expect(request?.state).toBeDefined();
    expect(request?.input).toEqual([]);
  });
});


describe("OpenRouter ephemeral mode", () => {
  it("does not attach state when invoked ephemerally for a single execution", async () => {
    let request: MockCallModelRequest | undefined;
    const stateStore = createMemoryStateStore();
    const provider = new OpenRouterProvider({
      client: createMockClient((captured) => {
        request = captured;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: { strategy: "hybrid", stateStore },
    });

    await provider.generate({
      sessionId: "ephemeral-s1",
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata(),
      ephemeral: true,
    });

    expect(request?.state).toBeUndefined();
    expect(request?.input).toEqual([
      {
        id: "system-1735689600000-0",
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "You are helpful." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Start" }],
      },
      {
        id: "assistant-1735689602000-2",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I will use a tool.", annotations: [] }],
      },
      {
        type: "function_call_output",
        callId: "call_echo",
        output: '{"ok":true,"output":{"echoed":"hello"}}',
      },
    ]);
    expect(stateStore.load).not.toHaveBeenCalled();
    expect(stateStore.save).not.toHaveBeenCalled();
  });

  it("supports provider-configured ephemeral continuation mode", async () => {
    let request: MockCallModelRequest | undefined;
    const provider = new OpenRouterProvider({
      client: createMockClient((captured) => {
        request = captured;
        return {
          getText: async () => "done",
          getToolCalls: async () => [],
          getResponse: async () => ({ output: [] }),
        };
      }),
      continuation: { strategy: "ephemeral" },
    });

    await provider.generate({
      sessionId: "ephemeral-s2",
      model: "openai/gpt-5-mini",
      messages: createMessages(),
      tools: [],
      previousSessionMetadata: createMetadata(),
    });

    expect(request?.state).toBeUndefined();
    expect(request?.input).toEqual([
      {
        id: "system-1735689600000-0",
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: "You are helpful." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Start" }],
      },
      {
        id: "assistant-1735689602000-2",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "I will use a tool.", annotations: [] }],
      },
      {
        type: "function_call_output",
        callId: "call_echo",
        output: '{"ok":true,"output":{"echoed":"hello"}}',
      },
    ]);
  });
});
