# SqliteStorage context

`SqliteStorage` is a durable `StorageAdapter` backed by a SQLite database file.

Source:

- `src/storage/sqlite.ts`

## What it is for

Use `SqliteStorage` when you want:

- durable transcript storage in a single file
- a more structured backend than flat JSON
- portability without needing a separate database server
- a path toward stronger persistence semantics than in-memory storage

## Current implementation notes

This implementation uses `sql.js`.

That means:

- the SQLite database is loaded from disk into memory for each operation
- schema changes and writes are persisted back to the database file
- it is durable across process restarts
- it is simple to ship cross-platform in this repo

## Stored data

The `sessions` table currently stores one row per session with columns for:

- `session_id`
- `messages_json`
- `run_status`
- `metadata_json`

Messages and metadata are serialized as JSON blobs.

## Behavior

It supports:

- `loadMessages(sessionId)`
- `saveMessages(sessionId, messages)`
- `saveRun(record)`
- `getSessionMetadata(sessionId)`
- `setSessionMetadata(sessionId, metadata)`

Like the other built-in adapters, it filters out system messages during transcript save.

## Limitations

This is a practical built-in SQLite adapter, not a fully optimized native binding.

Important caveats:

- writes currently rewrite the backing database file
- concurrency is limited
- it is not tuned for high-throughput multi-process production workloads
- messages and metadata are currently stored as JSON columns rather than fully normalized relational rows

## Recommended use cases

Good fit:

- local development with durable transcripts
- single-instance apps
- demos and prototypes
- environments where a portable SQLite file is useful

Less ideal for:

- heavy concurrent writers
- very large session volumes
- large distributed deployments

## Future improvements

Possible future upgrades include:

- native SQLite bindings
- normalized message tables
- transactional batching
- better concurrency behavior
- optional indexing/query surfaces
