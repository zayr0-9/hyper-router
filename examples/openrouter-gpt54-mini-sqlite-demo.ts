import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import {
  createRuntime,
  defineAgent,
  defineTool,
  OpenRouterProvider,
  SqliteStorage,
  type Message,
} from "../src/index.js";

const sessionId = "openrouter-gpt54-mini-sqlite-demo";
const storagePath = resolve("tmp/openrouter-gpt54-mini-demo-storage.sqlite");
const model = "openai/gpt-5.4-mini";

const echoTool = defineTool<{ text: string }, { echoed: string }>({
  name: "echo",
  description: "Echo text back to the agent exactly.",
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
  name: "openrouter-gpt54-mini-sqlite-demo-agent",
  instructions:
    "You are a helpful assistant. Use the echo tool when the user explicitly asks you to call it. Keep answers concise.",
  model,
  tools: [echoTool],
});

function printMessages(label: string, messages: Message[]): void {
  console.log(`\n${label}`);
  for (const message of messages) {
    console.log(`- [${message.role}] ${message.content}`);
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const toolCall of message.toolCalls) {
        console.log(`  tool_call -> ${toolCall.toolName} ${JSON.stringify(toolCall.args)}`);
      }
    }
  }
}

async function createDemoRuntime() {
  await mkdir(dirname(storagePath), { recursive: true });

  return createRuntime({
    agent,
    provider: new OpenRouterProvider({
      continuation: {
        strategy: "transcript",
      },
    }),
    storage: new SqliteStorage({
      filePath: storagePath,
    }),
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY. Set it before running this demo.");
  }

  console.log("hyper-router real API demo");
  console.log(`Model: ${model}`);
  console.log(`Storage file: ${storagePath}`);
  console.log(`Session ID: ${sessionId}`);
  console.log("This demo makes real OpenRouter API calls and persists transcript state to SQLite.\n");

  const runtimeA = await createDemoRuntime();
  const firstRun = await runtimeA.run({
    sessionId,
    input: "Call the echo tool with text='hello from GPT-5.4 Mini SQLite demo' and then briefly explain what happened.",
    maxSteps: 4,
  });

  console.log("=== First run ===");
  console.log("Status:", firstRun.status);
  printMessages("Messages returned from run 1:", firstRun.messages);

  const storage = new SqliteStorage({ filePath: storagePath });
  const persistedAfterFirstRun = await storage.loadMessages(sessionId);
  printMessages("Persisted transcript after run 1:", persistedAfterFirstRun);

  const runtimeB = await createDemoRuntime();
  const secondRun = await runtimeB.run({
    sessionId,
    input: "Continue the conversation. In one sentence, remind me which tool was used and what text it echoed.",
    maxSteps: 4,
  });

  console.log("\n=== Second run (fresh runtime, same SQLite file) ===");
  console.log("Status:", secondRun.status);
  printMessages("Messages returned from run 2:", secondRun.messages);

  const persistedAfterSecondRun = await storage.loadMessages(sessionId);
  printMessages("Persisted transcript after run 2:", persistedAfterSecondRun);

  console.log("\nDemo complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
