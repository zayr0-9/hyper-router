import { z } from "zod";

import {
  createRuntime,
  defineAgent,
  defineTool,
  InMemoryStorage,
} from "../src/index.js";
import { AmazonBedrockVAIProvider } from "../src/providers/amazon-bedrock-vai/index.js";

const echoTool = defineTool<{ text: string }, { echoed: string }>({
  name: "echo",
  description: "Echo text back.",
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

const agent = defineAgent({
  name: "amazon-bedrock-vai-agent",
  instructions: "You are helpful. Use tools only when needed.",
  model: "anthropic.claude-3-sonnet-20240229-v1:0",
  tools: [echoTool],
});

async function main(): Promise<void> {
  if (!process.env.AWS_REGION) {
    throw new Error("Missing AWS_REGION. Set it before running this script.");
  }

  if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    throw new Error(
      "Missing AWS credentials. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK.",
    );
  }

  const runtime = createRuntime({
    agent,
    provider: new AmazonBedrockVAIProvider(),
    storage: new InMemoryStorage(),
  });

  const result = await runtime.run({
    sessionId: "amazon-bedrock-vai-demo",
    input: "Call the echo tool with text=hello and then reply with what happened.",
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

  console.log("Recent messages:");
  for (const message of result.messages.slice(-6)) {
    console.log(`- [${message.role}] ${message.content}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
