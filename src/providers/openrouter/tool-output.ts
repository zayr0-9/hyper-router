import type {
  InputFile,
  InputText,
  OutputInputImage,
} from "@openrouter/agent";

export type OpenRouterToolOutputContent = Array<InputText | OutputInputImage | InputFile>;

export function toToolOutputValue(
  content: string,
): string | OpenRouterToolOutputContent {
  const parsed = tryParseJson(content);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("ok" in parsed)) {
    return content;
  }

  const toolResult = parsed as {
    ok?: boolean;
    output?: unknown;
    error?: unknown;
  };

  if (toolResult.ok === false) {
    return JSON.stringify({
      error: String(toolResult.error ?? "Tool execution failed."),
    });
  }

  if ("output" in toolResult) {
    return serializeToolPayload(toolResult.output);
  }

  return content;
}

export function serializeToolPayload(
  payload: unknown,
): string | OpenRouterToolOutputContent {
  if (isContentArray(payload)) {
    return payload;
  }

  return JSON.stringify(payload);
}

export function isContentArray(payload: unknown): payload is OpenRouterToolOutputContent {
  return (
    Array.isArray(payload) &&
    payload.length > 0 &&
    payload.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        (item.type === "input_text" || item.type === "input_image" || item.type === "input_file"),
    )
  );
}

export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
