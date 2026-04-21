import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import type { Message } from "../src/core/types.js";
import type { ToolDefinition } from "../src/core/tool.js";
import { AmazonBedrockVAIProvider } from "../src/providers/amazon-bedrock-vai/index.js";

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

describe("AmazonBedrockVAIProvider", () => {
  it("maps internal messages into AI SDK model messages", () => {
    const provider = new AmazonBedrockVAIProvider({
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
    const provider = new AmazonBedrockVAIProvider({
      provider: {} as any,
      generateTextImpl: vi.fn() as any,
    });

    const tools = provider["toAiSdkTools"]([createEchoTool()]);
    const echoTool = tools.echo as any;

    expect(echoTool).toBeDefined();
    expect(echoTool.description).toBe("Echo text");
    expect(echoTool.inputSchema.safeParse({ text: "hello" }).success).toBe(true);
  });

  it("accepts JSON Schema tool definitions", () => {
    const provider = new AmazonBedrockVAIProvider({
      provider: {} as any,
      generateTextImpl: vi.fn() as any,
    });

    const tools = provider["toAiSdkTools"]([
      {
        name: "echo",
        description: "Echo text",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
          additionalProperties: false,
        },
        execute: vi.fn(async () => ({ ok: true, output: { echoed: "hello" } })),
      },
    ]);

    expect((tools.echo as any).inputSchema).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    });
  });

  it("rejects invalid tool schemas early", () => {
    const provider = new AmazonBedrockVAIProvider({
      provider: {} as any,
      generateTextImpl: vi.fn() as any,
    });

    expect(() =>
      provider["toAiSdkTools"]([
        {
          name: "echo",
          description: "Echo text",
          inputSchema: { nope: true },
          execute: vi.fn(async () => ({ ok: true, output: { echoed: "hello" } })),
        },
      ]),
    ).toThrowError(
      "Invalid tool inputSchema: expected Zod schema, JSON Schema object, or undefined.",
    );
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

    const providerFactory = vi.fn((model: string) => ({ kind: "bedrock", model }));

    const provider = new AmazonBedrockVAIProvider({
      provider: providerFactory as any,
      generateTextImpl: generateTextImpl as any,
    });

    const result = await provider.generate({
      model: "meta.llama3-70b-instruct-v1:0",
      messages: createMessages().slice(0, 2),
      tools: [createEchoTool()],
      previousSessionMetadata: null,
    });

    expect(providerFactory).toHaveBeenCalledWith("meta.llama3-70b-instruct-v1:0");
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
    const provider = new AmazonBedrockVAIProvider({
      provider: vi.fn((model: string) => ({ kind: "bedrock", model })) as any,
      generateTextImpl: vi.fn(async () => ({
        finishReason: "stop",
        toolCalls: Promise.resolve([]),
        response: {
          messages: [],
        },
      })) as any,
    });

    const result = await provider.generate({
      model: "meta.llama3-70b-instruct-v1:0",
      messages: createMessages().slice(0, 2),
      tools: [],
      previousSessionMetadata: null,
    });

    expect(result).toEqual({
      toolCalls: [],
      stopReason: "stop",
    });
  });

  it("forwards providerOptions and maxRetries to generateText", async () => {
    const generateTextImpl = vi.fn(async () => ({
      finishReason: "stop",
      toolCalls: Promise.resolve([]),
      response: { messages: [] },
    }));

    const provider = new AmazonBedrockVAIProvider({
      provider: vi.fn((model: string) => ({ kind: "bedrock", model })) as any,
      providerOptions: {
        reasoningConfig: {
          type: "enabled",
          budgetTokens: 256,
        },
      },
      maxRetries: 5,
      generateTextImpl: generateTextImpl as any,
    });

    await provider.generate({
      model: "anthropic.claude-3-sonnet-20240229-v1:0",
      messages: createMessages().slice(0, 2),
      tools: [createEchoTool()],
      previousSessionMetadata: null,
    });

    expect(generateTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 5,
        providerOptions: {
          bedrock: {
            reasoningConfig: {
              type: "enabled",
              budgetTokens: 256,
            },
          },
        },
      }),
    );
  });
});
