# hyper-router Project Context

This file is intended as a quick project briefing for future agents. Read it before starting work so you do not need to rediscover the repo with `rg`/`glob` every time.

## What this project is

`hyper-router` is a minimal Node-first TypeScript agent runtime SDK. It provides:

- a small `AgentRuntime` with a built-in multi-step tool-call loop
- a `ModelProvider` abstraction for wrapping AI providers behind one runtime contract
- a `StorageAdapter` abstraction for transcript persistence and session resume
- tool definitions via `defineTool(...)`
- agent definitions via `defineAgent(...)`
- multiple providers and storage backends

The SDK is intentionally transcript-first. The durable canonical conversation is a list of SDK `Message` objects saved by a storage adapter. Provider-specific state may exist, but the runtime always works from normalized SDK messages.

## Key commands

```bash
npm install
npm run check      # TypeScript no-emit check
npm test           # Vitest suite
npm run build      # clean + tsc build
```

Useful smoke scripts require provider API keys:

```bash
npm run smoke:openrouter:text
npm run smoke:openrouter:tool
npm run smoke:openrouter:chain

npm run smoke:openai:text
npm run smoke:openai:tool
npm run smoke:openai:chain

npm run smoke:glm:text
npm run smoke:glm:tool
npm run smoke:glm:chain

npm run smoke:amazon-bedrock-vai:text
npm run smoke:amazon-bedrock-vai:tool
npm run smoke:amazon-bedrock-vai:chain
npm run smoke:amazon-bedrock-vai:runtime
```

## Repository layout

```txt
src/
  index.ts                         Root exports: core types/tools/agent/provider/runtime,
                                   in-memory/json storage, and GLM provider.

  core/
    types.ts                       Core SDK shapes: Message, ToolCall, ModelResponse,
                                   RunStatus, GeneratedImage, etc.
    agent.ts                       AgentDefinition and defineAgent(...).
    tool.ts                        ToolDefinition and defineTool(...).
    providers.ts                   ModelProvider interface and StubProvider.
    runtime.ts                     AgentRuntime and createRuntime(...). Main tool loop.
    schema.ts                      Shared schema detection/normalization helpers.
    storage.ts                     Re-export of storage/index.ts.

  storage/
    types.ts                       StorageAdapter, RunRecord, SessionMetadata.
    in-memory.ts                   Map-backed storage for tests/demos.
    json.ts                        JSON file-backed transcript/session storage.
    sqlite.ts                      sql.js-backed SQLite storage.
    postgres.ts                    pg-backed Postgres storage.
    index.ts                       Storage exports.

  providers/
    openrouter/
      provider.ts                  OpenRouterProvider implementation.
      items.ts                     SDK Message -> OpenRouter input item conversion.
      state.ts                     OpenRouter native state sync/continuation helpers.
      tool-output.ts               Tool output conversion helpers.
      types.ts                     OpenRouter continuation/state option types.
      index.ts

    openai-vai/
      provider.ts                  OpenAIVAIProvider using Vercel AI SDK + @ai-sdk/openai.
      types.ts
      index.ts

    amazon-bedrock-vai/
      provider.ts                  AmazonBedrockVAIProvider using Vercel AI SDK.
      types.ts
      index.ts

    glm/
      provider.ts                  Direct Z.AI/GLM chat completions provider.
      types.ts
      index.ts

examples/                          Demos and smoke scripts for storage/providers.
tests/                             Vitest tests for runtime, storage, and providers.
```

Package exports in `package.json` expose provider/storage subpaths such as:

```ts
@hyper-labs/hyper-router/providers/openrouter
@hyper-labs/hyper-router/providers/openai-vai
@hyper-labs/hyper-router/providers/amazon-bedrock-vai
@hyper-labs/hyper-router/providers/glm
@hyper-labs/hyper-router/storage/sqlite
@hyper-labs/hyper-router/storage/postgres
```

## Core data types

### `Message`

Defined in `src/core/types.ts`.

```ts
interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoningContent?: string;
  name?: string;
  date: Date;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}
```

Important notes:

- `reasoningContent` stores provider reasoning/thinking output when available.
- Tool result messages use `role: "tool"`, `name`, `toolCallId`, and JSON-stringified `content`.
- Assistant messages may contain `toolCalls` and empty `content`.
- System messages are inserted by runtime for the active run but are not persisted in transcript storage.

### `ToolCall`

```ts
interface ToolCall {
  id?: string;
  toolName: string;
  args: unknown;
}
```

Runtime canonicalizes missing tool call ids to:

```txt
${toolName}-${step}-${index}
```

### `ModelProvider`

Defined in `src/core/providers.ts`.

```ts
interface ModelProvider {
  generate(input: {
    sessionId?: string;
    model: string;
    messages: Message[];
    tools: AnyToolDefinition[];
    previousSessionMetadata?: SessionMetadata | null;
    ephemeral?: boolean;
  }): Promise<ModelResponse>;
}
```

All providers must normalize their provider-specific responses into `ModelResponse`.

