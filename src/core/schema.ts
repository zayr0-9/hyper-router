export type NormalizedSchema =
  | { kind: "none" }
  | { kind: "zod"; schema: unknown }
  | { kind: "json-schema"; schema: Record<string, unknown> };

export function isZodSchema(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { safeParse?: unknown }).safeParse === "function" &&
      typeof (value as { parse?: unknown }).parse === "function",
  );
}

export function isJsonSchemaLike(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const schema = value as Record<string, unknown>;
  return (
    schema.type !== undefined ||
    schema.properties !== undefined ||
    schema.required !== undefined ||
    schema.additionalProperties !== undefined ||
    schema.items !== undefined ||
    schema.anyOf !== undefined ||
    schema.oneOf !== undefined ||
    schema.allOf !== undefined ||
    schema.enum !== undefined
  );
}

export function normalizeSchema(input: unknown): NormalizedSchema {
  if (input == null) {
    return { kind: "none" };
  }

  if (isZodSchema(input)) {
    return { kind: "zod", schema: input };
  }

  if (isJsonSchemaLike(input)) {
    return { kind: "json-schema", schema: input };
  }

  throw new Error(
    "Invalid tool inputSchema: expected Zod schema, JSON Schema object, or undefined.",
  );
}
