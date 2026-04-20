# JsonStorage context

`JsonStorage` is the first durable built-in `StorageAdapter` implementation in this repo.

Source:

- `src/storage/json.ts`

## What it is for

Use `JsonStorage` when you want:

- a simple persistent storage option
- no database dependency
- a developer-friendly on-disk format
- easier local inspection and debugging
- a reference durable backend for future adapters

It is a practical bridge between in-memory development storage and future database-backed adapters.

## File format

`JsonStorage` stores all session state in a single JSON file.

Current top-level structure:

```json
{
  "version": 1,
  "sessions": {
    "session-id": {
      "messages": [],
      "run": {
        "sessionId": "session-id",
        "status": "completed"
      },
      "metadata": {}
    }
  }
}
```

## Stored data

For each session it can persist:

- transcript messages
- latest run record
- session metadata

Messages are serialized with ISO date strings and converted back to `Date` objects on load.

## Behavior

It supports:

- `loadMessages(sessionId)`
- `saveMessages(sessionId, messages)`
- `saveRun(record)`
- `getSessionMetadata(sessionId)`
- `setSessionMetadata(sessionId, metadata)`

Like `InMemoryStorage`, it filters out system messages during transcript save.

## Write strategy

`JsonStorage` currently writes by:

1. reading the existing JSON file
2. mutating the in-memory data structure
3. writing a temporary file
4. renaming the temporary file into place

This gives a basic atomic-write pattern for a single writer on a local filesystem.

## Strengths

- durable across process restarts
- easy to inspect manually
- easy to back up
- no external infrastructure needed
- good reference implementation for future persistent backends

## Limitations

### Single shared file

All sessions live in one file right now.

That means:

- large usage can make the file grow continuously
- updates rewrite the file
- concurrency is limited
- multiple writers are not coordinated

### Not a database

This backend is not designed for:

- high write throughput
- cross-process contention
- distributed locking
- advanced querying
- large-scale production workloads

### Operational caveats

Use with care if you expect:

- multiple app instances writing at once
- frequent writes from several workers
- remote or unusual filesystems

## Recommended use cases

Good fit:

- local persistent development
- demos
- prototypes
- small single-instance deployments
- reproducible transcript debugging

Less ideal for:

- horizontally scaled services
- large multi-tenant systems
- high-volume agent traffic

## Relationship to future backends

`JsonStorage` should be treated as the reference durable transcript backend.

Future adapters like SQLite, Postgres, or Redis should preserve the same transcript semantics while improving:

- concurrency
- scalability
- operational robustness

## Developer notes

If you extend this backend, keep these properties stable:

- preserve message order
- preserve tool call structures
- preserve exact tool output content
- preserve metadata fidelity
- keep system messages out of persisted transcript storage