### `StorageAdapter`

Defined in `src/storage/types.ts`.

```ts
interface StorageAdapter {
  loadMessages(sessionId: string): Promise<Message[]>;
  saveMessages(sessionId: string, messages: Message[]): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
  getSessionMetadata?(sessionId: string): Promise<SessionMetadata | null>;
  setSessionMetadata?(sessionId: string, metadata: SessionMetadata): Promise<void>;
}
```

`SessionMetadata` includes standard metadata such as `agentName`, `model`, `promptHash`, `promptSnapshot`, `toolsetHash`, `updatedAt`, plus optional `custom` metadata.

## Runtime data flow

Main implementation: `src/core/runtime.ts`.

1. `runtime.run({ sessionId, input, maxSteps, ephemeral })` starts.
2. If not ephemeral, runtime loads previous transcript messages from storage and filters out any `system` messages.
3. Runtime loads session metadata if supported by storage.
4. Runtime builds new base input messages:
   - if `agent.buildMessages` exists, call it
   - otherwise create one user message from `input.input`
5. Runtime prepends current system instructions:
   ```ts
   { role: "system", content: agent.instructions, date: new Date() }
   ```
6. Runtime loops up to `maxSteps` defaulting to 5:
   - calls `provider.generate(...)` with current messages, model, tools, metadata, and ephemeral flag
   - canonicalizes tool call ids
   - appends provider assistant message if returned
   - appends generated images to result if returned
   - if no tool calls: status becomes `completed` and loop stops
   - if tool calls exist: execute local tools and append `tool` messages
7. At end, if not ephemeral, runtime persists:
   - transcript messages excluding system messages
   - run record/status
   - updated session metadata
8. Return `RuntimeResult` containing `status`, full in-run `messages`, and optional `generatedImages`.

Failure behavior:

- If provider/tool loop throws, status becomes `failed`.
- Non-ephemeral runs persist current state before rethrowing.

## Tool system

Main file: `src/core/tool.ts`.

Tools are defined with:

```ts
defineTool<TArgs, TOutput>({
  name: "tool_name",
  description: "...",
  inputSchema: z.object({ ... }) /* or JSON Schema for compatible providers */,
  async execute(args, context) {
    return { ok: true, output: ... };
  },
});
```

Tool execution returns `ToolResult`:

```ts
{ ok: true, output?: T }
{ ok: false, error: string }
```

Runtime catches thrown tool errors and converts them into failed tool result messages rather than crashing the run.

## Schema handling

Main file: `src/core/schema.ts`.

`normalizeSchema(input)` returns one of:

- `{ kind: "none" }`
- `{ kind: "zod", schema }`
- `{ kind: "json-schema", schema }`

Provider behavior differs:

- OpenAI VAI / Amazon Bedrock VAI: accept Zod or JSON Schema through Vercel AI SDK `tool(...)`.
- OpenRouter: currently requires Zod schemas; JSON Schema throws a provider-specific error.
- GLM direct: accepts JSON Schema directly and converts Zod via `z.toJSONSchema(...)`.

## Storage systems

Storage adapters persist normalized SDK messages. They should preserve:

- `role`
- `content`
- `date`
- `reasoningContent`
- `name`
- `toolCallId`
- `toolCalls`

Backends:

- `InMemoryStorage`: simple Map-backed storage, useful for tests/demos.
- `JsonStorage`: file-backed JSON storage.
- `SqliteStorage`: sql.js-backed SQLite storage.
- `PostgresStorage`: pg-backed Postgres storage.

Important convention: system messages are not persisted. Runtime re-adds current agent instructions every run.

## Provider systems

### OpenAI VAI provider

File: `src/providers/openai-vai/provider.ts`.

Uses:

- `ai` package `generateText`
- `@ai-sdk/openai` `createOpenAI`

Responsibilities:

- Convert SDK `Message[]` to Vercel AI SDK `ModelMessage[]`.
- Convert SDK tools to AI SDK tools.
- Normalize returned tool calls.
- Extract assistant text from AI SDK assistant message parts.
- Best-effort extract reasoning from AI SDK message parts, provider metadata/options, and raw response body paths when exposed.

API modes:

```ts
"auto" | "responses" | "chat" | "completion"
```

Options include `providerOptions`, `maxRetries`, custom `provider`, custom `generateTextImpl`, OpenAI headers/org/project/baseURL, etc.

### Amazon Bedrock VAI provider

File: `src/providers/amazon-bedrock-vai/provider.ts`.

Similar architecture to OpenAI VAI provider but uses `@ai-sdk/amazon-bedrock`. It converts messages/tools through Vercel AI SDK and does best-effort reasoning extraction from assistant parts/provider metadata.

### OpenRouter provider

File: `src/providers/openrouter/provider.ts`.

Uses `@openrouter/agent`.

Key features:

