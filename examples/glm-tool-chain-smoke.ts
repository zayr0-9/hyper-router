import { z } from "zod/v4";

import {
  createRuntime,
  defineAgent,
  defineTool,
  InMemoryStorage,
} from "../src/index.js";
import { GLMProvider } from "../src/providers/glm/index.js";

const MODEL = process.env.ZAI_MODEL ?? "glm-5.1";

const generateTicketId = defineTool<{ seed: string }, { ticketId: string }>({
  name: "generate_ticket_id",
  description:
    "Generate a ticket ID from a seed string. Use this before calling lookup_ticket.",
  inputSchema: z.object({
    seed: z.string(),
  }),
  async execute(args) {
    const normalizedSeed = args.seed.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-");

    return {
      ok: true,
      output: {
        ticketId: `${normalizedSeed}-48291`,
      },
    };
  },
});

const lookupTicket = defineTool<
  { ticketId: string },
  { status: string; priority: string; owner: string }
>({
  name: "lookup_ticket",
  description: "Look up ticket details for a previously generated ticket ID.",
  inputSchema: z.object({
    ticketId: z.string(),
  }),
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

async function main(): Promise<void> {
  if (!process.env.ZAI_API_KEY) {
    throw new Error("Missing ZAI_API_KEY. Set it before running this script.");
  }

  const provider = new GLMProvider({
    apiKey: process.env.ZAI_API_KEY,
    ...(process.env.ZAI_BASE_URL ? { baseURL: process.env.ZAI_BASE_URL } : {}),
    thinking: { type: "enabled" },
    rawBody: {
      parallel_tool_calls: false,
    },
  });

  const agent = defineAgent({
    name: "glm-tool-chain-smoke",
    instructions:
      "You are a careful tool-using assistant. If the user asks for ticket details, first call generate_ticket_id, then call lookup_ticket, then summarize the result.",
    model: MODEL,
    tools: [generateTicketId, lookupTicket],
  });

  const runtime = createRuntime({
    agent,
    provider,
    storage: new InMemoryStorage(),
  });

  console.log("Running GLM/Z.AI VAI tool-chain smoke test with reasoning enabled...");

  const result = await runtime.run({
    sessionId: `glm-tool-chain-smoke-${Date.now()}`,
    input: "Generate the required ticket id for chain-test, look up the ticket, and summarize it.",
    maxSteps: 5,
  });

  console.log("Status:", result.status);
  console.log(
    "Messages:\n",
    JSON.stringify(
      result.messages.map((message) => ({
        role: message.role,
        content: message.content,
        reasoningContent: message.reasoningContent,
        name: message.name,
        toolCallId: message.toolCallId,
        toolCalls: message.toolCalls,
      })),
      null,
      2,
    ),
  );

  const reasoningContents = result.messages
    .map((message) => message.reasoningContent)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  console.log("Reasoning content(s):\n", JSON.stringify(reasoningContents, null, 2));

  if (result.status !== "completed") {
    throw new Error(`Smoke test failed: expected completed status, got ${result.status}.`);
  }

  const toolMessages = result.messages.filter((message) => message.role === "tool");
  const toolNames = toolMessages.map((message) => message.name ?? "");

  if (!toolNames.includes("generate_ticket_id")) {
    throw new Error("Smoke test failed: expected generate_ticket_id tool to run.");
  }

  if (!toolNames.includes("lookup_ticket")) {
    throw new Error("Smoke test failed: expected lookup_ticket tool to run.");
  }

  const finalAssistant = [...result.messages].reverse().find((message) => message.role === "assistant");
  if (!finalAssistant?.content.includes("owner-for-CHAIN-TEST-48291")) {
    throw new Error(
      `Smoke test failed: expected final assistant summary to mention owner-for-CHAIN-TEST-48291, got ${finalAssistant?.content ?? "<none>"}.`,
    );
  }

  console.log("✅ GLM/Z.AI VAI tool-chain smoke test passed.");
}

main().catch((error) => {
  console.error("❌ GLM/Z.AI VAI tool-chain smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
