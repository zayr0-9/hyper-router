import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { defineAgent } from "../src/core/agent.js";
import type { ModelProvider } from "../src/core/providers.js";
import { InMemoryStorage } from "../src/core/storage.js";
import { createRuntime } from "../src/core/runtime.js";
import { defineTool } from "../src/core/tool.js";
import type { Message, ModelResponse, ToolCall } from "../src/core/types.js";

function simplifyMessages(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

describe("AgentRuntime storage", () => {
  it("stores transcript messages without persisting system messages across runs", async () => {
    const capturedRuns: Message[][] = [];

    const provider: ModelProvider = {
      generate: vi.fn(async ({ messages }): Promise<ModelResponse> => {
        capturedRuns.push(messages);

        return {
          message: {
            role: "assistant",
            content: "ack",
            date: new Date("2025-01-01T00:00:10.000Z"),
          },
          stopReason: "stop",
        };
      }),
    };

    const storage = new InMemoryStorage();

    const runtimeA = createRuntime({
      agent: defineAgent({
        name: "demo-agent",
        instructions: "Prompt A",
        model: "stub-model",
      }),
      provider,
      storage,
    });

    await runtimeA.run({
      sessionId: "session-1",
      input: "Hello",
    });

    expect(simplifyMessages(await storage.loadMessages("session-1"))).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "ack" },
    ]);

    const runtimeB = createRuntime({
      agent: defineAgent({
        name: "demo-agent",
        instructions: "Prompt B",
        model: "stub-model",
      }),
      provider,
      storage,
    });

    await runtimeB.run({
      sessionId: "session-1",
      input: "Continue",
    });

    expect(capturedRuns).toHaveLength(2);
    expect(simplifyMessages(capturedRuns[1] ?? [])).toEqual([
      { role: "system", content: "Prompt B" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "ack" },
    ]);

    expect(simplifyMessages(await storage.loadMessages("session-1"))).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "ack" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "ack" },
    ]);
  });

  it("surfaces normalized and provider stop reasons in runtime result", async () => {
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "partial answer",
          date: new Date("2025-01-01T00:00:12.000Z"),
        },
        toolCalls: [],
        stopReason: "length",
        providerStopReason: "max_tokens",
      })),
    };

    const runtime = createRuntime({
      agent: defineAgent({
        name: "stop-reason-agent",
        instructions: "Be helpful.",
        model: "stub-model",
      }),
      provider,
      storage: new InMemoryStorage(),
    });

    const result = await runtime.run({
      sessionId: "stop-reason-session",
      input: "Write a long answer.",
    });

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("length");
    expect(result.providerStopReason).toBe("max_tokens");
  });

  it("returns generated images from provider responses", async () => {
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "Generated an image.",
          date: new Date("2025-01-01T00:00:15.000Z"),
        },
        generatedImages: [
          {
            dataUrl: "data:image/png;base64,abc123",
            mimeType: "image/png",
          },
        ],
        stopReason: "stop",
      })),
    };

    const runtime = createRuntime({
      agent: defineAgent({
        name: "image-agent",
        instructions: "Generate images.",
        model: "stub-model",
      }),
      provider,
      storage: new InMemoryStorage(),
    });

    const result = await runtime.run({
      sessionId: "image-session",
      input: "Draw a red square.",
    });

    expect(result.generatedImages).toEqual([
      {
        dataUrl: "data:image/png;base64,abc123",
        mimeType: "image/png",
      },
    ]);
  });

  it("preserves provider reasoning content in runtime result and persisted transcript", async () => {
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "done",
          reasoningContent: "I reasoned about it.",
          date: new Date("2025-01-01T00:00:18.000Z"),
        },
        stopReason: "stop",
      })),
    };

    const storage = new InMemoryStorage();
    const runtime = createRuntime({
      agent: defineAgent({
        name: "reasoning-agent",
        instructions: "Think carefully.",
        model: "stub-model",
      }),
      provider,
      storage,
    });

    const result = await runtime.run({
      sessionId: "reasoning-session",
      input: "Solve it.",
    });

    expect(result.messages.at(-1)?.reasoningContent).toBe("I reasoned about it.");
    expect((await storage.loadMessages("reasoning-session")).at(-1)?.reasoningContent).toBe(
      "I reasoned about it.",
    );
  });

  it("updates standard session metadata and preserves custom metadata", async () => {
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "done",
          date: new Date("2025-01-01T00:00:20.000Z"),
        },
        stopReason: "stop",
      })),
    };

    const storage = new InMemoryStorage();
    await storage.setSessionMetadata("session-2", {
      custom: {
        tenantId: "tenant-123",
      },
    });

    const runtime = createRuntime({
      agent: defineAgent({
        name: "metadata-agent",
        instructions: "Be helpful.",
        model: "stub-model",
      }),
      provider,
      storage,
    });

    await runtime.run({
      sessionId: "session-2",
      input: "Hi",
    });

    const metadata = await storage.getSessionMetadata("session-2");
    expect(metadata).toMatchObject({
      agentName: "metadata-agent",
      model: "stub-model",
      promptSnapshot: "Be helpful.",
      custom: {
        tenantId: "tenant-123",
      },
    });
    expect(metadata?.promptHash).toEqual(expect.any(String));
    expect(metadata?.toolsetHash).toEqual(expect.any(String));
    expect(metadata?.updatedAt).toEqual(expect.any(String));
  });

  it("builds session metadata without crashing on Zod schemas and circular permission metadata", async () => {
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "done",
          date: new Date("2025-01-01T00:00:22.000Z"),
        },
        stopReason: "stop",
      })),
    };

    const circularMetadata: Record<string, unknown> = {
      category: "filesystem",
    };
    circularMetadata.self = circularMetadata;

    const tool = defineTool<{ path: string; content: string }, { path: string; content: string }>({
      name: "write_file",
      description: "Write a file.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      permission: {
        mode: "ask",
        reason: "Writes to disk.",
        metadata: circularMetadata,
      },
      async execute(args) {
        return { ok: true, output: args };
      },
    });

    const storage = new InMemoryStorage();
    await storage.setSessionMetadata("zod-circular-metadata-session", {
      custom: {
        tenantId: "tenant-123",
      },
    });

    const result = await createRuntime({
      agent: defineAgent({
        name: "metadata-agent",
        instructions: "Be helpful.",
        model: "stub-model",
        tools: [tool],
      }),
      provider,
      storage,
    }).run({
      sessionId: "zod-circular-metadata-session",
      input: "Hi",
    });

    expect(result.status).toBe("completed");
    expect(provider.generate).toHaveBeenCalledOnce();

    const metadata = await storage.getSessionMetadata("zod-circular-metadata-session");
    expect(metadata).toMatchObject({
      agentName: "metadata-agent",
      model: "stub-model",
      custom: {
        tenantId: "tenant-123",
      },
    });
    expect(metadata?.toolsetHash).toEqual(expect.any(String));
  });

  it("uses stable toolset hashes and excludes permission metadata", async () => {
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "done",
          date: new Date("2025-01-01T00:00:24.000Z"),
        },
        stopReason: "stop",
      })),
    };

    function createAgentForSchema(schema: Record<string, unknown>, metadataLabel: string) {
      const metadata: Record<string, unknown> = { label: metadataLabel };
      metadata.self = metadata;

      const tool = defineTool({
        name: "echo",
        description: "Echo text.",
        inputSchema: schema,
        permission: {
          mode: "ask" as const,
          reason: "Needs approval.",
          metadata,
        },
        async execute(args) {
          return { ok: true, output: args };
        },
      });

      return defineAgent({
        name: "stable-hash-agent",
        instructions: "Be helpful.",
        model: "stub-model",
        tools: [tool],
      });
    }

    const schemaA = {
      type: "object",
      properties: {
        text: { type: "string" },
        count: { type: "number" },
      },
      required: ["text"],
    };
    const schemaB = {
      required: ["text"],
      properties: {
        count: { type: "number" },
        text: { type: "string" },
      },
      type: "object",
    };

    const storageA = new InMemoryStorage();
    const runtimeA = createRuntime({
      agent: createAgentForSchema(schemaA, "a"),
      provider,
      storage: storageA,
    });

    const storageB = new InMemoryStorage();
    const runtimeB = createRuntime({
      agent: createAgentForSchema(schemaB, "b"),
      provider,
      storage: storageB,
    });

    await runtimeA.run({ sessionId: "stable-hash-session-a", input: "Hi" });
    await runtimeB.run({ sessionId: "stable-hash-session-b", input: "Hi" });

    const hashA = (await storageA.getSessionMetadata("stable-hash-session-a"))?.toolsetHash;
    const hashB = (await storageB.getSessionMetadata("stable-hash-session-b"))?.toolsetHash;

    expect(hashA).toEqual(expect.any(String));
    expect(hashB).toBe(hashA);
  });
});

