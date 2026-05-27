-- Collab — PostgreSQL schema
-- Applied automatically by the postgres Docker container on first start.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── documents ────────────────────────────────────────────────────────────────
-- Each document has a human-readable slug (e.g. "violet-thunder") used in URLs.

CREATE TABLE documents (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT        NOT NULL,
  slug       TEXT        UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── ops ──────────────────────────────────────────────────────────────────────
-- Every CRDT operation is appended here. On server restart the entire log for
-- a document is replayed in seq order to reconstruct the current state.
--
-- `seq` is a BIGSERIAL that provides a strict total order even when multiple
-- ops arrive within the same millisecond (ORDER BY created_at would be
-- ambiguous in that case).

CREATE TABLE ops (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         BIGSERIAL   NOT NULL,
  op_json     JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary access pattern: fetch all ops for a document in insertion order.
CREATE INDEX ops_document_seq_idx ON ops (document_id, seq);

-- Server-side idempotency guard: if a client retransmits an op on reconnect
-- the INSERT ... ON CONFLICT DO NOTHING pattern safely ignores the duplicate.
-- The unique key is (document_id, siteId, clock, type) — together these
-- uniquely identify any operation in the system.
CREATE UNIQUE INDEX ops_idempotency_idx
  ON ops (
    document_id,
    (op_json->>'siteId'),
    ((op_json->>'clock')::bigint),
    (op_json->>'type')
  );
