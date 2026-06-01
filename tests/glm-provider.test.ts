import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { defineTool } from "../src/index.js";
import { GLMProvider } from "../src/providers/glm/index.js";

const createResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("GLMProvider", () => {
  it("calls Z.AI chat completions directly and extracts reasoning content", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const provider = new GLMProvider({
      apiKey: "test-key",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

        return createResponse({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1,
          model: "glm-5.1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "done",
                reasoning_content: "GLM thought process",
              },
              finish_reason: "stop",
            },
          ],
        });
      },
    });

    const result = await provider.generate({
      model: "glm-5.1",
      messages: [{ role: "user", content: "Hi", date: new Date() }],
      tools: [],
      previousSessionMetadata: null,
    });

    expect(capturedUrl).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer test-key");
    expect(capturedBody).toMatchObject({
      model: "glm-5.1",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(result.message?.content).toBe("done");
    expect(result.message?.reasoningContent).toBe("GLM thought process");
    expect(result.stopReason).toBe("stop");
  });

  it("passes abort signals to fetch", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | null | undefined;

    const provider = new GLMProvider({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        capturedSignal = init?.signal;
        return createResponse({
          choices: [
            {
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
        });
      },
    });

    await provider.generate({
      model: "glm-5.1",
      messages: [{ role: "user", content: "Hi", date: new Date() }],
      tools: [],
      previousSessionMetadata: null,
      signal: controller.signal,
    });

    expect(capturedSignal).toBe(controller.signal);
  });

  it("injects thinking and raw body options into requests", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const provider = new GLMProvider({
      apiKey: "test-key",
      thinking: { type: "enabled", clear_thinking: false },
      rawBody: { do_sample: false },
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return createResponse({
          choices: [
            {
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
        });
      },
    });

    await provider.generate({
      model: "glm-5.1",
      messages: [{ role: "user", content: "Hi", date: new Date() }],
      tools: [],
      previousSessionMetadata: null,
    });

    expect(capturedBody).toMatchObject({
      model: "glm-5.1",
      thinking: { type: "enabled", clear_thinking: false },
      do_sample: false,
    });
  });

  it("normalizes OpenAI-compatible tool calls and sends tool definitions", async () => {
    let capturedBody: Record<string, any> | undefined;
    const tool = defineTool<{ text: string }, { echoed: string }>({
      name: "echo",
      description: "Echoes text back.",
      inputSchema: z.object({ text: z.string() }),
      async execute(args) {
        return { ok: true, output: { echoed: args.text } };
      },
    });

    const provider = new GLMProvider({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, any>;
        return createResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "echo",
                      arguments: '{"text":"hello"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
      },
    });

    const result = await provider.generate({
      model: "glm-5.1",
      messages: [{ role: "user", content: "Call echo", date: new Date() }],
      tools: [tool],
      previousSessionMetadata: null,
    });

    expect(capturedBody?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "echo",
          description: "Echoes text back.",
          parameters: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({ text: expect.any(Object) }),
          }),
        },
      },
    ]);
    expect(result.toolCalls).toEqual([{ id: "call-1", toolName: "echo", args: { text: "hello" } }]);
    expect(result.message?.toolCalls).toEqual(result.toolCalls);
    expect(result.stopReason).toBe("tool_calls");
  });

  it("sends prior assistant reasoning only when preserved thinking is enabled", async () => {
    let capturedBody: Record<string, any> | undefined;

    const provider = new GLMProvider({
      apiKey: "test-key",
      thinking: { type: "enabled", clear_thinking: false },
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, any>;
        return createResponse({ choices: [{ message: { role: "assistant", content: "next" } }] });
      },
    });

    await provider.generate({
      model: "glm-5.1",
      messages: [
        {
          role: "assistant",
          content: "previous",
          reasoningContent: "previous reasoning",
          date: new Date(),
        },
      ],
      tools: [],
      previousSessionMetadata: null,
    });

    expect(capturedBody?.messages?.[0]).toMatchObject({
      role: "assistant",
      content: "previous",
      reasoning_content: "previous reasoning",
    });
  });

  it("throws a helpful error for non-2xx responses", async () => {
    const provider = new GLMProvider({
      apiKey: "test-key",
      fetch: async () => createResponse({ error: { message: "bad request" } }, { status: 400 }),
    });

    await expect(provider.generate({
      model: "glm-5.1",
      messages: [{ role: "user", content: "Hi", date: new Date() }],
      tools: [],
      previousSessionMetadata: null,
    })).rejects.toThrow("Z.AI chat completion failed with status 400: bad request");
  });
});
