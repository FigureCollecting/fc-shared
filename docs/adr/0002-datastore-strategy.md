# ADR-0002 — fc-backend datastore: MongoDB → self-hosted PostgreSQL

**Status:** Proposed · **Applies to:** fc-backend (and the estate's storage strategy)

## Context

fc-backend runs on MongoDB Atlas. On inspection, its core data is **relational wearing a
document costume**: the primary `Figure` collection is a hand-rolled star-schema fact row
that duplicates shared catalog attributes per user, and joins are done by hand in
application code (no `$lookup` anywhere; `statsController` fakes `GROUP BY` with 10+
`$unwind` pipelines; a `SearchIndex` collection is a manually-synced materialized view
that exists only to dodge Atlas's free-tier index ceiling). Tellingly, a **normalized
target schema already exists as models in the codebase but is dead code** — the mismatch
was diagnosed and the fix half-built, then abandoned.

Meanwhile the estate is already tilting relational: media-manager is PostgreSQL; the
authorization tier (ADR-0001, Authentik + OpenFGA) is PostgreSQL-backed. fc-backend's
MongoDB is now the outlier.

## Decision

Move fc-backend from MongoDB to **self-hosted PostgreSQL (via CloudNativePG)**, timed to
ride C1's unavoidable schema rework but shipped as its **own parity-gated, reversible
store-swap** — not fused with the authorization change. Introduce nothing new; retire one
outlier.

- **Relational system-of-record** (fc-backend, media-manager, catalog/library-api): Postgres.
- **Search:** Postgres `tsvector`/GIN + `pg_trgm`, retiring the bespoke `SearchIndex` sync.
- **Vectors** (tagger embeddings): `pgvector`, reserved now, wired when a producer exists.
- **Ephemeral/TTL/queue:** Redis. **Blobs:** object storage. Both already run.
- **Two distinct graphs, kept separate:** the *grant* graph (authorization) is OpenFGA;
  the *domain* graph (figures↔series↔characters, recommendations) is Postgres foreign keys
  + recursive CTEs now, graduating to a derived projection (e.g. AGE/Neo4j) only if and
  when recommendations ship. OpenFGA is not a domain database, and vice versa.

## Consequences

- **Sequencing (reversible-first):** stand up the Postgres substrate for the auth tier
  first as a zero-migration dress rehearsal; then a store-swap-only phase with shadow
  dual-write and a parity gate (Mongo authoritative until parity), a `v_figure_flat` view
  keeping the API contract frozen; then the authZ layer; then search/vectors additively.
- **Trade-offs named:** Atlas Search is a real capability to re-validate against Postgres
  FTS before retiring; self-hosting concentrates operational blast radius (mitigated by
  PITR + tested restore drills); the offline-first sync moat becomes a sync-engine problem
  to fund separately.
- **Open (owner to steer):** whether to spend a deliberate "novel-DB learning" budget on a
  graph-DB-backed recommendations layer, and the HA topology (shared vs per-tier clusters).
