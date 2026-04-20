import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import type { Message } from "../src/core/types.js";
import type { ToolDefinition } from "../src/core/tool.js";
import { OpenAIVAIProvider } from "../src/providers/openai-vai/index.js";

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
      role: "assistant",
      content: "I will call echo.",
      date: new Date("2025-01-01T00:00:02.000Z"),
      toolCalls: [
        {
          id: "call_echo",
          toolName: "echo",
          args: { text: "hello" },
        },
      ],
    },
    {
      role: "tool",
      name: "echo",
      content: '{"ok":true,"output":{"echoed":"hello"}}',
      toolCallId: "call_echo",
      date: new Date("2025-01-01T00:00:03.000Z"),
    },
  ];
}

function createEchoTool(): ToolDefinition<{ text: string }, { echoed: string }> {
  return {
    name: "echo",
    description: "Echo text",
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

describe("OpenAIVAIProvider", () => {
  it("maps internal messages into AI SDK model messages", () => {
    const provider = new OpenAIVAIProvider({
      provider: {} as any,
      generateTextImpl: vi.fn() as any,
    });

    const modelMessages = provider["toModelMessages"](createMessages());

    expect(modelMessages).toEqual([
      {
        role: "system",
        content: "You are helpful.",
      },
      {
        role: "user",
        content: "Hello",
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I will call echo.",
          },
          {
            type: "tool-call",
            toolCallId: "call_echo",
            toolName: "echo",
            input: { text: "hello" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_echo",
            toolName: "echo",
            output: {
              type: "json",
              value: {
                ok: true,
                output: {
                  echoed: "hello",
                },
              },
            },
          },
        ],
      },
    ]);
  });

  it("builds AI SDK tools from runtime tool definitions", () => {
    const provider = new OpenAIVAIProvider({
      provider: {} as any,
      generateTextImpl: vi.fn() as any,
    });

    const tools = provider["toAiSdkTools"]([createEchoTool()]);
    const echoTool = tools.echo as any;

    expect(echoTool).toBeDefined();
    expect(echoTool.description).toBe("Echo text");
    expect(echoTool.inputSchema.safeParse({ text: "hello" }).success).toBe(true);
  });

  it("normalizes generateText output into ModelResponse", async () => {
    const generateTextImpl = vi.fn(async () => ({
      finishReason: "tool-calls",
      toolCalls: Promise.resolve([
        {
          toolCallId: "call_echo",
          toolName: "echo",
          input: { text: "hello" },
        },
      ]),
      response: {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I should call the echo tool.",
              },
              {
                type: "tool-call",
                toolCallId: "call_echo",
                toolName: "echo",
                input: { text: "hello" },
              },
            ],
          },
        ],
      },
    }));

    const provider = new OpenAIVAIProvider({
      provider: ((model: string) => ({ kind: "auto", model })) as any,
      generateTextImpl: generateTextImpl as any,
    });

    const result = await provider.generate({
      model: "gpt-5-mini",
      messages: createMessages().slice(0, 2),
      tools: [createEchoTool()],
      previousSessionMetadata: null,
    });

    expect(generateTextImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      message: {
        role: "assistant",
        content: "I should call the echo tool.",
        date: expect.any(Date),
        toolCalls: [
          {
            id: "call_echo",
            toolName: "echo",
            args: { text: "hello" },
          },
        ],
      },
      toolCalls: [
        {
          id: "call_echo",
          toolName: "echo",
          args: { text: "hello" },
        },
      ],
      stopReason: "tool_calls",
    });
  });

  it("returns no assistant message when generateText returns no text and no tool calls", async () => {
    const provider = new OpenAIVAIProvider({
      provider: ((model: string) => ({ kind: "auto", model })) as any,
      generateTextImpl: vi.fn(async () => ({
        finishReason: "stop",
        toolCalls: Promise.resolve([]),
        response: {
          messages: [],
        },
      })) as any,
    });

    const result = await provider.generate({
      model: "gpt-5-mini",
      messages: createMessages().slice(0, 2),
      tools: [],
      previousSessionMetadata: null,
    });

    expect(result).toEqual({
      toolCalls: [],
      stopReason: "stop",
    });
  });

  it("selects the configured Vercel AI SDK OpenAI factory", async () => {
    const providerFactory = Object.assign(
      vi.fn((model: string) => ({ kind: "auto", model })),
      {
        responses: vi.fn((model: string) => ({ kind: "responses", model })),
        chat: vi.fn((model: string) => ({ kind: "chat", model })),
        completion: vi.fn((model: string) => ({ kind: "completion", model })),
      },
    );

    const generateTextImpl = vi.fn(async () => ({
      finishReason: "stop",
      toolCalls: Promise.resolve([]),
      response: { messages: [] },
    }));

    const responsesProvider = new OpenAIVAIProvider({
      provider: providerFactory as any,
      api: "responses",
      generateTextImpl: generateTextImpl as any,
    });

    await responsesProvider.generate({
      model: "gpt-5",
      messages: createMessages().slice(0, 2),
      tools: [],
      previousSessionMetadata: null,
    });

    expect(providerFactory.responses).toHaveBeenCalledWith("gpt-5");

    const chatProvider = new OpenAIVAIProvider({
      provider: providerFactory as any,
      api: "chat",
      generateTextImpl: generateTextImpl as any,
    });

    await chatProvider.generate({
      model: "gpt-4.1",
      messages: createMessages().slice(0, 2),
      tools: [],
      previousSessionMetadata: null,
    });

    expect(providerFactory.chat).toHaveBeenCalledWith("gpt-4.1");

    const completionProvider = new OpenAIVAIProvider({
      provider: providerFactory as any,
      api: "completion",
      generateTextImpl: generateTextImpl as any,
    });

    await completionProvider.generate({
      model: "gpt-3.5-turbo-instruct",
      messages: createMessages().slice(0, 2),
      tools: [],
      previousSessionMetadata: null,
    });

    expect(providerFactory.completion).toHaveBeenCalledWith("gpt-3.5-turbo-instruct");
  });

  it("forwards providerOptions and maxRetries to generateText", async () => {
    const generateTextImpl = vi.fn(async () => ({
      finishReason: "stop",
      toolCalls: Promise.resolve([]),
      response: { messages: [] },
    }));

    const provider = new OpenAIVAIProvider({
      provider: ((model: string) => ({ kind: "auto", model })) as any,
      providerOptions: {
        parallelToolCalls: false,
        store: false,
        user: "user-123",
      },
      maxRetries: 7,
      generateTextImpl: generateTextImpl as any,
    });

    await provider.generate({
      model: "gpt-5-mini",
      messages: createMessages().slice(0, 2),
      tools: [createEchoTool()],
      previousSessionMetadata: null,
    });

    expect(generateTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 7,
        providerOptions: {
          openai: {
            parallelToolCalls: false,
            store: false,
            user: "user-123",
          },
        },
      }),
    );
  });
});
