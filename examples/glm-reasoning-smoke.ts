import { GLMProvider } from "../src/providers/glm/index.js";
import type { Message } from "../src/index.js";

async function main(): Promise<void> {
  if (!process.env.ZAI_API_KEY) {
    throw new Error("Missing ZAI_API_KEY. Set it before running this script.");
  }

  const provider = new GLMProvider({
    apiKey: process.env.ZAI_API_KEY,
    ...(process.env.ZAI_BASE_URL ? { baseURL: process.env.ZAI_BASE_URL } : {}),
    reasoning: {
      enabled: true,
      effort: "high",
      capture: true,
      includeInMessages: true,
    },
  });

  const messages: Message[] = [
    {
      role: "user",
      content:
        "Think carefully, then answer with exactly: REASONING_SMOKE_OK",
      date: new Date(),
    },
  ];

  console.log("Running GLM/Z.AI reasoning smoke test...");

  const result = await provider.generate({
    model: process.env.ZAI_MODEL ?? "glm-5.1",
    messages,
    tools: [],
  });

  console.log("Result:\n", JSON.stringify(result, null, 2));
  console.log("Reasoning content:\n", result.message?.reasoningContent ?? "<none>");

  if (!result.message?.content.includes("REASONING_SMOKE_OK")) {
    throw new Error(
      `Smoke test failed: expected response to include REASONING_SMOKE_OK, got: ${result.message?.content ?? "<none>"}`,
    );
  }

  if (!result.message.reasoningContent?.trim()) {
    throw new Error("Smoke test failed: expected reasoningContent to be captured.");
  }

  console.log("✅ GLM/Z.AI reasoning smoke test passed.");
}

main().catch((error) => {
  console.error("❌ GLM/Z.AI reasoning smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
