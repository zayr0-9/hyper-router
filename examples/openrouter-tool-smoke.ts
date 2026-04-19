import { z } from "zod/v4";

import { OpenRouterProvider, defineTool } from "../src/index.js";
import type { Message } from "../src/index.js";

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY. Set it before running this script.");
  }

  const provider = new OpenRouterProvider();

  const echoTool = defineTool<{ text: string }, { echoed: string }>({
    name: "echo",
    description: "Echoes text back exactly as provided.",
    inputSchema: z.object({
      text: z.string(),
    }),
    async execute(args) {
      return {
        ok: true,
        output: {
          echoed: args.text,
        },
      };
    },
  });

  const messages: Message[] = [
    {
      role: "system",
      content: "You are a tool-calling assistant. When the user asks you to call a tool, do it.",
      date: new Date(),
    },
    {
      role: "user",
      content:
        "You must call the echo tool with text='hello'. Do not answer without calling the tool first.",
      date: new Date(),
    },
  ];

  console.log("Running OpenRouter tool-call smoke test...");

  const result = await provider.generate({
    model: "openai/gpt-5-mini",
    messages,
    tools: [echoTool],
  });

  console.log("Result:\n", JSON.stringify(result, null, 2));

  const firstToolCall = result.toolCalls?.[0];
  if (!firstToolCall) {
    throw new Error("Smoke test failed: expected at least one tool call.");
  }

  if (firstToolCall.toolName !== "echo") {
    throw new Error(`Smoke test failed: expected tool name 'echo', got '${firstToolCall.toolName}'.`);
  }

  const args = firstToolCall.args as { text?: string };
  if (args.text !== "hello") {
    throw new Error(
      `Smoke test failed: expected tool args.text to be 'hello', got '${String(args.text)}'.`,
    );
  }

  console.log("✅ OpenRouter tool-call smoke test passed.");
}

main().catch((error) => {
  console.error("❌ OpenRouter tool-call smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
