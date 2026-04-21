import { z } from "zod/v4";

import { defineTool } from "../src/index.js";
import { AmazonBedrockVAIProvider } from "../src/providers/amazon-bedrock-vai/index.js";
import type { Message } from "../src/index.js";

async function main(): Promise<void> {
  if (!process.env.AWS_REGION) {
    throw new Error("Missing AWS_REGION. Set it before running this script.");
  }

  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    throw new Error(
      "Missing AWS credentials. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK.",
    );
  }

  const provider = new AmazonBedrockVAIProvider();

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

  console.log("Running Amazon Bedrock VAI tool-call smoke test...");

  const result = await provider.generate({
    model: "anthropic.claude-3-sonnet-20240229-v1:0",
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

  console.log("✅ Amazon Bedrock VAI tool-call smoke test passed.");
}

main().catch((error) => {
  console.error("❌ Amazon Bedrock VAI tool-call smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
