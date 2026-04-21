import { join } from "node:path";

import {
  createRuntime,
  defineAgent,
  StubProvider,
} from "../src/index.js";
import { SqliteStorage } from "../src/storage/sqlite.js";

const storage = new SqliteStorage({
  filePath: join(process.cwd(), ".tmp", "sqlite-demo.sqlite"),
});

const agent = defineAgent({
  name: "sqlite-demo-agent",
  instructions: "You are helpful.",
  model: "stub-model",
});

async function main(): Promise<void> {
  const runtime = createRuntime({
    agent,
    provider: new StubProvider(),
    storage,
  });

  await runtime.run({
    sessionId: "sqlite-demo",
    input: "Hello from SQLite storage",
  });

  const resumedRuntime = createRuntime({
    agent,
    provider: new StubProvider(),
    storage: new SqliteStorage({
      filePath: join(process.cwd(), ".tmp", "sqlite-demo.sqlite"),
    }),
  });

  const resumed = await resumedRuntime.run({
    sessionId: "sqlite-demo",
    input: "Continue",
  });

  console.log("Status:", resumed.status);
  console.log("Transcript length:", resumed.messages.length);
  console.log(
    "Recent messages:",
    resumed.messages.slice(-4).map((message) => ({
      role: message.role,
      content: message.content,
    })),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
