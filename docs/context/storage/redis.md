# Redis storage context

Redis storage is not implemented yet, but it is a plausible future backend for `simple-agent`.

This document describes how developers should think about that option.

## Why Redis

Redis may be useful when you want:

- shared low-latency state
- fast session resume lookups
- ephemeral or semi-durable coordination
- horizontally scaled workers
- optional TTL-based retention patterns

## Expected role

A future Redis adapter should still implement the same `StorageAdapter` contract.

It should preserve canonical transcript behavior while mapping storage into Redis structures.

It should store:

- transcript messages
- run records
- session metadata

## Important caution

Redis is often used for speed first, not as the strongest long-term audit store.

So if Redis becomes a backend, developers should be explicit about whether it is being used for:

- primary transcript durability
- short-lived working storage
- cache-like acceleration in front of a more durable store

## Semantic requirements

Any Redis adapter must still preserve:

- transcript message order
- assistant text
- tool call structure
- exact tool outputs
- metadata fidelity
- non-persistence of system messages in stored transcript history

## Possible implementation direction

A future adapter might use:

- Redis lists for ordered messages
- hashes or JSON values for metadata and run records
- key prefixes by session id
- optional TTL configuration

Example conceptual key layout:

- `agent:session:{id}:messages`
- `agent:session:{id}:run`
- `agent:session:{id}:metadata`

## Recommended use cases

Potentially good fit for:

- distributed workers
- quick shared state
- resumable orchestration systems
- short-to-medium retention workloads

Potentially weaker fit for:

- long-term audit history without persistence guarantees
- systems needing relational querying
- environments where transcript durability must survive Redis policy changes or eviction

## Important boundary

As with all backends, Redis should implement the generic transcript contract.

Provider-native continuation state should not replace transcript storage as the canonical record.
