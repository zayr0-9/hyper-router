import { describe, expect, it, vi } from "vitest";

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
          stopReason: "completed",
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

  it("updates standard session metadata and preserves custom metadata", async () => {
    const provider: ModelProvider = {
      generate: vi.fn(async (): Promise<ModelResponse> => ({
        message: {
          role: "assistant",
          content: "done",
          date: new Date("2025-01-01T00:00:20.000Z"),
        },
        stopReason: "completed",
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
          stopReason: "completed",
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
