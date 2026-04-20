# hyper-router

A minimal **TypeScript agent runtime SDK** with pluggable providers, tools, and storage.

## Goal

The goal of this SDK is to provide a lightweight, plug-and-play agent runtime for Node.js and VM-style workloads.

It gives you:

- a built-in tool-call loop with agentic behavior
- multiple model providers behind one runtime contract
- multiple storage backends for transcript persistence and resume flows
- a small surface area so you can focus on your product instead of provider/runtime glue

`hyper-router` is intentionally minimal, but it still aims to give you flexibility in how you configure agents, models, providers, storage, and continuation strategies.

## Current status

What exists today:

- a core `AgentRuntime` with a built-in tool loop
- a small `ModelProvider` abstraction
- a transcript-first `StorageAdapter` abstraction
- built-in storage adapters:
  - `InMemoryStorage`
  - `JsonStorage`
  - `SqliteStorage`
  - `PostgresStorage`
- built-in providers:
  - `OpenRouterProvider`
  - `OpenAIVAIProvider`
  - `AmazonBedrockVAIProvider`
- OpenRouter continuation modes:
  - `transcript`
  - `state`
  - `hybrid`
- transcript persistence and resume demos
- unit tests plus provider smoke scripts for local verification

What is not finished yet:

- additional storage backends beyond in-memory / JSON / SQLite / Postgres
- persistent OpenRouter native-state stores beyond the default in-memory implementation
- broader provider parity beyond the currently shipped OpenRouter, OpenAI, and Amazon Bedrock VAI providers
- broader replay and continuation validation across more providers and models

## Getting started

Requirements:

- Node.js 20+

Install and verify:

```bash
npm install
npm run check
npm test
npm run build
npm run dev
```

## Useful scripts

```bash
# quick demos
npm run demo:json-resume
npm run demo:sqlite-resume
npm run demo:openrouter:gpt54-mini
npm run demo:openrouter:gpt54-mini:sqlite

# OpenRouter smoke tests
npm run smoke:openrouter:text
npm run smoke:openrouter:tool
npm run smoke:openrouter:chain
npm run smoke:openrouter:runtime

# OpenAI VAI smoke tests
npm run smoke:openai:text
npm run smoke:openai:tool
npm run smoke:openai:chain

# Amazon Bedrock VAI smoke tests
npm run smoke:amazon-bedrock-vai:text
npm run smoke:amazon-bedrock-vai:tool
npm run smoke:amazon-bedrock-vai:chain
npm run smoke:amazon-bedrock-vai:runtime
```

## Project structure

```txt
src/
  core/
    agent.ts
    providers.ts
    runtime.ts
    storage.ts
    tool.ts
    types.ts
  providers/
    amazon-bedrock-vai/
      index.ts
      provider.ts
      types.ts
    openai-vai/
      index.ts
      provider.ts
      types.ts
    openrouter/
      index.ts
      items.ts
      provider.ts
      state.ts
      tool-output.ts
      types.ts
  storage/
    in-memory.ts
    json.ts
    sqlite.ts
    postgres.ts
    types.ts
    index.ts
  index.ts
examples/
  basic.ts
  json-resume-demo.ts
  sqlite-resume-demo.ts
  openrouter.ts
  openrouter-smoke.ts
  openrouter-tool-smoke.ts
  openrouter-tool-chain-smoke.ts
  openrouter-gpt54-mini-demo.ts
  openrouter-gpt54-mini-sqlite-demo.ts
  openai-smoke.ts
  openai-tool-smoke.ts
  openai-tool-chain-smoke.ts
  amazon-bedrock-vai.ts
  amazon-bedrock-vai-smoke.ts
  amazon-bedrock-vai-tool-smoke.ts
  amazon-bedrock-vai-tool-chain-smoke.ts
tests/
dist/
```

## Core concepts

- `defineAgent(...)` defines instructions, model, and tools
- `defineTool(...)` defines a callable tool
- `createRuntime(...)` wires agent + provider + storage together
- `ModelProvider` is the provider interface
- `StorageAdapter` is the current storage interface
- the canonical transcript is the durable conversation record

## Basic example

