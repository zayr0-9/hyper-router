# Agent Testing Context

Use this when validating changes, adding tests, or deciding which commands to run before reporting completion.

## Core commands

```bash
npm run check      # TypeScript no-emit check
npm test           # Full Vitest suite
npm run build      # Clean dist and compile build output
```

Before publishing or packaging, run at least:

```bash
npm run check
npm test
npm run build
```

`prepublishOnly` currently runs `npm run check && npm run build`.

## Targeted test map

Runtime behavior:

```bash
npx vitest run tests/runtime-storage.test.ts
npx vitest run tests/runtime-permissions.test.ts
npx vitest run tests/runtime-cancellation.test.ts
npx vitest run tests/runtime-tool-lifecycle.test.ts
```

Storage adapters:

```bash
npx vitest run tests/json-storage.test.ts
npx vitest run tests/sqlite-storage.test.ts
npx vitest run tests/postgres-storage.test.ts
```

Provider adapters:

```bash
npx vitest run tests/openrouter-provider.test.ts
npx vitest run tests/openrouter-continuation-strategy.test.ts
npx vitest run tests/openai-vai-provider.test.ts
npx vitest run tests/amazon-bedrock-vai-provider.test.ts
npx vitest run tests/glm-provider.test.ts
```

Run all tests when changing shared runtime/storage/provider contracts.

## What to test by change type

### Runtime changes

Validate:

- transcript construction and persistence
- resume from stored transcript
- `ephemeral` mode
- max-step behavior
- failure and partial transcript persistence
- canonical tool call IDs
- permission denials and permission request payloads
- lifecycle hook ordering/statuses
- cancellation propagation to providers and tools

Suggested commands:

```bash
npx vitest run tests/runtime-storage.test.ts tests/runtime-permissions.test.ts tests/runtime-cancellation.test.ts tests/runtime-tool-lifecycle.test.ts
npm run check
```

### Storage changes

Validate:

- system messages are not persisted
- dates round-trip as `Date` objects
- assistant text/reasoning/tool calls survive round-trip
- tool output `content`, `name`, and `toolCallId` survive round-trip
- metadata preserves standard and `custom` fields
- backend-specific setup/cleanup works

Suggested commands:

```bash
npx vitest run tests/runtime-storage.test.ts tests/json-storage.test.ts tests/sqlite-storage.test.ts tests/postgres-storage.test.ts
npm run check
```

### Provider changes

Validate:

- SDK messages convert correctly to provider input format
- tool definitions convert correctly
- provider tool calls normalize to SDK `ToolCall[]`
- assistant text is preserved
- assistant tool call ordering/IDs are preserved when available
- tool output replay shape is correct
- reasoning extraction/include options work
- finish reasons normalize correctly and raw provider reason is preserved
- generated images are surfaced when supported
- cancellation signal is passed where supported

Suggested commands:

```bash
npx vitest run tests/openrouter-provider.test.ts tests/openrouter-continuation-strategy.test.ts
npx vitest run tests/openai-vai-provider.test.ts tests/amazon-bedrock-vai-provider.test.ts tests/glm-provider.test.ts
npm run check
```

### Public API or export changes

Validate:

- `package.json` exports are updated
- `src/index.ts` or subpath `index.ts` exports are updated
- README and context docs reflect public usage
- build output compiles

Suggested commands:

```bash
npm run check
npm test
npm run build
```

## Unit testing conventions

- Runtime tests should use fake `ModelProvider` implementations.
- Provider tests should inject fake clients, fake fetch, or fake `generateTextImpl`.
- Unit tests must not hit live provider APIs.
- Assert normalized SDK shapes rather than only provider raw shapes.
- For permissions, assert both transcript output and hook payloads.
- For storage, assert loaded messages, not implementation internals only.
- For continuation, assert strategy behavior, state-store calls, and replay input shape.

## Live smoke scripts

Smoke scripts are manual integration checks that hit real provider APIs. They require credentials and should not be run unless the environment is configured.

OpenRouter:

```bash
npm run smoke:openrouter:text
npm run smoke:openrouter:tool
npm run smoke:openrouter:image
npm run smoke:openrouter:chain
npm run smoke:openrouter:runtime
```

Requires `OPENROUTER_API_KEY`.

OpenAI VAI:

```bash
npm run smoke:openai:text
npm run smoke:openai:tool
npm run smoke:openai:chain
```

Requires `OPENAI_API_KEY`.

GLM / Z.AI:

```bash
npm run smoke:glm:text
npm run smoke:glm:reasoning
npm run smoke:glm:tool
npm run smoke:glm:chain
```

Requires `ZAI_API_KEY`.

Amazon Bedrock VAI:

```bash
npm run smoke:amazon-bedrock-vai:text
npm run smoke:amazon-bedrock-vai:tool
npm run smoke:amazon-bedrock-vai:chain
npm run smoke:amazon-bedrock-vai:runtime
```

Requires valid AWS/Bedrock credentials such as `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`, or another supported credential/provider option.

## Examples and demos

Useful local demos:

```bash
npm run dev
npm run demo:json-resume
npm run demo:sqlite-resume
npm run demo:openrouter:gpt54-mini
npm run demo:openrouter:gpt54-mini:sqlite
```

OpenRouter demos require `OPENROUTER_API_KEY`.

## Reporting validation

When reporting completion, state exactly what ran and what happened. Do not claim a command passed unless you ran it and saw it pass.

For docs-only changes, it is acceptable to validate by reading the created/changed files and skip TypeScript/test commands with a note that no code changed.
