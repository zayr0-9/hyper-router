# InMemoryStorage context

`InMemoryStorage` is the simplest built-in `StorageAdapter` implementation.

Source:

- `src/storage/in-memory.ts`

## What it is for

Use `InMemoryStorage` when you want:

- local development
- tests
- examples
- single-process experimentation
- no filesystem or database dependency

It is the semantic baseline for all other storage adapters.

## Behavior

`InMemoryStorage` keeps data in process memory using maps.

It stores:

- transcript messages by `sessionId`
- latest run record by `sessionId`
- session metadata by `sessionId`

It supports:

- `loadMessages(sessionId)`
- `saveMessages(sessionId, messages)`
- `saveRun(record)`
- `getSessionMetadata(sessionId)`
- `setSessionMetadata(sessionId, metadata)`

## Important characteristics

### Non-durable

All data is lost when:

- the process exits
- the server restarts
- the function/container is recreated

### Single-process only

It does not share state across:

- multiple Node.js processes
- multiple machines
- serverless cold starts

### Transcript semantics

It filters out system messages on save, which matches runtime expectations.

That means the stored transcript contains only the canonical non-system conversation history.

## Why it matters

`InMemoryStorage` is the reference for storage semantics.

If you implement another backend, it should generally preserve the same logical behavior:

- non-system transcript only
- stable message ordering
- round-trip metadata fidelity
- no loss of assistant tool call structure
- no loss of tool output content

## Recommended use cases

Good fit:

- unit tests
- smoke tests
- examples
- CLI demos
- local prototyping

Not a good fit:

- production persistence
- multi-instance deployments
- restart-safe resume
- durable audit history

## Developer notes

When changing storage behavior, compare against `InMemoryStorage` first.

If a new backend differs from it, document the difference explicitly.