```ts
import {
  createRuntime,
  defineAgent,
  defineTool,
  InMemoryStorage,
  StubProvider,
} from "hyper-router";

const echoTool = defineTool<{ text: string }, { echoed: string }>({
  name: "echo",
  description: "Echo text back.",
  async execute(args) {
    return {
      ok: true,
      output: {
        echoed: args.text,
      },
    };
  },
});

const agent = defineAgent({
  name: "example-agent",
  instructions: "You are helpful.",
  model: "stub-model",
  tools: [echoTool],
});

const runtime = createRuntime({
  agent,
  provider: new StubProvider(),
  storage: new InMemoryStorage(),
});
```

Run the basic example:

```bash
npx tsx examples/basic.ts
```

## OpenRouter provider

This SDK includes an `OpenRouterProvider` implemented with `@openrouter/agent`.

Set your API key:

```bash
# PowerShell
$env:OPENROUTER_API_KEY="your_key_here"
```

Usage:

```ts
import {
  createRuntime,
  defineAgent,
  InMemoryStorage,
  OpenRouterProvider,
} from "hyper-router";

const agent = defineAgent({
  name: "my-agent",
  instructions: "You are helpful.",
  model: "openai/gpt-5-mini",
});

const runtime = createRuntime({
  agent,
  provider: new OpenRouterProvider(),
  storage: new InMemoryStorage(),
});
```

Run the OpenRouter runtime example locally:

```bash
npx tsx examples/openrouter.ts
```

### OpenRouter image outputs

When an OpenRouter image-capable model returns a final generated image, the provider exposes it on `ModelResponse.generatedImages`.

Example shape:

```ts
const result = await provider.generate({
  model: "google/gemini-2.5-flash-image",
  messages: [
    {
      role: "user",
      content: "Generate a small pixel-art red square.",
      date: new Date(),
    },
  ],
  tools: [],
});

console.log(result.generatedImages);
// [
//   {
//     dataUrl: "data:image/png;base64,...",
//     mimeType: "image/png"
//   }
// ]
```

This library does **not** save image files for you. It only exposes the final image payload so your website/app can store it however you want.

A browser helper for converting a `dataUrl` into a `Blob`:

```ts
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  if (!header || !base64) {
    throw new Error("Invalid data URL.");
  }

  const mimeType = /^data:([^;]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}
```

Example upload flow in a website:

```ts
const image = result.generatedImages?.[0];

if (image?.dataUrl) {
  const blob = dataUrlToBlob(image.dataUrl);
  const file = new File([blob], `generated-${Date.now()}.png`, {
    type: image.mimeType ?? blob.type ?? "image/png",
  });

  const formData = new FormData();
  formData.append("file", file);

  await fetch("/api/uploads", {
    method: "POST",
    body: formData,
  });
}
```

If the upstream provider returns a remote image URL instead of a data URL, it will be exposed as `generatedImages[].url`.

### OpenRouter replay contract

For transcript-backed continuation, replay should follow this rule:

- **store messages as received**
- **send them back as stored**
- avoid unnecessary transformations during replay

Recent OpenRouter replay fixes in this repo include:

- assistant text is preserved on replay instead of being dropped
- tool outputs are replayed exactly as stored
- transcript replay no longer depends on `StateAccessor` for correctness

### Canonical transcript invariants

If you want transcript-only resume to remain correct and cache-sensitive, keep these stable:

- message ordering
- assistant text preservation
- assistant tool call ordering
- exact tool result payloads
- `toolCallId` linkage between assistant tool calls and tool outputs
- stable message grouping/boundaries where possible

## OpenRouter continuation modes

`OpenRouterProvider` now supports three continuation strategies:

### 1. `transcript`

- persists and resumes from the canonical transcript
- does **not** use OpenRouter `StateAccessor`
- reconstructs provider input from transcript on each call

Use this when you want:

- provider portability
- maximum transcript auditability
- minimal provider-specific persistence coupling

### 2. `state`

- uses OpenRouter-native `ConversationState` via `StateAccessor`
- resumes natively from provider state when available
- still relies on transcript persistence in the runtime today, but continuation behavior prefers native state

Use this when you want:

- OpenRouter-native continuity
- approval/interruption-friendly resume semantics
- provider-specific continuation behavior

### 3. `hybrid`

- keeps transcript persistence
- also keeps OpenRouter native state
- prefers native state when valid
- falls back to transcript replay when native state is missing or invalid

This is the recommended OpenRouter production mode when you want both:

- canonical transcript history
- provider-native continuation optimization

### Example configuration

Transcript only:

```ts
const provider = new OpenRouterProvider({
  continuation: {
    strategy: "transcript",
  },
});
```

