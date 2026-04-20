import { OpenRouter, type OutputImageGenerationCallItem } from "@openrouter/agent";

const MODEL = "google/gemini-2.5-flash-image";

function isImageGenerationItem(item: { type: string }): item is OutputImageGenerationCallItem {
  return item.type === "image_generation_call";
}

function summarizeImageResult(result: string | null | undefined): string {
  if (!result) {
    return "<empty>";
  }

  if (result.startsWith("data:")) {
    const [prefix] = result.split(",", 1);
    return `${prefix},...`;
  }

  if (result.startsWith("http://") || result.startsWith("https://")) {
    return result;
  }

  return `${result.slice(0, 80)}${result.length > 80 ? "..." : ""}`;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY. Set it before running this script.");
  }

  const client = new OpenRouter({ apiKey });

  console.log("Running OpenRouter image smoke test...");
  console.log(`Model: ${MODEL}`);

  const result = client.callModel({
    model: MODEL,
    input: "Generate a tiny pixel-art style red square on a white background and include a one-sentence caption.",
    modalities: ["image", "text"],
    store: false,
  });

  const [text, response] = await Promise.all([
    result.getText(),
    result.getResponse(),
  ]);

  const outputTypes = response.output.map((item) => item.type);
  const imageItems = response.output.filter(isImageGenerationItem);

  console.log("Response output item types:", outputTypes);
  console.log("Assistant text:", text || "<none>");

  if (imageItems.length === 0) {
    console.error("Full response output:\n", JSON.stringify(response.output, null, 2));
    throw new Error(
      `Smoke test failed: expected at least one image_generation_call item, got [${outputTypes.join(", ")}].`,
    );
  }

  const firstImage = imageItems[0];
  if (!firstImage) {
    throw new Error("Smoke test failed: first image item missing unexpectedly.");
  }

  console.log("First image item type:", firstImage.type);
  console.log("First image item status:", firstImage.status);
  console.log("First image result preview:", summarizeImageResult(firstImage.result));

  if (firstImage.type !== "image_generation_call") {
    throw new Error(
      `Smoke test failed: expected first image item type to be image_generation_call, got ${firstImage.type}.`,
    );
  }

  if (!firstImage.result) {
    throw new Error("Smoke test failed: expected image_generation_call result to contain image data or URL.");
  }

  console.log("✅ OpenRouter image smoke test passed.");
  console.log("Reported image item type: image_generation_call");
}

main().catch((error) => {
  console.error("❌ OpenRouter image smoke test failed.");
  console.error(error);
  process.exitCode = 1;
});
