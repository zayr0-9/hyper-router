# Agent Storage Context

Use this when changing storage contracts, built-in adapters, transcript persistence, session metadata, resume behavior, or storage documentation.

## Key files

- `src/storage/types.ts` — `StorageAdapter`, `StorageAdapterV2`, run/session metadata types.
- `src/storage/in-memory.ts` — map-backed semantic baseline.
- `src/storage/json.ts` — durable single-file JSON adapter.
- `src/storage/sqlite.ts` — `sql.js` file-backed SQLite adapter.
- `src/storage/postgres.ts` — `pg`-backed Postgres adapter.
- `src/storage/index.ts` — storage barrel exports.
- `src/core/storage.ts` — backward-compatible re-export.
- `docs/context/storage/*.md` — backend-specific context and future Redis notes.

## Storage's role

Storage persists provider-agnostic SDK transcripts and session/run metadata. It is the durable source of truth for resume flows across providers.

Provider-native state, such as OpenRouter `ConversationState`, is optional optimization state. It should not replace the canonical transcript contract.

## Current `StorageAdapter` contract

Defined in `src/storage/types.ts`:

```ts
interface StorageAdapter {
  loadMessages(sessionId: string): Promise<Message[]>;
  saveMessages(sessionId: string, messages: Message[]): Promise<void>;
  saveRun(record: RunRecord): Promise<void>;
  getSessionMetadata?(sessionId: string): Promise<SessionMetadata | null>;
  setSessionMetadata?(sessionId: string, metadata: SessionMetadata): Promise<void>;
}
```

Session metadata standard fields:

- `agentName`
- `model`
- `promptHash`
- `promptSnapshot`
- `toolsetHash`
- `updatedAt`
- `custom` for app-specific metadata

OpenRouter native continuation uses metadata to invalidate state when prompts/tools/models change.

## Optional `StorageAdapterV2`

`StorageAdapterV2` extends the base contract with optional append/concurrency hooks:

- `getSessionState(sessionId)`
- `beginRun(record)`
- `appendMessages(sessionId, record)`
- `commitRun(record)`

Runtime currently prefers `commitRun(...)` when available. It passes prior transcript, new messages, full transcript, base revision/message count, status, and metadata. If `commitRun(...)` returns `conflict: true`, runtime throws.

## Canonical transcript invariants

Every adapter should preserve these unless a future design explicitly changes the contract:

1. Do not persist `system` messages.
2. Preserve message ordering exactly.
3. Restore `date` values as `Date` objects on load.
4. Preserve assistant `content`, including assistant messages with tool calls.
5. Preserve `reasoningContent`.
6. Preserve assistant `toolCalls` order and shape.
7. Preserve exact tool result `content` strings.
8. Preserve `toolCallId` linkage between assistant tool calls and tool results.
9. Preserve `name` on tool messages.
10. Preserve session metadata, including `custom` fields.

The core rule: store messages as received and load them back with the same provider-agnostic SDK shape.

## Built-in adapters

### `InMemoryStorage`

File: `src/storage/in-memory.ts`

- Map-backed baseline implementation.
- Stores messages, latest run record, and metadata by `sessionId`.
- Filters system messages on save.
- Non-durable and single-process only.
- Best reference for semantic behavior in tests.

### `JsonStorage`

File: `src/storage/json.ts`

- Stores all sessions in one JSON file.
- File shape is `{ version: 1, sessions: { [sessionId]: { messages, run, metadata } } }`.
- Serializes dates to ISO strings and restores them to `Date` objects.
- Serializes writes within one adapter instance and writes via unique temp file then rename.
- Good for local durable development and debugging.
- Intended for simple single-process/single-writer usage.
- Use SQLite/Postgres for stronger concurrency or high-volume production usage.

### `SqliteStorage`

File: `src/storage/sqlite.ts`

- Uses `sql.js`.
- Stores one row per session in a `sessions` table.
- Columns include `session_id`, `messages_json`, `run_status`, `metadata_json`.
- Loads database bytes from disk and exports/persists on write.
- Good for portable single-file durability.
- Not tuned for heavy multi-process concurrent writes.

### `PostgresStorage`

File: `src/storage/postgres.ts`

- Uses `pg`.
- Accepts either a `pool`-like object or `connectionString`.
- Lazily creates configurable schema/table, defaulting to `public.agent_sessions`.
- Stores transcript and metadata as `jsonb`.
- Adds `updated_at` index for operational visibility.
- Good fit for shared production deployments, while remaining intentionally transcript-first.
- Call `close()` when the adapter owns its pool and the process needs cleanup.

### Redis

Redis is documented under `docs/context/storage/redis.md` as a possible future backend. It is not currently implemented. Do not document or export `RedisStorage` as available unless it is actually added.

## Storage and runtime interaction

Runtime behavior to preserve:

- Non-ephemeral runs call `loadMessages(sessionId)` and strip any accidental system messages.
- Runtime prepends current agent instructions as a fresh system message for every run.
- Runtime persists only non-system transcript messages.
- Runtime updates session metadata after each non-ephemeral run where supported.
- Failed and cancelled non-ephemeral runs persist partial transcript state.
- `ephemeral: true` skips all load/persist/metadata behavior.

## Storage docs

Existing deeper docs:

- `docs/context/storage/README.md`
- `docs/context/storage/in-memory.md`
- `docs/context/storage/json.md`
- `docs/context/storage/sqlite.md`
- `docs/context/storage/postgres.md`
- `docs/context/storage/redis.md`

Update these when changing backend behavior or adding new backends.

## Storage tests

Use targeted tests first:

```bash
npx vitest run tests/runtime-storage.test.ts
npx vitest run tests/json-storage.test.ts
npx vitest run tests/sqlite-storage.test.ts
npx vitest run tests/postgres-storage.test.ts
```

Then run broader checks when public behavior changes:

```bash
npm run check
npm test
```