- Converts SDK messages to OpenRouter input items via `providers/openrouter/items.ts`.
- Converts tools using `openRouterTool(...)` with `execute: false`; local runtime executes tools.
- Normalizes OpenRouter tool calls to SDK `ToolCall[]`.
- Extracts generated images from `image_generation_call` output items into `GeneratedImage[]`.
- Best-effort extracts reasoning from response output fields.
- Supports continuation strategies:
  - `transcript`: send full transcript each call
  - `state`: use OpenRouter native state
  - `hybrid`: state plus transcript sync
  - `ephemeral`: no state

OpenRouter state metadata includes model/prompt/toolset hashes and can invalidate state on model/prompt/tool changes.

### GLM / Z.AI provider

File: `src/providers/glm/provider.ts`.

Current implementation is direct Z.AI chat completions, not Vercel AI SDK.

Endpoint defaults:

```txt
general: https://api.z.ai/api/paas/v4/chat/completions
coding:  https://api.z.ai/api/coding/paas/v4/chat/completions
```

Options:

```ts
interface GLMProviderOptions {
  apiKey?: string;              // defaults to process.env.ZAI_API_KEY
  baseURL?: string;
  endpoint?: "general" | "coding";
  thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
  rawBody?: Record<string, unknown>;
  headers?: [string, string][] | Record<string, string>;
  fetch?: typeof fetch;
}
```

Request mapping:

- SDK `Message[]` -> Z.AI chat `messages`.
- Assistant `reasoningContent` is sent as `reasoning_content` only when:
  ```ts
  thinking: { type: "enabled", clear_thinking: false }
  ```
- SDK tools -> OpenAI-compatible function tools:
  ```json
  { "type": "function", "function": { "name": "...", "description": "...", "parameters": { ... } } }
  ```
- `rawBody` is spread into the request body for provider-specific fields such as `parallel_tool_calls`, `tool_choice`, etc.

Response mapping:

- `choices[0].message.content` -> assistant `content`
- `choices[0].message.reasoning_content` -> assistant `reasoningContent`
- `choices[0].message.tool_calls` -> SDK `ToolCall[]`
- `choices[0].finish_reason` -> `stopReason`

Important: GLM no longer has a shared `currentRawResponses` capture array. Reasoning is parsed directly from the response inside each `generate()` call, avoiding cross-session/concurrency leakage.

## Reasoning content model

The SDK stores provider reasoning output on assistant messages:

```ts
message.reasoningContent?: string
```

Current support:

- GLM: direct and strongest support via Z.AI `reasoning_content`.
- OpenAI VAI: best-effort extraction from AI SDK message parts/metadata/raw body fields if exposed.
- Amazon Bedrock VAI: best-effort extraction from AI SDK message parts/metadata.
- OpenRouter: best-effort extraction from response output fields.

Storage adapters persist `reasoningContent` as part of the transcript. GLM can optionally send prior reasoning back to Z.AI when `thinking.clear_thinking === false`.

## Tests map

```txt
tests/runtime-storage.test.ts               AgentRuntime persistence, metadata, reasoning persistence.
tests/json-storage.test.ts                  JsonStorage behavior.
tests/sqlite-storage.test.ts                SqliteStorage behavior.
tests/postgres-storage.test.ts              PostgresStorage behavior.
tests/openai-vai-provider.test.ts           OpenAI VAI conversion/tool/reasoning behavior.
tests/amazon-bedrock-vai-provider.test.ts   Bedrock VAI conversion/tool/reasoning behavior.
tests/openrouter-provider.test.ts           OpenRouter conversion/tool/image/reasoning behavior.
tests/openrouter-continuation-strategy.test.ts OpenRouter transcript/state/hybrid continuation.
tests/glm-provider.test.ts                  Direct Z.AI request/response/tool/reasoning behavior.
```

## Development conventions and gotchas

- This repo uses ESM and `moduleResolution: "NodeNext"`; relative TS imports include `.js` extensions.
- `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` are enabled. Avoid assigning explicit `undefined` to optional properties; conditionally spread instead.
- Keep provider outputs normalized to SDK core types. Runtime should not need provider-specific branches.
- Runtime persists transcript excluding system messages. Do not rely on system messages being loaded from storage.
- For provider tests, inject fake clients/fetch/generate implementations instead of making network calls.
- If adding provider-specific options, prefer typed options for common fields and `rawBody`/equivalent escape hatch for uncommon provider fields.
- For storage changes, update all storage adapters and tests together.
- For new public files, update `package.json` exports if they should be importable by consumers.
- Root export currently includes core, in-memory/json storage, and GLM provider. Heavier providers/storage are available via subpath exports.

## Current validation status at time of writing

After the direct GLM provider migration:

```txt
npm run check  ✅
npm test       ✅ 9 test files, 71 tests
```

Recommended before provider-related commits:

```bash
npm run check
npm test
```

Recommended before release when API keys are available:

```bash
npm run smoke:glm:text
npm run smoke:glm:tool
npm run smoke:glm:chain
npm run smoke:openai:text
npm run smoke:openai:tool
npm run smoke:openai:chain
npm run smoke:openrouter:text
npm run smoke:openrouter:tool
npm run smoke:openrouter:chain
```
