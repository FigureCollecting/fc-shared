# Architecture Decision Records

Estate-wide architecture decisions for Figure Collector Services live here — one
Markdown file per decision, numbered, immutable once accepted (supersede rather
than rewrite).

**Discipline (why ADRs live here and not in an infra repo):** this directory holds
**decisions and their reasoning only — never deployed configuration or manifests.**
A record that says *"we chose Postgres because X"* cannot drift against the running
cluster, because it never claims to *be* the cluster. Keeping the decision log
physically separate from deployed config is deliberate — mixing the two is what makes
a repo become a second, conflicting "source of truth."

**Not here:** anything sensitive about the *current* live estate (open exposure gaps,
secrets, live-infra vulnerability findings) stays in private/operational channels, not
in this shared, published repo.

## Format

Each ADR: **Status** (Proposed / Accepted / Superseded) · **Context** · **Decision** ·
**Consequences**. Reference decisions as `ADR-NNNN`.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-openfga-authorization-model.md) | Authorization on OpenFGA (App×User grant model) | Accepted |
| [0002](0002-datastore-strategy.md) | fc-backend datastore: MongoDB → self-hosted PostgreSQL | Proposed |