it("can resume a paused tool chain from persisted transcript with a fresh runtime and provider", async () => {
  const generateTicketId = defineTool<{ seed: string }, { ticketId: string }>({
    name: "generate_ticket_id",
    description: "Generate a ticket ID from a seed.",
    async execute(args) {
      return {
        ok: true,
        output: {
          ticketId: `${args.seed.toUpperCase()}-48291`,
        },
      };
    },
  });

  const lookupTicket = defineTool<
    { ticketId: string },
    { status: string; priority: string; owner: string }
  >({
    name: "lookup_ticket",
    description: "Look up a ticket by ID.",
    async execute(args) {
      return {
        ok: true,
        output: {
          status: "open",
          priority: "high",
          owner: `owner-for-${args.ticketId}`,
        },
      };
    },
  });

  function createProvider(): ModelProvider {
    return {
      generate: vi.fn(async ({ messages }): Promise<ModelResponse> => {
        const toolMessages = messages.filter((message: Message) => message.role === "tool");
        const generateResult = toolMessages.find(
          (message: Message) => message.name === "generate_ticket_id",
        );
        const lookupResult = toolMessages.find((message: Message) => message.name === "lookup_ticket");

        if (!generateResult) {
          const toolCalls: ToolCall[] = [
            {
              id: "call_generate",
              toolName: "generate_ticket_id",
              args: { seed: "chain-test" },
            },
          ];

          return {
            message: {
              role: "assistant",
              content: "I will generate the ticket ID first.",
              date: new Date("2025-01-01T00:00:10.000Z"),
              toolCalls,
            },
            toolCalls,
            stopReason: "tool_calls",
          };
        }

        if (!lookupResult) {
          const parsedGenerateResult = JSON.parse(generateResult.content) as {
            output?: { ticketId?: string };
          };
          const ticketId = parsedGenerateResult.output?.ticketId ?? "UNKNOWN";
          const toolCalls: ToolCall[] = [
            {
              id: "call_lookup",
              toolName: "lookup_ticket",
              args: { ticketId },
            },
          ];

          return {
            message: {
              role: "assistant",
              content: "Now I will look up the generated ticket.",
              date: new Date("2025-01-01T00:00:20.000Z"),
              toolCalls,
            },
            toolCalls,
            stopReason: "tool_calls",
          };
        }

        const parsedLookupResult = JSON.parse(lookupResult.content) as {
          output?: { status?: string; priority?: string; owner?: string };
        };

        return {
          message: {
            role: "assistant",
            content:
              `Ticket summary: status=${parsedLookupResult.output?.status}, ` +
              `priority=${parsedLookupResult.output?.priority}, ` +
              `owner=${parsedLookupResult.output?.owner}.`,
            date: new Date("2025-01-01T00:00:30.000Z"),
          },
          stopReason: "stop",
        };
      }),
    };
  }

  const storage = new InMemoryStorage();
  const agent = defineAgent({
    name: "resume-tool-chain-agent",
    instructions: "Resume from the stored transcript and continue the tool chain.",
    model: "stub-model",
    tools: [generateTicketId, lookupTicket],
    buildMessages: (input) =>
      input.trim().length === 0 ? [] : [{ role: "user", content: input, date: new Date() }],
  });

  const runtimeA = createRuntime({
    agent,
    provider: createProvider(),
    storage,
  });

  const firstRun = await runtimeA.run({
    sessionId: "resume-tool-chain",
    input: "Run the required ticket lookup chain.",
    maxSteps: 1,
  });

  expect(firstRun.status).toBe("max_steps_reached");
  expect(simplifyMessages(await storage.loadMessages("resume-tool-chain"))).toEqual([
    { role: "user", content: "Run the required ticket lookup chain." },
    { role: "assistant", content: "I will generate the ticket ID first." },
    { role: "tool", content: JSON.stringify({ ok: true, output: { ticketId: "CHAIN-TEST-48291" } }) },
  ]);

  const runtimeB = createRuntime({
    agent,
    provider: createProvider(),
    storage,
  });

  const secondRun = await runtimeB.run({
    sessionId: "resume-tool-chain",
    input: "",
    maxSteps: 4,
  });

  expect(secondRun.status).toBe("completed");
  expect(simplifyMessages(await storage.loadMessages("resume-tool-chain"))).toEqual([
    { role: "user", content: "Run the required ticket lookup chain." },
    { role: "assistant", content: "I will generate the ticket ID first." },
    { role: "tool", content: JSON.stringify({ ok: true, output: { ticketId: "CHAIN-TEST-48291" } }) },
    { role: "assistant", content: "Now I will look up the generated ticket." },
    {
      role: "tool",
      content: JSON.stringify({
        ok: true,
        output: {
          status: "open",
          priority: "high",
          owner: "owner-for-CHAIN-TEST-48291",
        },
      }),
    },
    {
      role: "assistant",
      content: "Ticket summary: status=open, priority=high, owner=owner-for-CHAIN-TEST-48291.",
    },
  ]);
});

