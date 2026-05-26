import { z } from "zod/v4";

import { defineTool } from "../src/index.js";
import { GLMProvider } from "../src/providers/glm/index.js";
import type { Message } from "../src/index.js";

async function main(): Promise<void> {
  if (!process.env.ZAI_API_KEY) {
    throw new Error("Missing ZAI_API_KEY. Set it before running this script.");
  }


  const provider = new GLMProvider({
    apiKey: process.env.ZAI_API_KEY,
    ...(process.env.ZAI_BASE_URL ? { baseURL: process.env.ZAI_BASE_URL } : {}),
    thinking: { type: "enabled" },
  });

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

  console.log("Running OpenAI VAI tool-call smoke test...");

  const result = await provider.generate({
    model: process.env.ZAI_MODEL ?? "glm-5.1",
    messages,
    tools: [echoTool],
  });

  console.log("Result:\n", JSON.stringify(result, null, 2));
  console.log("Reasoning content:\n", result.message?.reasoningContent ?? "<none>");

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

  console.log("✅ OpenAI VAI tool-call smoke test passed.");
}

main().catch((error) => {
  console.error("❌ OpenAI VAI tool-call smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
