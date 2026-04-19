# simple-agent

A minimal **TypeScript agent runtime SDK** with pluggable providers, tools, and storage.

## Current status

What exists today:

- a core `AgentRuntime` with a basic tool loop
- a small `ModelProvider` abstraction
- a small `StorageAdapter` abstraction
- `InMemoryStorage` for local/dev use
- a working `OpenRouterProvider` built on `@openrouter/agent`
- transcript persistence suitable for in-process resume flows
- examples and smoke scripts for local verification
- tests and smokes covering OpenRouter transcript replay behavior

What is not finished yet:

- durable transcript persistence for serverless/cloud usage
- storage adapters beyond in-memory
- additional real providers beyond OpenRouter
- durable provider-native continuation state persistence
- broader provider parity and replay validation across more models

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
    openrouter/
      index.ts
      items.ts
      provider.ts
      state.ts
      tool-output.ts
      types.ts
  index.ts
examples/
  basic.ts
  openrouter.ts
  openrouter-smoke.ts
  openrouter-tool-smoke.ts
  openrouter-tool-chain-smoke.ts
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
} from "simple-agent";

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
} from "simple-agent";

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
  invalidateOnModelChange: true // default
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
