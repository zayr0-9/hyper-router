import { OpenRouterProvider } from "../src/providers/openrouter/index.js";
import type { Message } from "../src/index.js";

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY. Set it before running this script.");
  }

  const provider = new OpenRouterProvider();

  const messages: Message[] = [
    {
      role: "user",
      content: "Reply with exactly: TEST_OK",
      date: new Date(),
    },
  ];

  console.log("Running OpenRouter text smoke test...");

  const result = await provider.generate({
    model: "openai/gpt-5-mini",
    messages,
    tools: [],
  });

  console.log("Result:\n", JSON.stringify(result, null, 2));

  if (!result.message?.content) {
    throw new Error("Smoke test failed: expected assistant message content.");
  }

  if ((result.toolCalls?.length ?? 0) !== 0) {
    throw new Error("Smoke test failed: expected no tool calls.");
  }

  if (!result.message.content.includes("TEST_OK")) {
    throw new Error(`Smoke test failed: expected response to include TEST_OK, got: ${result.message.content}`);
  }

  console.log("✅ OpenRouter text smoke test passed.");
}

main().catch((error) => {
  console.error("❌ OpenRouter text smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
