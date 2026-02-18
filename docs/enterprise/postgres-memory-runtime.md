---
title: "Postgres Runtime Storage and Memory"
description: "What is implemented in the enterprise Postgres migration: sessions, transcripts, and semantic memory."
---

# Postgres Runtime Storage and Memory

This document describes the current DB-native runtime:

1. Session metadata is persisted in canonical Postgres tables.
2. Transcript events are normalized into Postgres message rows.
3. Semantic memory indexing/search can run from Postgres (`pgvector` + FTS).
4. Session/transcript runtime has no filesystem fallback.

## High-level architecture

OpenClaw now has two Postgres-backed runtime planes:

1. **Gateway session/transcript storage** (`SessionStoreBridge` + enterprise `PostgresStorageAdapter`)
2. **Semantic memory index/search** (`PostgresMemoryIndexManager`)

Both are tenant-scoped and agent-scoped in canonical schema tables.

## What changed vs legacy behavior

Legacy path:

1. Sessions: local JSON store
2. Transcripts: local JSONL files
3. Memory index: per-agent SQLite file

Current runtime path:

1. Sessions + transcripts are read and written through Postgres-backed adapters.
2. Memory search can read/write Postgres tables when `memorySearch.store.driver = "postgres"`.
3. QMD is disabled in runtime config validation (`memory.backend` accepts `builtin` only).

## Runtime write/read behavior

### A) Session metadata and transcripts

`SessionStoreBridge` uses the configured `StorageAdapter` for all session/transcript reads and writes.
In enterprise deployments this is `PostgresStorageAdapter`.

Write timing:

1. Session updates write through bridge `saveSession`/`updateSessionStore`.
2. Transcript events write through bridge `appendTranscriptEvent` (including assistant mirror/injection events).
3. `sessions.preview`, `chat.history`, `sessions.compact`, `sessions.delete` read/manage transcripts through adapter APIs.

### B) Semantic memory index/search

Memory manager selection uses `agents.defaults.memorySearch.store.driver`.

Behavior:

| `store.driver` | Runtime manager behavior |
| --- | --- |
| `sqlite` | SQLite memory manager |
| `postgres` | Postgres memory manager for reads and writes |

When Postgres memory writes happen:

1. On memory sync (`onSessionStart`, `onSearch`, watcher, interval, or manual sync).
2. During indexing of workspace memory markdown (`MEMORY.md`, `memory/**/*.md`, plus `extraPaths`).
3. During optional session transcript indexing when both are true:
   1. `memorySearch.experimental.sessionMemory = true`
   2. `memorySearch.sources` includes `"sessions"`

## Canonical Postgres schema (implemented)

Migration file: `openclaw-enterprise/migrations/0001_canonical_postgres_schema.sql`

### 1) `tenants`

Tenant root record for logical isolation.

| Column | Meaning |
| --- | --- |
| `id (uuid)` | Canonical tenant ID used in all runtime table keys |
| `slug (text)` | Human-readable tenant key |
| `created_at` | Row creation timestamp |

### 2) `agents`

Agent namespace inside tenant.

| Column | Meaning |
| --- | --- |
| `tenant_id` | FK to `tenants.id` |
| `agent_id` | Logical agent ID (`main`, etc.) |
| `created_at`, `updated_at` | Lifecycle timestamps |

### 3) `sessions`

Canonical conversation/session metadata.

| Column | Meaning |
| --- | --- |
| `tenant_id`, `session_key` | Primary key |
| `session_id` | Stable transcript/session identifier (unique per tenant) |
| `agent_id` | Owning agent |
| `updated_at`, `created_at` | Session timestamps |
| `chat_type` | DM/group/channel type |
| `channel` | Source channel/provider |
| `user_id` | User identity |
| `label`, `display_name`, `subject` | UI/semantic labels |
| `group_id`, `group_channel`, `space` | Group/channel context fields |
| `spawned_by` | Session spawning source |
| `metadata (jsonb)` | Full metadata envelope |

Population source:

1. Bridge calls enterprise adapter `saveSession`.
2. Adapter derives mapped columns from session entry metadata and upserts by `(tenant_id, session_key)`.

### 4) `session_messages`

Normalized transcript event/message rows.

| Column | Meaning |
| --- | --- |
| `tenant_id`, `session_id`, `seq` | Primary key (ordered event stream) |
| `role` | Extracted message role when available |
| `event_type` | Event type (`message` default) |
| `raw_json (jsonb)` | Full original transcript event payload |
| `text_raw` | Extracted raw message text |
| `text_redacted` | Redacted text used for preview/search pipelines (currently same as raw in adapter) |
| `created_at` | Event timestamp from payload (or now fallback) |

`seq` generation is deterministic per `(tenant_id, session_id)` via advisory lock + `MAX(seq)+1` transaction.

### 5) `memory_files`

Change-tracking/state table for indexed sources.

| Column | Meaning |
| --- | --- |
| `tenant_id`, `agent_id`, `source`, `path` | Primary key |
| `source` | `"memory"` or `"sessions"` |
| `path` | Workspace-relative source path (for sessions, synthetic `sessions/<id>.jsonl`) |
| `hash` | Content hash used for incremental indexing |
| `mtime_ms`, `size_bytes` | Source stats at index time |
| `updated_at` | Last index update time |

### 6) `memory_chunks`

Chunk-level memory index + embeddings + FTS document.