it("canonicalizes missing tool call IDs so resumed transcripts keep matching call/result IDs", async () => {
  const echoTool = defineTool<{ text: string }, { echoed: string }>({
    name: "echo",
    description: "Echo text.",
    async execute(args) {
      return {
        ok: true,
        output: {
          echoed: args.text,
        },
      };
    },
  });

  const storage = new InMemoryStorage();
  const capturedSecondRunMessages: Message[][] = [];

  function createProvider(): ModelProvider {
    return {
      generate: vi.fn(async ({ messages }): Promise<ModelResponse> => {
        const hasToolResult = messages.some((message: Message) => message.role === "tool");

        if (!hasToolResult) {
          const toolCalls: ToolCall[] = [
            {
              toolName: "echo",
              args: { text: "hello" },
            },
          ];

          return {
            message: {
              role: "assistant",
              content: "I will echo that.",
              date: new Date("2025-01-01T00:00:10.000Z"),
              toolCalls,
            },
            toolCalls,
            stopReason: "tool_calls",
          };
        }

        capturedSecondRunMessages.push(messages.map((message: Message) => ({ ...message })));

        return {
          message: {
            role: "assistant",
            content: "Done.",
            date: new Date("2025-01-01T00:00:20.000Z"),
          },
          stopReason: "stop",
        };
      }),
    };
  }

  const agent = defineAgent({
    name: "canonical-tool-id-agent",
    instructions: "Use tools.",
    model: "stub-model",
    tools: [echoTool],
    buildMessages: (input) =>
      input.trim().length === 0 ? [] : [{ role: "user", content: input, date: new Date() }],
  });

  const firstRun = await createRuntime({
    agent,
    provider: createProvider(),
    storage,
  }).run({
    sessionId: "canonical-tool-id-session",
    input: "Echo hello.",
    maxSteps: 1,
  });

  expect(firstRun.status).toBe("max_steps_reached");

  const persistedAfterFirstRun = await storage.loadMessages("canonical-tool-id-session");
  const assistantMessage = persistedAfterFirstRun.find((message) => message.role === "assistant");
  const toolMessage = persistedAfterFirstRun.find((message) => message.role === "tool");

  expect(assistantMessage?.toolCalls).toEqual([
    {
      id: "echo-1-0",
      toolName: "echo",
      args: { text: "hello" },
    },
  ]);
  expect(toolMessage?.toolCallId).toBe("echo-1-0");

  await createRuntime({
    agent,
    provider: createProvider(),
    storage,
  }).run({
    sessionId: "canonical-tool-id-session",
    input: "",
  });

  expect(capturedSecondRunMessages).toHaveLength(1);
  const resumedAssistantMessage = capturedSecondRunMessages[0]?.find(
    (message: Message) => message.role === "assistant",
  );
  const resumedToolMessage = capturedSecondRunMessages[0]?.find(
    (message: Message) => message.role === "tool",
  );

  expect(resumedAssistantMessage?.toolCalls?.[0]?.id).toBe("echo-1-0");
  expect(resumedToolMessage?.toolCallId).toBe("echo-1-0");
});


