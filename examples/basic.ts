import {
  createRuntime,
  defineAgent,
  defineTool,
  InMemoryStorage,
  StubProvider,
} from "../src/index.js";

const echoTool = defineTool<{ text: string }, { echoed: string }>({
  name: "echo",
  description: "Echoes text back to the runtime.",
  async execute(args) {
    return {
      ok: true,
      output: {
        echoed: args.text,
      },
    };
  },
});

const exampleAgent = defineAgent({
  name: "example-agent",
  instructions: "You are a helpful assistant in a minimal agent runtime.",
  model: "stub-model",
  tools: [echoTool],
});

async function main(): Promise<void> {
  const runtime = createRuntime({
    agent: exampleAgent,
    provider: new StubProvider(),
    storage: new InMemoryStorage(),
  });

  const result = await runtime.run({
    sessionId: "demo-session",
    input: "Hello from the boilerplate runtime",
  });

  const lastMessage = result.messages[result.messages.length - 1];
  console.log("Run status:", result.status);
  console.log("Last message:", lastMessage?.content ?? "<none>");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