| Column | Meaning |
| --- | --- |
| `tenant_id`, `agent_id`, `chunk_id` | Primary key |
| `source`, `path` | Source class + source path |
| `start_line`, `end_line` | Chunk line range |
| `hash` | Chunk content hash |
| `provider`, `model`, `provider_key` | Embedding identity/version scope |
| `text_raw`, `text_redacted` | Stored chunk text (raw + redacted) |
| `embedding` | Embedding vector (`pgvector`) |
| `embedding_dims` | Vector dimension recorded at write time |
| `updated_at` | Last upsert time |
| `search_tsv` | Generated full-text vector (`to_tsvector(simple, text_redacted)`) |

### 7) `memory_embedding_cache`

Embedding cache to avoid re-embedding unchanged chunk hashes.

| Column | Meaning |
| --- | --- |
| `tenant_id`, `agent_id`, `provider`, `model`, `provider_key`, `hash` | Primary key |
| `embedding`, `embedding_dims` | Cached embedding payload |
| `updated_at` | Last touch time (used for pruning) |

### 8) `memory_index_state`

Current index metadata/reindex trigger state.

| Column | Meaning |
| --- | --- |
| `tenant_id`, `agent_id` | Primary key |
| `provider`, `model`, `provider_key` | Active embedding identity |
| `chunk_tokens`, `chunk_overlap` | Active chunking settings |
| `embedding_dims` | Last observed vector dimensions |
| `updated_at` | Last sync timestamp |

## Memory indexing and query pipeline (technical)

### Indexing

`PostgresMemoryIndexManager` does:

1. Validate canonical tables exist (no runtime DDL for canonical schema).
2. Probe `pgvector` extension availability.
3. Read `memory_index_state` to detect full-reindex conditions:
   1. provider/model/providerKey change
   2. chunking parameter change
   3. explicit force sync
4. Index source files:
   1. `source=memory`: markdown files from workspace and `extraPaths`
   2. `source=sessions`: transcript rows transformed into synthetic session documents
5. Chunk text, embed in batches, upsert chunks/files/cache/meta tables.
6. Refresh memory status snapshot (counts, cache size, vector health, `lastSyncAt`).

### Search

For a query:

1. Embed query text with current provider/model.
2. Vector search:
   1. Primary path: `embedding <=> query_vector` (`pgvector`)
   2. Fallback path: load vectors and compute cosine in JS (if vector path unavailable)
3. Keyword search:
   1. `search_tsv @@ plainto_tsquery('simple', query)`
   2. rank via `ts_rank_cd`
4. Hybrid merge (`vectorWeight` + `textWeight`) and top-k cut.

## Session transcript indexing details

When `sources` includes `"sessions"` and session memory is enabled:

1. Session IDs are discovered for `(tenant_id, agent_id)` from canonical `sessions`.
2. Transcript rows are read from `session_messages` in order.
3. Only `user` and `assistant` message text is used for semantic memory chunks.
4. Each session is materialized as synthetic source path `sessions/<sanitized-session-id>.jsonl`.
5. Hash changes trigger incremental re-index of that synthetic source.

Compatibility behavior during migration:

1. Session discovery has a legacy fallback reader (`sessions.key`/`sessions.data`) before canonical query.
2. Session message extraction supports canonical (`raw_json`, `text_redacted`) and older message-json shapes.

## Migrations and bootstrap behavior

1. `runMigrations(...)` applies SQL files from `openclaw-enterprise/migrations`.
2. Applied versions are tracked in `schema_migrations`.
3. On adapter startup, tenant and default agent rows are bootstrapped/upserted.
4. Migration preserves old pre-canonical `sessions` / `session_messages` by renaming them to:
   1. `sessions_legacy_pre_canonical`
   2. `session_messages_legacy_pre_canonical`

## Postgres-only cutover example

```json
{
  "storage": {
    "sessions": {
      "dualWrite": { "enabled": false },
      "readFromPostgres": { "enabled": true }
    }
  },
  "memory": {
    "backend": "builtin",
    "search": {
      "readFromPostgres": { "enabled": true },
      "writeToPostgres": { "enabled": true }
    }
  },
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": true,
        "provider": "openai",
        "model": "text-embedding-3-small",
        "experimental": { "sessionMemory": true },
        "sources": ["memory", "sessions"],
        "store": {
          "driver": "postgres",
          "postgres": {
            "url": "postgres://user:pass@host:5432/openclaw",
            "tenantId": "00000000-0000-0000-0000-000000000000",
            "schema": "public"
          }
        }
      }
    }
  }
}
```

## Operational notes and current limits

1. `pgvector` extension is required by canonical migration (`CREATE EXTENSION IF NOT EXISTS vector`).
2. ANN HNSW index is intentionally deferred because the current schema uses variable-dimension `vector`.
3. No historical backfill is automatically imported into runtime query paths.
4. Runtime config enforces builtin memory backend; QMD runtime path is not active for this migration mode.

## Key implementation files

1. `openclaw-enterprise/src/adapters/postgres-storage.ts`
2. `openclaw-enterprise/src/adapters/migrations.ts`
3. `openclaw-enterprise/migrations/0001_canonical_postgres_schema.sql`
4. `openclaw/src/gateway/session-store-bridge.ts`
5. `openclaw/src/gateway/interfaces/storage.ts`
6. `openclaw/src/memory/manager-postgres.ts`
7. `openclaw/src/memory/search-manager.ts`
8. `openclaw/src/agents/memory-search.ts`
9. `openclaw/src/config/zod-schema.ts`
