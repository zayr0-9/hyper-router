# Agent Providers Context

Use this when changing provider adapters, provider option types, message/tool conversion, reasoning extraction, image output handling, continuation state, or provider tests.

## Key files

- `src/core/providers.ts` — `ModelProvider` contract and `StubProvider`.
- `src/providers/vercel-ai/shared.ts` — shared Vercel AI SDK message/tool/reasoning conversion helpers.
- `src/providers/openrouter/provider.ts` — OpenRouter adapter.
- `src/providers/openrouter/items.ts` — SDK message to OpenRouter item conversion.
- `src/providers/openrouter/state.ts` — OpenRouter native state helpers.
- `src/providers/openrouter/types.ts` — OpenRouter options/state contracts.
- `src/providers/openai-vai/provider.ts` — OpenAI via Vercel AI SDK adapter.
- `src/providers/openai-vai/types.ts` — OpenAI VAI options.
- `src/providers/amazon-bedrock-vai/provider.ts` — Amazon Bedrock via Vercel AI SDK adapter.
- `src/providers/amazon-bedrock-vai/types.ts` — Bedrock VAI options.
- `src/providers/glm/provider.ts` — direct Z.AI/GLM chat-completions adapter.
- `src/providers/glm/types.ts` — GLM options.

## Provider contract

Providers implement `ModelProvider.generate(...)`:

```ts
interface ModelProvider {
  generate(input: {
    sessionId?: string;
    runId?: string;
    model: string;
    messages: Message[];
    tools: AnyToolDefinition[];
    previousSessionMetadata?: SessionMetadata | null;
    ephemeral?: boolean;
    signal?: AbortSignal;
  }): Promise<ModelResponse>;
}
```

Provider responsibilities:

- Convert SDK `Message[]` to provider-specific request/input format.
- Convert SDK tool definitions into provider tool schemas.
- Ask models to return tool calls; do not execute local tools remotely.
- Normalize provider tool calls into SDK `ToolCall[]`.
- Return assistant message content, reasoning, stop reasons, and generated images when available.
- Respect `signal` if the underlying provider supports cancellation.

Providers should not:

- execute local tools
- ask user permission for tools
- persist transcripts
- own application/harness UI or protocol behavior

## Shared response semantics

Normalize all provider outputs into SDK shapes from `src/core/types.ts`:

- `message?: Message`
- `toolCalls?: ToolCall[]`
- `stopReason?: StopReason`
- `providerStopReason?: string`
- `generatedImages?: GeneratedImage[]`

Keep these stable:

- Assistant messages may contain both text and tool calls.
- Provider-specific tool IDs should be preserved when available.
- Missing tool IDs can be canonicalized by runtime later.
- Reasoning/thinking output goes on `message.reasoningContent` when captured.
- Raw provider finish reasons should be exposed as `providerStopReason` when available.
- Normalized stop reasons should map into SDK `StopReason`.

## Tool schema handling

Shared schema normalization lives in `src/core/schema.ts`.

Current provider behavior:

- OpenAI VAI / Amazon Bedrock VAI accept Zod and JSON Schema through Vercel AI SDK tool conversion.
- OpenRouter currently requires Zod schemas and throws for JSON Schema.
- GLM/Z.AI accepts JSON Schema directly and converts Zod with `z.toJSONSchema(...)`.
- Missing schemas generally become permissive empty-object schemas.

## Reasoning options

`ReasoningOptions` are defined in `src/core/types.ts`:

- `false` disables reasoning where supported.
- `enabled`, `effort`, `budgetTokens` configure provider reasoning when mappable.
- `capture` controls whether returned reasoning is stored on assistant messages; default is true.
- `includeInMessages` controls whether prior stored reasoning is sent back during replay; default is true.

Reasoning support is provider-dependent and often best-effort except GLM, which maps Z.AI `reasoning_content` directly.

## OpenRouter provider

Files:

- `src/providers/openrouter/provider.ts`
- `src/providers/openrouter/items.ts`
- `src/providers/openrouter/state.ts`
- `src/providers/openrouter/types.ts`
- `src/providers/openrouter/tool-output.ts`

Implementation notes:

- Uses `@openrouter/agent`.
- Converts SDK messages to OpenRouter input items with `toInputItems(...)`.
- Converts tools with `openRouterTool({ execute: false })`; runtime executes tools locally.
- Requires Zod tool schemas today.
- Extracts text, tool calls, full response, image outputs, reasoning content, and provider stop reason.
- Image generation output items become `GeneratedImage[]` with either `dataUrl`/`mimeType` or `url`.

Continuation strategies:

- `transcript` — default without state store; sends transcript items each call.
- `state` — uses OpenRouter native `ConversationState`; bootstraps from external user/tool messages.
- `hybrid` — default when a `stateStore` is provided; combines transcript and native state.
- `ephemeral` — never attaches native state.

Native state details:

- `OpenRouterStateStore` supports `load`, `save`, optional `clear`.
- Default native state store is in-memory only.
- State envelopes include compatibility metadata: `model`, `promptHash`, `toolsetHash`.
- State invalidates when prompt hash or toolset hash changes.
- Model changes invalidate by default unless `invalidateOnModelChange: false`.
- Runtime `ephemeral: true` prevents state use for that run.

## OpenAI VAI provider

Files:

- `src/providers/openai-vai/provider.ts`
- `src/providers/openai-vai/types.ts`

Implementation notes:

- Uses Vercel AI SDK `generateText(...)` and `@ai-sdk/openai` `createOpenAI(...)`.
- Converts SDK messages/tools with `src/providers/vercel-ai/shared.ts` helpers.
- Normalizes Vercel tool calls back to SDK `ToolCall[]`.
- Supports API selection: `auto`, `responses`, `chat`, `completion`.
- Passes OpenAI-specific options under `providerOptions.openai`.
- Supports injected `provider` and `generateTextImpl` for tests.

## Amazon Bedrock VAI provider

Files:

- `src/providers/amazon-bedrock-vai/provider.ts`
- `src/providers/amazon-bedrock-vai/types.ts`

Implementation notes:

- Uses Vercel AI SDK `generateText(...)` and `@ai-sdk/amazon-bedrock` `createAmazonBedrock(...)`.
- Converts SDK messages/tools with shared Vercel AI helpers.
- Passes Bedrock-specific options under `providerOptions.bedrock`.
- Supports region, API key, AWS access keys/session token, credential provider, base URL, headers, custom fetch, max retries, and injected test implementations.

## GLM / Z.AI provider

Files:

- `src/providers/glm/provider.ts`
- `src/providers/glm/types.ts`

Implementation notes:

- Direct chat-completions provider, not Vercel AI SDK.
- Defaults to Z.AI general endpoint; supports `endpoint: "coding"`.
- API key comes from `apiKey` option or `ZAI_API_KEY`.
- Maps SDK messages to OpenAI-compatible chat messages.
- Sends prior `reasoningContent` as `reasoning_content` only when thinking is enabled and `clear_thinking === false`.
- Converts tools to OpenAI-compatible function tools.
- Supports `rawBody` escape hatch for provider-specific fields.
- Parses `reasoning_content`, `tool_calls`, and `finish_reason` from response.

## Shared Vercel AI helpers

File: `src/providers/vercel-ai/shared.ts`

Important helpers:

- `toAiSdkTools(...)`
- `toModelMessages(...)`
- `normalizeVercelToolCalls(...)`
- `readAssistantContent(...)`
- `readAssistantReasoningContent(...)`
- `normalizeFinishReason(...)`

When changing OpenAI and Bedrock behavior together, prefer shared helpers to avoid divergence.

## Provider tests

Use targeted tests:

```bash
npx vitest run tests/openrouter-provider.test.ts
npx vitest run tests/openrouter-continuation-strategy.test.ts
npx vitest run tests/openai-vai-provider.test.ts
npx vitest run tests/amazon-bedrock-vai-provider.test.ts
npx vitest run tests/glm-provider.test.ts
```

Testing conventions:

- Inject fake clients/fetch/generate functions.
- Do not make network calls in unit tests.
- Assert normalized SDK output, not only raw provider payloads.
- Cover replay/conversion edge cases: assistant text, tool call IDs, tool outputs, reasoning, generated images, finish reasons.
