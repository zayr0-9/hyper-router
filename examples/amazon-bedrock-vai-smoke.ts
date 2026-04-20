import { AmazonBedrockVAIProvider } from "../src/index.js";
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

  const messages: Message[] = [
    {
      role: "user",
      content: "Reply with exactly: TEST_OK",
      date: new Date(),
    },
  ];

  console.log("Running Amazon Bedrock VAI text smoke test...");

  const result = await provider.generate({
    model: "meta.llama3-70b-instruct-v1:0",
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
    throw new Error(
      `Smoke test failed: expected response to include TEST_OK, got: ${result.message.content}`,
    );
  }

  console.log("✅ Amazon Bedrock VAI text smoke test passed.");
}

main().catch((error) => {
  console.error("❌ Amazon Bedrock VAI text smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
