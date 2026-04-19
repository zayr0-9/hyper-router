import { z } from "zod/v4";

import {
  createRuntime,
  defineAgent,
  defineTool,
  InMemoryStorage,
  OpenRouterProvider,
} from "../src/index.js";

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
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY. Set it before running this script.");
  }

  console.log("Running OpenRouter multi-tool chain smoke test...");

  const runtime = createRuntime({
    agent: defineAgent({
      name: "openrouter-tool-chain-smoke",
      instructions:
        "You are a careful tool-calling assistant. When the user gives a required sequence of tools, you must follow it exactly and wait for tool results before the next dependent tool call.",
      model: "openai/gpt-5-mini",
      tools: [generateTicketId, lookupTicket],
    }),
    provider: new OpenRouterProvider(),
    storage: new InMemoryStorage(),
  });

  const result = await runtime.run({
    sessionId: "openrouter-tool-chain-smoke",
    input:
      "You must do the following in order: (1) call generate_ticket_id with seed='chain-test', (2) after receiving the returned ticketId, call lookup_ticket with that exact returned ticketId, and (3) then give a one-sentence summary. Do not skip any tool calls and do not invent the ticketId.",
    maxSteps: 6,
  });

  console.log("Status:", result.status);

  const toolMessages = result.messages.filter((message) => message.role === "tool");
  console.log(`Tool messages count: ${toolMessages.length}`);
  console.log("Tool results:");

  for (const message of toolMessages) {
    console.log(`- ${message.name}:`);
    try {
      console.log(JSON.stringify(JSON.parse(message.content), null, 2));
    } catch {
      console.log(message.content);
    }
  }

  const assistantMessages = result.messages.filter((message) => message.role === "assistant");
  const finalAssistantMessage = assistantMessages[assistantMessages.length - 1];

  console.log("Final assistant message:");
  console.log(finalAssistantMessage?.content ?? "<none>");

  if (result.status !== "completed") {
    throw new Error(`Smoke test failed: expected completed status, got '${result.status}'.`);
  }

  if (toolMessages.length < 2) {
    throw new Error(`Smoke test failed: expected at least 2 tool messages, got ${toolMessages.length}.`);
  }

  const toolNames = toolMessages.map((message) => message.name ?? "");
  const generateIndex = toolNames.indexOf("generate_ticket_id");
  const lookupIndex = toolNames.indexOf("lookup_ticket");

  if (generateIndex === -1) {
    throw new Error("Smoke test failed: generate_ticket_id was never executed.");
  }

  if (lookupIndex === -1) {
    throw new Error("Smoke test failed: lookup_ticket was never executed.");
  }

  if (generateIndex >= lookupIndex) {
    throw new Error(
      `Smoke test failed: expected generate_ticket_id before lookup_ticket, got order ${toolNames.join(", ")}.`,
    );
  }

  console.log("✅ OpenRouter multi-tool chain smoke test passed.");
}

main().catch((error) => {
  console.error("❌ OpenRouter multi-tool chain smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
