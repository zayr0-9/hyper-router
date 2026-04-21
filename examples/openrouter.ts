import { z } from "zod";

import {
  createRuntime,
  defineAgent,
  defineTool,
  InMemoryStorage,
} from "../src/index.js";
import { OpenRouterProvider } from "../src/providers/openrouter/index.js";

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
  name: "openrouter-agent",
  instructions: "You are helpful. Use tools only when needed.",
  model: "openai/gpt-5-mini",
  tools: [echoTool],
});

async function main(): Promise<void> {
  const runtime = createRuntime({
    agent,
    provider: new OpenRouterProvider(),
    storage: new InMemoryStorage(),
  });

  const result = await runtime.run({
    sessionId: "openrouter-demo",
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
