# Storage context

This folder exists to help developers understand how storage works in `simple-agent`, what is stable today, and how new backends should behave.

## Current storage model

The runtime uses a small, pluggable `StorageAdapter` contract.

Today that contract supports:

- transcript message persistence via `loadMessages(sessionId)` and `saveMessages(sessionId, messages)`
- run status persistence via `saveRun(record)`
- optional session metadata via:
  - `getSessionMetadata(sessionId)`
  - `setSessionMetadata(sessionId, metadata)`

Transcript persistence is the canonical cross-provider persistence model.

That means:

- transcripts are the main durable conversation record
- transcripts should remain provider-agnostic
- provider-native state, like OpenRouter `ConversationState`, is optional and additive
- session metadata is used for compatibility and invalidation decisions, especially around provider-native continuation

## Built-in storage types today

Currently shipped in this repo:

- [`InMemoryStorage`](./in-memory.md)
- [`JsonStorage`](./json.md)
- [`SqliteStorage`](./sqlite.md)
- [`PostgresStorage`](./postgres.md)

Not yet implemented, but expected to fit the same contract later:

- file/per-session JSON variants
- Redis

## Contract expectations for all storage adapters

Every storage adapter should preserve these behaviors unless explicitly documented otherwise:

1. `saveMessages(...)` stores the transcript without system messages.
2. `loadMessages(...)` returns previously stored non-system transcript messages in the same order.
3. assistant text, tool calls, tool outputs, and `toolCallId` linkage must be preserved.
4. metadata round-trips without dropping custom fields.
5. transcript fidelity matters more than backend-specific optimization.

## Message persistence rules

Important runtime assumption:

- system messages are reconstructed from the agent definition at run time
- system messages are **not** part of the persisted transcript

So adapters should store:

- user messages
- assistant messages
- tool messages

and should avoid persisting runtime-generated system prompt history as part of the canonical transcript.

## Session metadata purpose

Session metadata is optional in the interface but important in practice.

Standard fields currently include:

- `agentName`
- `model`
- `promptHash`
- `promptSnapshot`
- `toolsetHash`
- `updatedAt`

Plus:

- `custom` for application-specific metadata

OpenRouter continuation logic uses metadata for native-state invalidation checks, especially when prompt or tool definitions change.

## Guidance for future backends

When implementing a new backend:

- start by matching `InMemoryStorage` semantics
- use `JsonStorage` as the first durable reference implementation
- prefer correctness and transcript fidelity over clever normalization
- keep provider-native state out of the core transcript contract
- document concurrency, durability, and operational caveats clearly

## Source files

Core types and built-in adapters currently live in:

- `src/storage/types.ts`
- `src/storage/in-memory.ts`
- `src/storage/json.ts`
- `src/storage/sqlite.ts`
- `src/storage/postgres.ts`
- `src/storage/index.ts`

Backward-compatibility re-export:

- `src/core/storage.ts`
