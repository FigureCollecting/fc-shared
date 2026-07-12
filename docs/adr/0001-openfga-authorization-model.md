# ADR-0001 — Authorization on OpenFGA (App×User grant model)

**Status:** Accepted (model engine-verified 2026-07-11) · **Applies to:** media-manager, and the estate's authorization tier (B1)

## Context

media-manager is becoming a professional multi-application **media warehouse** — shared
image (and later video) infrastructure for many apps, with ownership and sharing at the
level of **app × user**. Its first-build ownership model had a family of cross-tenant /
access-control leaks whose common root was one missing distinction: **content identity
and authority were conflated** (possessing an image's bytes was treated as owning it).

Identity (authN) is handled separately by a self-hosted IdP (Authentik). This ADR covers
**authorization (authZ) only**: given a *verified* `(app, user)` (or `service`), may they
perform an action on a resource?

## Decision

Adopt **OpenFGA** (a Zanzibar relationship engine) and model access as an **App×User grant
graph**, not as ownership baked onto shared content rows.

Key properties of the model (verified against the OpenFGA CLI — `fga model test`, 17 tests
/ 63 checks green):

- **Tenancy** is the `app`; every resource binds exactly one `owner_app`; cross-tenant
  access requires an explicit grant and is off by default.
- **Ownership lives on grants** at the version/grant granularity — never on the
  content-addressed (deduplicated) blob, which has no representation in the graph.
- **Grant subjects:** owner, co-owner, app-members, a specific shared user, public
  (wildcard, view-only), a **gated link** (a CEL caveat requiring a non-expired window
  **and** a token match), and **scoped** service-to-service trust (never god-mode).
- **Capabilities split** `edit` (content/metadata — owner, co-owner, admin, scoped
  services) from `administer` (delete / set-visibility / grant-revoke co-owners — **owner
  and tenant-admin only**). A co-owner is a *trusted editor*, not a full peer; an
  "equal-partners" promotion grants `administer` explicitly.
- **`download_original`** (the clean, full-fidelity extract) is owner-tier + owning-app
  premium entitlement; tenant-admins-who-aren't-members and services are excluded.
- **Album view never propagates to item bytes**; a mosaic cover is an *intersection*
  (`view` on the item AND on the album), so a public album can't leak a co-tenant's
  private item.
- **Fail closed:** absence of a grant is denial.

### The half OpenFGA cannot enforce (write-path invariants → C1 deploy gate)

A policy engine faithfully honors whatever tuples and object-ids it is given; it cannot
police what those *mean*. Four invariants therefore live at the **write/enforcement path**
and must ship as a separate test suite alongside the model:

1. Object-ids are minted per `(app, user, version)` — **never** derived from a content hash.
2. `owner_user` stays single-valued; real sharing goes through the explicit `co_owner`.
3. A link grant's caveat must be fully populated (secret side) at write time.
4. The serve layer injects only request-side link context and maps any Check error → DENY.

## Consequences

- The leak *class* is closed by construction for the parts the graph governs; the four
  write-path invariants are C1's responsibility and are gated in CI.
- Media is served only as re-authored, sanitized derivatives at content-addressed
  immutable URLs; raw originals are never served (kept, if at all, in access-gated cold
  quarantine).
- The same graph expresses the commercial "moat" entitlements (feature/tier gating),
  tenant-scoped so a subscription in one app can't unlock another app's asset.
- Consumed via a single `Check` on the serve hot path; subjects come from Authentik, not
  from this graph.
