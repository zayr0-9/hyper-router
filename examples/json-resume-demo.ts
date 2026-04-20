import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createRuntime,
  defineAgent,
  JsonStorage,
  StubProvider,
  type Message,
} from "../src/index.js";

const sessionId = "json-demo-session";
const storagePath = resolve("tmp/json-resume-demo-storage.json");

const agent = defineAgent({
  name: "json-resume-demo-agent",
  instructions: "You are a helpful assistant. Keep answers concise and continue from prior transcript when available.",
  model: "stub-model",
});

function printMessages(label: string, messages: Message[]): void {
  console.log(`\n${label}`);
  for (const message of messages) {
    console.log(`- [${message.role}] ${message.content}`);
  }
}

async function createDemoRuntime() {
  await mkdir(dirname(storagePath), { recursive: true });

  return createRuntime({
    agent,
    provider: new StubProvider(),
    storage: new JsonStorage({
      filePath: storagePath,
    }),
  });
}

async function main(): Promise<void> {
  console.log("hyper-router JSON storage resume demo");
  console.log(`Storage file: ${storagePath}`);
  console.log(`Session ID: ${sessionId}`);

  const runtimeA = await createDemoRuntime();
  const firstRun = await runtimeA.run({
    sessionId,
    input: "Hello from the first run.",
  });

  console.log("\n=== First run ===");
  console.log("Status:", firstRun.status);
  printMessages("Messages returned from run 1:", firstRun.messages);

  const storageB = new JsonStorage({ filePath: storagePath });
  const persistedAfterFirstRun = await storageB.loadMessages(sessionId);
  printMessages("Persisted transcript after run 1:", persistedAfterFirstRun);

  const runtimeB = await createDemoRuntime();
  const secondRun = await runtimeB.run({
    sessionId,
    input: "Continue the conversation and remind me what I said earlier.",
  });

  console.log("\n=== Second run (fresh runtime, same JSON file) ===");
  console.log("Status:", secondRun.status);
  printMessages("Messages returned from run 2:", secondRun.messages);

  const persistedAfterSecondRun = await storageB.loadMessages(sessionId);
  printMessages("Persisted transcript after run 2:", persistedAfterSecondRun);

  console.log("\nDemo complete.");
  console.log("This shows transcript persistence across a fresh runtime instance using JsonStorage.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