Native OpenRouter state:

```ts
const provider = new OpenRouterProvider({
  continuation: {
    strategy: "state",
    stateStore,
  },
});
```

Hybrid:

```ts
const provider = new OpenRouterProvider({
  continuation: {
    strategy: "hybrid",
    stateStore,
    invalidateOnModelChange: true,
  },
});
```

If you provide a `stateStore` but omit `strategy`, the provider defaults to `hybrid`.
If you provide neither, it defaults to `transcript`.

## OpenRouter native state storage

When native state is enabled, the provider persists an OpenRouter state envelope through `OpenRouterStateStore`.

Conceptually it looks like:

```ts
interface OpenRouterStateStore {
  load(sessionId: string): Promise<OpenRouterStateEnvelope | null>;
  save(sessionId: string, envelope: OpenRouterStateEnvelope): Promise<void>;
  clear?(sessionId: string): Promise<void>;
}

interface OpenRouterStateEnvelope {
  state: ConversationState;
  metadata?: {
    model?: string;
    promptHash?: string;
    toolsetHash?: string;
  };
}
```

The envelope stores:

- the OpenRouter SDK `ConversationState`
- compatibility metadata used for invalidation checks

## OpenRouter invalidation rules

When `strategy` is `state` or `hybrid`, native state is checked against session metadata before reuse.

### Always invalidates native state on:

- `promptHash` change
- `toolsetHash` change

### Optionally invalidates native state on:

- `model` change

This is controlled by:

```ts
continuation: {
  invalidateOnModelChange: true; // default
}
```

If `invalidateOnModelChange` is `false`, model changes alone do not clear native state.

### On invalidation

The provider:

- clears native OpenRouter state
- falls back to transcript replay
- rebuilds fresh native state afterward through `StateAccessor`

## OpenRouter limitations right now

- the default native-state store is in-memory only unless you provide a persistent `OpenRouterStateStore`
- that means native continuation is not durable across process restarts or serverless cold starts unless you back it with your own store
- transcript/storage APIs are still early and will likely evolve
- transcript replay is faithful enough for current resume and cache probes, but it is not guaranteed to be byte-identical to opaque provider-native state in every provider/model path

## Storage backends

The runtime storage contract is pluggable and transcript-first.

The canonical transcript remains the durable source of truth across providers. Provider-native continuation state, such as OpenRouter `ConversationState`, is treated as an optional optimization layer rather than the primary conversation record.

Built-in adapters currently available:

- `InMemoryStorage` - process-local storage for tests/dev
- `JsonStorage` - durable single-file JSON storage
- `SqliteStorage` - durable SQLite-file storage
- `PostgresStorage` - durable Postgres-backed storage for shared deployments

All of them implement the same `StorageAdapter` contract:

- `loadMessages(sessionId)`
- `saveMessages(sessionId, messages)`
- `saveRun(record)`
- optional `getSessionMetadata(sessionId)`
- optional `setSessionMetadata(sessionId, metadata)`

Session metadata remains optional in the storage contract, but it is used by OpenRouter native-state invalidation logic.

### Transcript semantics preserved by built-in adapters

The built-in storage backends preserve the same transcript behavior:

- system messages are filtered out on save
- message ordering is preserved
- `Date` values are restored on load
- tool calls and tool outputs round-trip as stored

### JSON example

```ts
import { JsonStorage } from "hyper-router";

const storage = new JsonStorage({
  filePath: "./tmp/agent-storage.json",
});
```

Run the JSON resume demo:

```bash
npm run demo:json-resume
```

### SQLite example

```ts
import { SqliteStorage } from "hyper-router";

const storage = new SqliteStorage({
  filePath: ".tmp/agent.sqlite",
});
```

Run the SQLite resume demo:

```bash
npm run demo:sqlite-resume
```

### Postgres example

```ts
import { PostgresStorage } from "hyper-router";

const storage = new PostgresStorage({
  connectionString: process.env.DATABASE_URL,
});
```

`PostgresStorage` stores transcript messages, run status, and session metadata in a single Postgres table using `jsonb` for transcript and metadata payloads.

### Developer context docs

Additional storage implementation notes live under:

- `docs/context/storage/README.md`
- `docs/context/storage/in-memory.md`
- `docs/context/storage/json.md`
- `docs/context/storage/sqlite.md`
- `docs/context/storage/postgres.md`
- `docs/context/storage/redis.md`

