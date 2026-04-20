# PostgresStorage context

`PostgresStorage` is a durable `StorageAdapter` backed by PostgreSQL.

Source:

- `src/storage/postgres.ts`

## What it is for

Use `PostgresStorage` when you want:

Postgres is a good fit when you need:

- durable shared storage
- multiple application instances
- transactional updates
- stronger concurrency handling
- operational familiarity in production systems

## Behavior

`PostgresStorage` implements the same `StorageAdapter` contract as the existing adapters.

It stores:

- transcript messages
- run records
- session metadata

Transcript persistence remains the canonical source of truth.

It supports:

- `loadMessages(sessionId)`
- `saveMessages(sessionId, messages)`
- `saveRun(record)`
- `getSessionMetadata(sessionId)`
- `setSessionMetadata(sessionId, metadata)`

Like the other built-in adapters, it filters out system messages during transcript save.

## Design principles

`PostgresStorage`:

- preserve provider-agnostic transcript semantics
- support deterministic per-session message ordering
- preserve exact tool output content
- preserve assistant tool call structures
- preserve custom metadata without schema friction

## Schema direction

The built-in implementation currently uses a single sessions table by default:

- `agent_sessions`

Columns include:

- `session_id`
- `messages_json`
- `run_status`
- `metadata_json`
- `updated_at`

Implementation details:

- `jsonb` is used for transcript messages and metadata payloads
- `session_id` is the primary key
- `updated_at` supports operational visibility and indexing
- `schema` and `tableName` can be customized in the adapter options

## Recommended use cases

Likely good fit for:

- production APIs
- multi-instance deployments
- shared resume state across workers
- long-lived durable transcript storage
- operational analytics on runs and sessions

## Current implementation notes

This implementation uses the `pg` client.

That means:

- it connects to a real PostgreSQL database
- it lazily creates the target schema and sessions table
- it is durable across process restarts
- it is suitable for shared multi-instance deployments

## Risks and implementation concerns

Important caveats:

- the built-in schema is intentionally simple and transcript-first
- transcript messages and metadata are currently stored as `jsonb` blobs rather than fully normalized relational rows
- each save operation is independent; higher-level transactional grouping across transcript + run + metadata is left to runtime call sequencing
- production deployments should manage connection pooling, credentials, and migrations intentionally

## Important boundary

The Postgres adapter should primarily store canonical transcript data.

Provider-native state, such as OpenRouter-specific continuation state, should remain optional and conceptually separate from the core transcript contract.