describe("AgentRuntime ephemeral mode", () => {
  it("does not load prior transcript or persist transcript, run state, or metadata", async () => {
    const capturedRuns: Message[][] = [];

    type GenerateInput = Parameters<ModelProvider["generate"]>[0];

    const provider: ModelProvider = {
      generate: vi.fn(
        async ({
          messages,
          ephemeral,
          previousSessionMetadata,
        }: GenerateInput): Promise<ModelResponse> => {
          capturedRuns.push(messages.map((message) => ({ ...message })));
          expect(ephemeral).toBe(true);
          expect(previousSessionMetadata).toBeNull();

          return {
            message: {
              role: "assistant",
              content: "ephemeral-ack",
              date: new Date("2025-01-01T00:00:30.000Z"),
            },
            stopReason: "stop",
          };
        },
      ),
    };


    const storage = new InMemoryStorage();
    await storage.saveMessages("ephemeral-session", [
      {
        role: "user",
        content: "Persisted hello",
        date: new Date("2025-01-01T00:00:00.000Z"),
      },
      {
        role: "assistant",
        content: "Persisted ack",
        date: new Date("2025-01-01T00:00:01.000Z"),
      },
    ]);
    await storage.setSessionMetadata?.("ephemeral-session", {
      agentName: "existing-agent",
      model: "existing-model",
      promptHash: "existing-prompt-hash",
    });

    const runtime = createRuntime({
      agent: defineAgent({
        name: "ephemeral-agent",
        instructions: "Ephemeral prompt",
        model: "stub-model",
      }),
      provider,
      storage,
    });

    const result = await runtime.run({
      sessionId: "ephemeral-session",
      input: "Fresh input only",
      ephemeral: true,
    });

    expect(result.status).toBe("completed");
    expect(capturedRuns).toHaveLength(1);
    expect(simplifyMessages(capturedRuns[0] ?? [])).toEqual([
      { role: "system", content: "Ephemeral prompt" },
      { role: "user", content: "Fresh input only" },
    ]);

    expect(simplifyMessages(await storage.loadMessages("ephemeral-session"))).toEqual([
      { role: "user", content: "Persisted hello" },
      { role: "assistant", content: "Persisted ack" },
    ]);

    expect(await storage.getSessionMetadata?.("ephemeral-session")).toMatchObject({
      agentName: "existing-agent",
      model: "existing-model",
      promptHash: "existing-prompt-hash",
    });
  });
});

