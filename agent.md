# Agent Context

This file is the root briefing for AI coding agents working in `hyper-router`. Read it before making changes, then open the focused `agent_*.md` files for the subsystem you are touching.

## What this project is

`hyper-router` is a minimal Node-first TypeScript agent runtime SDK. It is a pure SDK wrapper around provider libraries: it handles the reusable agent runtime, local tool loop, provider normalization, and transcript/storage abstractions while staying independent of any terminal UI, web UI, or product harness.

The SDK owns:

- agent definitions and system instructions
- provider abstraction and model response normalization
- transcript-first runtime execution
- local tool execution
- host-mediated tool permission hooks
- transcript/run/session persistence through storage adapters

The SDK must not own:

- UI rendering, keybindings, modals, or app navigation
- product-specific slash commands or workflows
- harness-specific protocols such as JSON-lines event shapes
- credentials management beyond provider option/env lookups

## Read order

1. `README.md` — user-facing overview, examples, and current behavior.
2. `agent_runtime.md` — runtime loop, tools, permissions, hooks, cancellation.
3. `agent_storage.md` — transcript persistence and storage adapter semantics.
4. `agent_providers.md` — provider adapter contracts and provider-specific notes.
5. `agent_testing.md` — validation commands, test map, and smoke scripts.
6. `docs/context/storage/*.md` — deeper storage backend notes.

Existing broader context files may also be useful:

- `AGENTS.md`
- `CONTEXT.md`

## High-level project map

```txt
src/
  core/                 Agent/runtime/tool/provider contracts and shared types.
  providers/            OpenRouter, OpenAI VAI, Amazon Bedrock VAI, GLM/Z.AI adapters.
  storage/              In-memory, JSON, SQLite, Postgres storage adapters and types.
  index.ts              Root public exports.
examples/               Demos and live provider smoke scripts.
tests/                  Vitest coverage for runtime, storage, providers, continuation.
docs/context/storage/   Backend-specific storage implementation notes.
```

## Architectural boundaries

- `AgentRuntime` owns the multi-step tool-call loop and local tool execution.
- Providers implement `ModelProvider.generate(...)`; they normalize provider-specific inputs/outputs but do not execute local tools.
- Storage adapters persist canonical, provider-agnostic SDK transcripts.
- Provider-native state, such as OpenRouter `ConversationState`, is optional optimization state and must not replace canonical transcript storage.
- External harnesses own UX, permission presentation, credential setup, transport protocols, and application-specific workflows.

## Transcript invariants

Preserve these across runtime, storage, and provider changes:

- System messages are runtime-only and are not persisted.
- Message ordering is stable.
- Assistant text is preserved, including assistant messages that also contain tool calls.
- `reasoningContent` is preserved when providers expose reasoning/thinking output.
- Assistant `toolCalls` order and structure are preserved.
- Tool result messages preserve exact JSON-stringified `ToolResult` payloads.
- `toolCallId` links assistant tool calls to `role: "tool"` result messages.
- Provider replay should send stored transcript messages back with minimal transformation.

## Conventions to follow

- Keep changes small, readable, and consistent with existing naming/style.
  - Example: prefer a focused helper over a broad provider/runtime rewrite.
- TypeScript ESM with `moduleResolution: "NodeNext"`; relative imports include `.js` extensions.
  - Example: `import type { Message } from "./types.js";`
- Prefer `unknown` plus narrowing over `any`; avoid introducing `any` wherever practical.
  - Prefer: `const value: unknown = JSON.parse(text); if (isRecord(value)) { ... }`
  - Avoid: `const value: any = JSON.parse(text);`
- Treat casts as boundary tools, not normal implementation style.
  - Example: keep provider response casts inside a small extractor/normalizer instead of spreading `as any` through core code.
- Strict TypeScript is enabled, including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
  - Example: check indexed values before use: `const item = items[0]; if (!item) return;`
- Avoid assigning explicit `undefined` to optional properties; use conditional object spreads.
  - Prefer: `{ ...(reason ? { reason } : {}) }`
  - Avoid: `{ reason: undefined }`
- Keep runtime/provider/storage boundaries clean.
  - Runtime executes tools and permissions; providers normalize model I/O; storage persists transcripts.
- Preserve transcript invariants before provider-specific optimization.
  - Example: keep assistant text, `reasoningContent`, `toolCalls`, tool result JSON, and `toolCallId` links intact.
- Centralize tool schema handling through `src/core/schema.ts` where possible.
  - Example: use `normalizeSchema(...)` instead of duplicating Zod/JSON Schema detection.
- Prefer additive public API changes; update exports, README/docs, and tests together when public behavior or public types change.
  - Example: a new public subpath needs `package.json` exports, subpath `index.ts`, docs, and tests.
- Use fake clients/providers/fetch functions in unit tests; do not hit network APIs in unit tests.
  - Example: inject `generateTextImpl`, fake fetch, or a fake `ModelProvider`; reserve smoke scripts for live provider checks.

## Public package shape

The package name is `@hyper-labs/hyper-router`. Root exports include core runtime/types/tools plus lightweight storage (`InMemoryStorage`, `JsonStorage`). Heavier providers/storage are available from subpaths such as:

```ts
@hyper-labs/hyper-router/providers/openrouter
@hyper-labs/hyper-router/providers/openai-vai
@hyper-labs/hyper-router/providers/amazon-bedrock-vai
@hyper-labs/hyper-router/providers/glm
@hyper-labs/hyper-router/storage/sqlite
@hyper-labs/hyper-router/storage/postgres
```

If adding a new public module, update `package.json` exports, docs, and tests.

## Common validation

```bash
npm run check
npm test
npm run build
```

Use targeted Vitest commands while iterating. Live smoke scripts require API credentials and should not be treated as routine unit validation.
