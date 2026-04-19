# simple-agent

A minimal **Node-first TypeScript SDK boilerplate** for building an agent runtime.

## What is included

- library entrypoint in `src/index.ts`
- core SDK implementation under `src/core/`
- example usage under `examples/`
- build config for publishing
- generated type declarations in `dist/`

## Getting started

```bash
npm install
npm run check
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
  index.ts
examples/
  basic.ts
dist/
```

## Publishing notes

This layout is better for npm publishing because:

- the package entrypoint exports library code only
- examples are kept separate from published source
- build output is isolated in `dist/`
- `prepublishOnly` validates the package before publish

## Example usage

```ts
import {
  createRuntime,
  defineAgent,
  defineTool,
  InMemoryStorage,
  StubProvider,
} from "simple-agent";
```

## OpenRouter provider adapter

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

Run example locally:

```bash
npx tsx examples/openrouter.ts
```

## Real OpenRouter API smoke tests

These scripts hit the real OpenRouter API and are useful for manual integration testing.

Set your key first:

```bash
# PowerShell
$env:OPENROUTER_API_KEY="your_key_here"
```

Run the smoke tests:

```bash
npm run smoke:openrouter:text
npm run smoke:openrouter:tool
npm run smoke:openrouter:chain
npm run smoke:openrouter:runtime
```

What each script does:

- `smoke:openrouter:text` - verifies plain text generation works
- `smoke:openrouter:tool` - verifies the model emits a tool call for `echo(text)`
- `smoke:openrouter:chain` - verifies a dependent multi-step tool chain executes in order
- `smoke:openrouter:runtime` - runs the full runtime loop end to end and logs tool results