describe("AgentRuntime failure handling", () => {
  it("persists failed run state and partial transcript when the provider throws", async () => {
    const storage = new InMemoryStorage();
    const savedRuns: Array<{ sessionId: string; status: string }> = [];
    const originalSaveRun = storage.saveRun.bind(storage);
    storage.saveRun = vi.fn(async (record) => {
      savedRuns.push(record);
      await originalSaveRun(record);
    });

    const providerError = new Error("provider unavailable");
    const provider: ModelProvider = {
      generate: vi.fn(async () => {
        throw providerError;
      }),
    };

    const runtime = createRuntime({
      agent: defineAgent({
        name: "failing-provider-agent",
        instructions: "Persist failed provider runs.",
        model: "stub-model",
      }),
      provider,
      storage,
    });

    await expect(
      runtime.run({
        sessionId: "provider-failure-session",
        input: "Hello before failure",
      }),
    ).rejects.toThrow(providerError);

    expect(savedRuns).toEqual([
      {
        sessionId: "provider-failure-session",
        status: "failed",
      },
    ]);
    expect(simplifyMessages(await storage.loadMessages("provider-failure-session"))).toEqual([
      { role: "user", content: "Hello before failure" },
    ]);
  });

  it("converts thrown tool errors to failed tool results and allows the model to recover", async () => {
    const explodingTool = defineTool({
      name: "explode",
      description: "Throws during execution.",
      async execute() {
        throw new Error("boom");
      },
    });

    const provider: ModelProvider = {
      generate: vi.fn(async ({ messages }): Promise<ModelResponse> => {
        const toolResult = messages.find((message: Message) => message.role === "tool");

        if (!toolResult) {
          const toolCalls: ToolCall[] = [
            {
              id: "call_explode",
              toolName: "explode",
              args: {},
            },
          ];

          return {
            message: {
              role: "assistant",
              content: "I will call the tool.",
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
            content: `Recovered from ${JSON.parse(toolResult.content).error}.`,
            date: new Date("2025-01-01T00:00:20.000Z"),
          },
          stopReason: "stop",
        };
      }),
    };

    const storage = new InMemoryStorage();
    const runtime = createRuntime({
      agent: defineAgent({
        name: "tool-error-agent",
        instructions: "Recover from tool errors.",
        model: "stub-model",
        tools: [explodingTool],
      }),
      provider,
      storage,
    });

    const result = await runtime.run({
      sessionId: "tool-error-session",
      input: "Trigger tool error",
      maxSteps: 3,
    });

    expect(result.status).toBe("completed");
    expect(simplifyMessages(await storage.loadMessages("tool-error-session"))).toEqual([
      { role: "user", content: "Trigger tool error" },
      { role: "assistant", content: "I will call the tool." },
      { role: "tool", content: JSON.stringify({ ok: false, error: "boom" }) },
      { role: "assistant", content: "Recovered from boom." },
    ]);
  });
});


describe("AgentRuntime storage V2", () => {
  it("uses commitRun when provided and passes append-oriented run details", async () => {
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "v2 ack",
          date: new Date("2025-01-01T00:00:30.000Z"),
        },
        stopReason: "stop",
      })),
    };

    const storage = new InMemoryStorage();
    await storage.saveMessages("v2-session", [
      { role: "user", content: "Existing", date: new Date("2025-01-01T00:00:00.000Z") },
    ]);
    const saveMessagesSpy = vi.spyOn(storage, "saveMessages");
    const saveRunSpy = vi.spyOn(storage, "saveRun");
    const commitRun = vi.fn(async (record) => ({
      sessionId: record.sessionId,
      revision: 3,
      messageCount: record.fullMessages.length,
    }));
    const storageV2 = Object.assign(storage, {
      async getSessionState() {
        return { revision: 1, messageCount: 1 };
      },
      commitRun,
    });

    const runtime = createRuntime({
      agent: defineAgent({
        name: "v2-agent",
        instructions: "Be helpful.",
        model: "stub-model",
      }),
      provider,
      storage: storageV2,
    });

    const result = await runtime.run({
      sessionId: "v2-session",
      input: "Next",
      runId: "run-v2",
    });

    expect(result).toMatchObject({
      sessionId: "v2-session",
      revision: 3,
      messageCount: 3,
    });
    expect(commitRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-v2",
        sessionId: "v2-session",
        status: "completed",
        baseRevision: 1,
        baseMessageCount: 1,
        previousMessages: [expect.objectContaining({ role: "user", content: "Existing" })],
        newMessages: [
          expect.objectContaining({ role: "user", content: "Next" }),
          expect.objectContaining({ role: "assistant", content: "v2 ack" }),
        ],
        fullMessages: [
          expect.objectContaining({ role: "user", content: "Existing" }),
          expect.objectContaining({ role: "user", content: "Next" }),
          expect.objectContaining({ role: "assistant", content: "v2 ack" }),
        ],
      }),
    );
    expect(saveMessagesSpy).not.toHaveBeenCalled();
    expect(saveRunSpy).not.toHaveBeenCalled();
  });
});