These docs capture the storage contract, canonical transcript invariants, and backend-specific guidance for current and future adapters.

## Real OpenRouter API smoke tests

These scripts hit the real OpenRouter API for manual integration testing.

Set your key first:

```bash
# PowerShell
$env:OPENROUTER_API_KEY="your_key_here"
```

Run the top-level smoke scripts:

```bash
npm run smoke:openrouter:text
npm run smoke:openrouter:tool
npm run smoke:openrouter:chain
npm run smoke:openrouter:runtime
```

What each script does:

- `smoke:openrouter:text` - verifies plain text generation works
- `smoke:openrouter:tool` - verifies the model emits a tool call for `echo(text)`
- `smoke:openrouter:chain` - runs transcript-resume and cache-oriented OpenRouter chain probes
- `smoke:openrouter:runtime` - runs the full runtime loop end to end and logs tool results

### `smoke:openrouter:chain` probe coverage

`examples/openrouter-tool-chain-smoke.ts` now includes multiple probes:

- **resume-transcript-tool-chain**  
  Starts a tool chain, persists transcript, creates a fresh runtime + fresh provider, and continues from transcript only.

- **cache-prefix-sensitivity**  
  Compares an exact repeated prefix against a reshaped-but-similar prefix to inspect cache sensitivity.

- **cache-state-accessor-tool-chain**  
  Uses one in-memory `StateAccessor` to inspect provider-native continuity behavior.

- **cache-transcript-shop-conversation** (`probe-d`)  
  Uses a realistic multi-turn tool-using agent conversation with a large stable system prompt to show cache reuse after transcript-only resume.

- **cache-transcript-shop-conversation-large-tool-output** (`probe-e`)  
  Uses a realistic multi-turn tool-using agent conversation with a small system prompt but a large persisted tool result to show cache reuse coming from transcripted tool history.

List the available chain probes:

```bash
npm run smoke:openrouter:chain -- --list
```

Run a single probe with the environment-variable selector:

```bash
# PowerShell
$env:OPENROUTER_SMOKE_ONLY="probe-d"
npm run smoke:openrouter:chain
```

You can also try npm argument forwarding:

```bash
npm run smoke:openrouter:chain -- --only=probe-e
```

If your shell/npm setup does not forward `--only=...` reliably, prefer `OPENROUTER_SMOKE_ONLY`.

## Current OpenRouter findings

From the current smoke and test work:

- transcript-only resume works semantically with a fresh runtime and fresh OpenRouter provider
- replay fidelity improved once assistant text and exact tool outputs were preserved
- OpenRouter cache usage is currently best read from `usage.inputTokensDetails.cachedTokens`
- exact prefix structure matters for visible cache reuse
- realistic transcript-only replay can preserve visible cache savings without `StateAccessor`
- both a large stable system prompt and a large persisted tool result can act as cacheable repeated prefix material

### Important caveat about cache results

Prompt cache behavior is provider/model dependent. A run showing `0` cached tokens is not automatically proof of replay failure. Visible cache reuse can vary with:

- provider routing
- cache thresholds or block sizing
- model behavior
- internal OpenRouter/provider decisions
- how much repeated stable prefix exists

## Publishing notes

This package layout is npm-friendly because:

- the package entrypoint exports library code only
- examples are kept separate from published source
- build output is isolated in `dist/`
- `prepublishOnly` validates the package before publish

## OpenAI VAI provider

This SDK also includes an `OpenAIVAIProvider` implemented on top of the Vercel AI SDK using `ai` and `@ai-sdk/openai`.

Set your API key:

```bash
# PowerShell
$env:OPENAI_API_KEY="your_key_here"
```

Usage:

```ts
import {
  createRuntime,
  defineAgent,
  InMemoryStorage,
  OpenAIVAIProvider,
} from "hyper-router";

const agent = defineAgent({
  name: "my-openai-agent",
  instructions: "You are helpful.",
  model: "gpt-5-mini",
});

const runtime = createRuntime({
  agent,
  provider: new OpenAIVAIProvider(),
  storage: new InMemoryStorage(),
});
```

### OpenAI VAI provider architecture notes

The OpenAI VAI provider follows the same runtime-facing `ModelProvider` contract as `OpenRouterProvider`, but delegates model execution to Vercel AI SDK `generateText(...)`.

Important implementation details:

- canonical runtime messages are converted into AI SDK `ModelMessage[]`
- assistant tool calls are preserved as assistant `tool-call` content parts
- tool outputs are replayed as AI SDK `tool-result` message parts
- the provider reads assistant text back from `response.messages`
- model tool calls are normalized back into the SDK's `ToolCall[]` shape

### OpenAI VAI API selection

`OpenAIVAIProvider` supports selecting which Vercel OpenAI model factory to use:

- `auto` - uses `openai(model)`
- `responses` - uses `openai.responses(model)`
- `chat` - uses `openai.chat(model)`
- `completion` - uses `openai.completion(model)`

Example:

```ts
const provider = new OpenAIVAIProvider({
  api: "responses",
  providerOptions: {
    parallelToolCalls: false,
    store: false,
    user: "user_123",
  },
});
```

This maps directly to documented Vercel AI SDK OpenAI provider behavior, so if additional OpenAI provider options are needed later they should be passed through `providerOptions` rather than re-modeled in the runtime itself.

### OpenAI VAI smoke tests

```bash
npm run smoke:openai:text
npm run smoke:openai:tool
npm run smoke:openai:chain
```

These scripts are intended for live API verification and require `OPENAI_API_KEY`.

## Amazon Bedrock VAI provider

This SDK also includes an `AmazonBedrockVAIProvider` implemented on top of the Vercel AI SDK using `ai` and `@ai-sdk/amazon-bedrock`.

Set your AWS credentials and region:

```bash
# PowerShell
$env:AWS_REGION="us-east-1"
$env:AWS_ACCESS_KEY_ID="your_access_key"
$env:AWS_SECRET_ACCESS_KEY="your_secret_key"
```

You can also use Bedrock bearer-token auth or an AWS credential provider chain via provider options supported by `createAmazonBedrock(...)`.

Usage:

```ts
import {
  AmazonBedrockVAIProvider,
  createRuntime,
  defineAgent,
  InMemoryStorage,
} from "hyper-router";

const agent = defineAgent({
  name: "my-bedrock-agent",
  instructions: "You are helpful.",
  model: "meta.llama3-70b-instruct-v1:0",
});

const runtime = createRuntime({
  agent,
  provider: new AmazonBedrockVAIProvider({
    region: "us-east-1",
  }),
  storage: new InMemoryStorage(),
});
```

### Amazon Bedrock VAI provider architecture notes

The Bedrock VAI provider follows the same runtime-facing `ModelProvider` contract as the OpenRouter and OpenAI providers, while delegating model execution to Vercel AI SDK `generateText(...)` with `@ai-sdk/amazon-bedrock`.

Important implementation details:

- canonical runtime messages are converted into AI SDK `ModelMessage[]`
- assistant tool calls are preserved as assistant `tool-call` content parts
- tool outputs are replayed as AI SDK `tool-result` message parts
- the provider reads assistant text back from `response.messages`
- model tool calls are normalized back into the SDK's `ToolCall[]` shape
- Bedrock provider configuration is forwarded through `createAmazonBedrock(...)`
- Bedrock language-model provider options are forwarded under `providerOptions.bedrock`

### Amazon Bedrock VAI provider options

`AmazonBedrockVAIProvider` supports the documented Bedrock provider setup fields exposed by the Vercel AI SDK, including:

- `region`
- `apiKey`
- `accessKeyId`
- `secretAccessKey`
- `sessionToken`
- `credentialProvider`
- `baseURL`
- `headers`
- `fetch`
- `maxRetries`
- `providerOptions`

Example:

```ts
const provider = new AmazonBedrockVAIProvider({
  region: "us-east-1",
  providerOptions: {
    reasoningConfig: {
      type: "enabled",
      budgetTokens: 1024,
    },
  },
});
```

This maps directly to documented Vercel AI SDK Amazon Bedrock provider behavior, so additional Bedrock-specific request settings should be passed through `providerOptions` rather than re-modeled in the runtime itself.

### Amazon Bedrock VAI smoke tests

```bash
npm run smoke:amazon-bedrock-vai:text
npm run smoke:amazon-bedrock-vai:tool
npm run smoke:amazon-bedrock-vai:chain
npm run smoke:amazon-bedrock-vai:runtime
```

These scripts are intended for live API verification and require valid AWS Bedrock credentials.

A runtime-style example similar to the broader provider demos is also included at `examples/amazon-bedrock-vai.ts`.
