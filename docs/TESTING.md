# Figure Collector — Testing Rules and Standards

**Status:** living document. **Home:** `fc-shared/docs/TESTING.md` (version-controlled here; referenced ecosystem-wide; not shipped in the npm package — only `dist/` is published).

---

# Part I — Universal (stack-agnostic)

## 0. Why this exists

Guidance already existed — `frontend-test-engineer.md` even said *"mock with MSW, not axios"* and *"test behavior, not implementation."* The root `CLAUDE.md` has a sound four-criteria framework. The scraper team once filed a `TEST_CLEANUP_PROPOSAL.md` after hitting **120 failing tests out of 219**, diagnosed as *"excessive unit tests coupled to implementation details (mocks) rather than behavior."*

**The gap was never the rules. It was enforcement.** Three decent documents existed and tests still decayed into fake tests that look thorough but verify nothing, flaky timers, and unreachable paths. So this document is only worth writing if its rules are made **impossible to ignore by machine** — CI guards, coverage gates, and wiring into the agents that write the tests. A rule nobody can violate beats a rule everybody agrees with.

A passing test suite is a **claim of safety**. A test that passes without actually checking the code is worse than no test, because it sells confidence it hasn't earned.

---

## 1. First principles

1. **Test behavior and contracts — never implementation or mocks (stand-in fake objects that replace a real dependency).**
2. **Every test must answer one question:** *"What real, plausible bug would make this fail?"* If the honest answer is *"only if I change the mock,"* the test is deleted.
3. **Coverage is necessary, not sufficient.** The tests-that-can-never-fail below (they only check the fake object the test itself created) had "coverage" and caught nothing.
4. **These rules grow from real misses.** When something reaches prod that a test should have caught, we add the rule + example to §10.

---

## 2. The layered strategy — what to test, and where

| Layer | Scope | How |
|-------|-------|-----|
| **L1 — Pure logic** | transforms, stores, sanitizers, reducers, pure utils | Direct unit tests. Exhaustive edges: `0` / `null` / `undefined` / `''` / empty. **No mocks needed.** |
| **L2 — HTTP-client behavior** | the real HTTP client, interceptors (code that runs on every HTTP request), auth injection, token refresh, retries, error mapping, request shaping | Fake the network connection (see §4). The real client runs; only the network connection is faked. **Never mock the client object.** |
| **L3 — Component / hook behavior** | UI components, hooks, view models | Behavior-driven, user-centric queries; network connection faked; **seed the real auth precondition** for gated views; assert user-visible behavior across loading / success / error. |
| **L4 — Cross-service contract** | request/response shapes between services | **Shared types / protos / OpenAPI are the single source of truth.** Fixtures (preset sample data a test feeds in) typed against them, so drift becomes a *compile error*. Real cross-service E2E stays **off PRs** (manual/infra), per the boundary policy. |

**The contract-source lever (L4):** the more both sides type their fixtures against the shared contract (`@figurecollecting/fc-shared`, the gRPC protos, or a service's published OpenAPI), the more a fixture drifting out of sync with the real API becomes a compile error instead of a silent prod surprise. That is a primary reason fc-shared exists. The concrete tool per stack — `@figurecollecting/fc-shared` types, the protos under `protos/`, or a `/v3/api-docs` / `/openapi.json` schema — lives in each Part II playbook.

**Caveat — the compile-error guarantee holds ONLY when the consumer imports the producer's shared contract artifact.** Where a stack mirrors types locally instead of importing the shared source — fc-frontend's `src/types` (no `@figurecollecting/fc-shared` / proto / OpenAPI import) and media-manager's Pydantic models (FastAPI-generated OpenAPI + local Pydantic, no shared import) — a producer contract change does NOT become a compile error in the consumer; the local types silently diverge and drift is caught only at runtime/assertion. That is a **standing risk**, not a covered case. Mitigation: fc-frontend should consume `@figurecollecting/fc-shared` (or codegen its types from the backend OpenAPI); media-manager consumers should codegen from the producer's `/openapi.json`. Until then, treat these two boundaries (the interface between the engine and the data it loads) as assertion-only and weigh them accordingly.

### Contract tests vs. typed fixtures — when each applies

- **Typed fixtures (compile-error) — the default.** Where the producer and consumer share a build artifact (TS code typing fixtures against `@figurecollecting/fc-shared` or the protos), a contract change breaks compilation. This is the L4 default. It catches only **shape** drift, and only when both sides import the same artifact (see the Rule 4 caveat for stacks that mirror types locally).
- **Consumer-driven contract tests (Pact) — OPTIONAL, only for cross-language boundaries, and only when needed.** A Kotlin Android client, a Python service, and a TS frontend cannot compile against each other's types, and a shared proto guarantees field shapes but not which fields are populated, the enum meanings, or the error-status mapping at runtime. When a real cross-language boundary needs that runtime check — for example **library-mobile ↔ library-api**, or the future **backend↔scraper gRPC** — Pact (pact-js / pact-python / pact-jvm, plus the gRPC pact plugin) is the right tool: the consumer publishes a small contract file and the producer verifies it in its own CI. This is **not a current requirement** — adopt it per-boundary only when that boundary actually exists and typed fixtures can't cover it.

> **Note on the failures we actually hit:** the cases where tests passed but the app still didn't work were **inside a single app** — screens that passed their isolated tests but were unreachable in the running app because login or routing wasn't wired up. That is **not** a cross-service contract problem, and Pact does not fix it. It is covered by **Rule 3** and the **assembled-app reachability test** described there.

### Migration testing

Schema migrations are a prod-breaking surface with no unit-test equivalent, so they get their own test class. **Every schema migration has a test that:**
1. **starts from the prior schema state**,
2. **runs the REAL migration tool** — Alembic, the Flyway `V__` scripts, or the Mongo index sync — against a **real engine via Testcontainers** (not a shimmed SQLite or AGE-less substitute; this is Rule 6 applied to migrations),
3. **asserts the resulting DDL/index actually supports its feature**: `to_tsvector(...)` returns rows, `cypher(...)` succeeds, the `CITEXT` unique constraint rejects a case-variant duplicate, the new Mongo index serves its query, and
4. **round-trips up→down→up** where down-migrations exist.

For **data/schema-push repos** (the proprietary-advantage repos, per §7's "no CI release-gate" rationale) the **migration test IS the gate** — there is no build ceremony between writing the migration and prod, so the test is the only thing standing between a bad migration and a broken database.

---

## 3. The non-negotiable rules

Each rule states a **stack-agnostic principle**, paired with a **real** anti-pattern from our own codebase (full gallery in Appendix A). The concrete tool and per-stack mechanics for each rule live in Part II.

### Rule 1 — No real time delays (no real sleeps or timers in tests)

**Principle:** A test must never consume real OS-clock time. Async is asserted by **resolving or rejecting a promise/future**, with **fake/virtual timers advanced explicitly**, or with **a frozen, explicitly-advanced clock** (e.g. freezegun's `freeze_time` + `.tick()` — a first-class member of this family, not a comparison). To hold a pending state open, use a **deferred promise** you resolve manually — never a real timer, sleep, or arbitrary delay. A test that "waits long enough" is a flake.

> ❌ `fc-frontend/src/components/__tests__/FigureForm.realcoverage.test.tsx`
> ```ts
> await waitFor(() => {
>   expect(callCount).toBeLessThanOrEqual(2); // May have 1-2 calls due to timing
> }, { timeout: 3000 });
> ```
> A 3-second real-time window and a fuzzy `<= 2` — the comment admits the nondeterminism. Fake timers assert *exactly one* call.

→ Per stack: see Part II.

### Rule 2 — Fake the network connection, not your own client code

**Principle:** Fake the network/process connection, so the real client object, its interceptors (code that runs on every HTTP request), refresh logic, and endpoint wrappers all actually execute. Forbidden: replacing the HTTP client wholesale (`jest.mock('axios')`, stubbing `axios.create`, `patch("...httpx")`, `mockk<...Api>()` of the Retrofit interface, capturing-and-hand-invoking interceptor callbacks). Mocking the client tests the author's reimplementation of the client, not the code.

> ❌ `fc-frontend/src/api/__tests__/index.test.ts`
> ```ts
> interceptors: { request: { use: jest.fn((handler) => { requestInterceptor = handler; return 0; }) } },
> mockedAxios.create.mockReturnValue(mockAxiosInstance);
> ```
> This tests the author's reimplementation of axios's pipeline. Interceptor wiring, auth-header injection, and status handling can all break and the suite stays green.

→ Per stack: see Part II.

### Rule 3 — Make sure the test can actually reach the screen or flow (log in first)

**Principle:** A test for a gated flow **must establish the real precondition** the way the app does. Auth, ownership, and session state are seeded through the same mechanism the runtime uses (a real signed token, the real auth store, a seeded ownership row), not faked away. Each flow test **names its preconditions**. Exercising a gated view from the default (logged-out / unprivileged) state silently tests the *wrong branch*.

> ⚠️ Confirmed gap: the shared render helper in `fc-frontend/src/test-utils.tsx` wraps providers but **does not seed auth** — nothing enforces the precondition. Fix: a typed `renderAuthenticated(ui, { user })` helper (Appendix B).

**Required: the assembled-app reachability test.** A passing isolated-component test does not prove a real user can get to that component. So each app must also have at least one test that renders the **real assembled app** — real routing, with login seeded in — and **navigates to each gated screen the way a user would**, asserting the screen actually loads. This is what catches the failure where a screen passes its isolated test but is dead in the running app (login not wired, a route missing, the page never mounted). **fc-mobile's routing reachability test (register → home) is the example to copy.**

→ Per stack: see Part II.

### Rule 4 — Contract fidelity

**Principle:** Mock responses are **typed against the shared contract** (fc-shared types, protos, or a published OpenAPI schema) and, where feasible, **seeded from a captured real response**. A mock whose shape diverges from the real API is a bug, not a convenience — and when fixtures are typed against the source of truth, divergence becomes a compile error. **Caveat:** that compile-error guarantee holds only when the consumer imports the producer's shared artifact; where a stack mirrors types locally (fc-frontend `src/types`, media-manager Pydantic) drift is caught only at runtime/assertion — a standing risk (see §2 L4).

> ❌ `fc-frontend/src/api/__tests__/index.enhanced.test.ts`
> ```ts
> it('should create axios instance with correct base URL', () => {
>   expect(mockApiInstance.post).toBeDefined(); // "we just verify our mock was set up"
> });
> ```
> Name promises a base-URL check; body asserts the mock exists. Proves nothing about production; can never fail for a real bug.

→ Per stack: see Part II.

### Rule 5 — Every test asserts a real outcome

**Principle:** No assertion-free tests. No name/body mismatch. The assertion must be **able to fail** for a plausible regression. If no real, plausible bug would flip it red, it is not a test.

> ❌ `fc-frontend/src/components/__tests__/FigureForm.conditions.test.tsx`
> ```ts
> it('should test cleanup on unmount during scraping', async () => {
>   // ...renders, types, unmounts...
>   if (resolveFetch) { resolveFetch({ ok: true, json: async () => ({ success: true, data: {} }) }); }
> }); // <- zero expect()s, resolve guarded behind `if`
> ```
> Cleanup logic could regress (e.g. setState-after-unmount) and this test cannot fail.

→ Per stack: see Part II.

### Rule 6 — Test against the real database engine

**Principle:** A DB-boundary or integration test runs against the **prod database engine AND its prod extensions** — never a substitute that rewrites the SQL dialect (the specific SQL variant a given database understands). Dialect rewrites (`@compiles(..., 'sqlite')` type rewrites, `is_postgres()`/ILIKE fallbacks, plain `postgres:16` standing in for an extension-bearing image) are **BANNED for the DB-boundary suite**: they let the suite report high coverage on the *wrong engine* while the prod-only code paths are never entered. This is the classic case of tests that pass without actually checking the code — passing suite, high coverage, production paths untested — and it is invisible to every grep and every coverage gate, because the code *runs*, just against the wrong engine.

Two non-negotiables:
1. **Use the real engine via Testcontainers**: `PostgresContainer` for media-manager; `apache/age:release_PG16_1.6.0` (`.asCompatibleSubstituteFor("postgres")`) for library-api. Run real migrations against it (see Migration testing).
2. **A smoke test (a quick check that the basics work) fails if the prod capability is unavailable** — e.g. it errors out if `to_tsvector(...)` or `cypher(...)` cannot be called — so an accidentally-substituted or wrong-image container can never pass silently. Add **per-class coverage rules** so the FTS/AGE classes specifically must hit **≥85** (the global ratio otherwise hides the never-entered branches).

> ❌ **media-manager** runs SQLite-as-Postgres (`@compiles(UUID/CITEXT, "sqlite")` + `is_postgres()` ILIKE fallback), so `to_tsvector`/`@@` full-text, `ARRAY`/`&&` tag-overlap, `CITEXT` case-insensitive uniqueness, and native `UUID` get **zero** test coverage while the suite stays green.
> ❌ **library-api** runs `postgres:16-alpine`, which has no Apache AGE, so `cypher()`/`CypherQueryBuilder` and `V2__enable_age_extension.sql` are silently skipped.

→ Per stack: see Part II (media-manager and library-api playbooks carry the concrete container + smoke-test wiring).

---

## 4. Faking the network/process connection (universal)

**The principle:** fake external dependencies at the **network or process connection**, never by replacing the client object. Your *real* code runs — the HTTP client, its interceptors (code that runs on every HTTP request), refresh logic, the call-site, the (de)serialization converter — and only the network connection is faked. Replacing the client (e.g. `jest.mock('axios')`, `patch("app...httpx")`, `mockk<Api>()`) skips exactly the code that breaks in production: URL shaping, headers, status handling, retries, and contract drift.

Two non-negotiables that hold across every stack:

1. **An un-mocked request must fail loudly.** Configure the mock so any request without a registered handler errors (`onUnhandledRequest: 'error'`, and equivalents). This is what turns a faked connection into a *contract* test — drift can't pass silently.
2. **Match on the real, absolute URL + payload**, not on "a call happened." A test that only asserts the client was invoked is back to mocking the client.

**Exception — a typed in-repo client module is the connection point.** When a consumer calls a typed, in-repo client **module** (e.g. fc-shared's API functions like `executeFullSync`) rather than a raw HTTP client, mocking *that module* IS faking at the connection point. The network code below it — the axios instance, interceptors, auth-header injection, token refresh, URL shaping, error mapping — belongs to fc-shared and is **contract-tested there** (fc-shared's own MSW suite covers exactly that layer against the real network code). So fc-mobile's `vi.mock('@figurecollecting/fc-shared')` is **correct**, not a Rule-2 violation: its connection point is the fc-shared contract, and fc-shared owns the network code below it. This is what makes fc-mobile the best example to copy rather than a contradiction. The ban in Rule 2 / §8 targets **raw HTTP clients** (`jest.mock('axios')`, stubbing `axios.create`, `patch("...httpx")`, `mockk<...Api>()` of a Retrofit interface) — not mocking a shared, typed client module whose own network code is contract-tested in its home repo.

**The tool is stack-specific** — pick it from the playbook in Part II:

- **TS-Jest / node** and **TS-Jest / React**: MSW v2 (`msw/node`, `setupServer` + `http` + `HttpResponse`).
- **TS-Vitest / Preact**: mock the injected fc-shared client module (`vi.mock` + `importActual`); `page.route` at the network edge for Playwright.
- **Python-pytest**: `respx` for httpx, `moto` (`mock_aws`) for S3/boto3, `fakeredis` for Redis.
- **Java/Spring**: WireMock (`@WireMockTest`) at the HTTP boundary.
- **Kotlin/Android**: `okhttp3.mockwebserver.MockWebServer` with a real Retrofit + Moshi client.

### Faking the connection for streaming transports

The request/response connection fakes above do not cover **streaming** — and streaming is a critical, already-shipping surface: the scraper protos define `rpc ExecuteFullSync(...) returns (stream SyncEvent)`, `fc-backend/src/routes/syncRoutes.ts` is a real SSE producer (`text/event-stream`, `res.write`, a connection registry keyed by sessionId), and `fc-frontend/src/hooks/useSyncEvents.ts` consumes via `EventSource` with exponential-backoff reconnect. The same principle applies — fake the connection, run the real client — but the connection is a stream, not a single response.

- **(a) SSE consumer (frontend).** Route the underlying request through **MSW v2's streaming response** (`new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } })`) so the real `EventSource` parser, event-type dispatch, and reconnect logic all run. Do **NOT** replace `global.EventSource` with a hand-rolled mock class — that is the streaming form of the Rule 2 client-mock anti-pattern, and it is exactly what `fc-frontend/src/hooks/__tests__/useSyncEvents.test.ts` does today (`global.EventSource = MockEventSource`). Assert reconnection by **advancing fake timers**, not by re-instantiating a mock.
- **(b) SSE producer (backend).** Connect a **real client** to `fc-backend/src/routes/syncRoutes.ts` (supertest streaming or raw `http`) and assert the actual wire frames: `event:`/`data:` lines, the heartbeat, the terminal close, **and** the connection-registry add on connect / remove on disconnect.
- **(c) gRPC server-streaming.** For the `stream SyncEvent` RPCs in `protos/figure_collector/v1/scraper_service.proto`, stand up a real **in-process grpc-js `Server`** on an ephemeral port and assert: the ordered `SyncEvent` sequence, the trailing status, an **error-mid-stream** case, and **cancellation** — so the proto stream contract is exercised at end-of-stream, not just on the success frame.

---

## 5. Coverage policy — the number can only go up

- **Every repo is gated.** No repo reports coverage informationally; the gate fails the PR.
- **Floor: 70% project + 70% patch** on meaningful code (`informational: false`). This is the minimum any repo may sit at.
- **Target: 85%** for mature and critical surfaces, **and** for the proprietary-advantage + entitlement code (§7). New code aims at 100%.
- **A one-way gate — coverage may NEVER decrease.** Once a repo clears a bar, that bar becomes its new floor. A PR that drops the number fails — bring it back up or raise the threshold, never lower it.
- **Intermediate steps are allowed below 85 — provided they only move toward it.** A stack starting well under the target may set an intermediate step (e.g. ~80) as a stepping-stone, but only as an authorized step on the way to the 85 final target, never as a resting place. Non-uniform per-metric steps are fine for the same reason, as long as every metric is climbing toward 85.
- **Bring the ungated laggards up to at least the floor:** `fc-mobile`, `library-mobile`, `media-manager`, `fc-lookup`, and `scraper-rulesets` currently measure-but-don't-enforce; each must add a gate at ≥70/70 and only move up from there.
- **`fc-frontend`** — currently branches 40 / functions 50 / lines-statements 60; intermediate step ~80 (branches ≥75 for room to climb — never set a metric *at* the project floor or there is no room to climb); final target 85 across all four metrics once the network-connection-faking cleanup lands. The React playbook's 80/75/70 recommendation IS this authorized intermediate step (with branches bumped to ≥75), not a separate target.
- **`library-api` keeps its enforced 85** (JaCoCo `jacocoTestCoverageVerification` wired into `check`) — it is the best example to copy, not the exception.
- **Floor on *meaningful* code.** Honest, documented exemptions only — pure types and barrel re-exports have no runtime behavior. Each exemption must say *why*, and the two layers (collect-from negations **and** the gate's `ignore`) must stay synchronized.
- **Coverage ≠ safety.** The tests-that-can-never-fail in Appendix A produced coverage and protected nothing. A line executed under a meaningless assertion is not covered in any way that matters.

**The per-stack gate mechanism** — `codecov.yml`, jest `coverageThreshold`, vitest `coverage.thresholds`, JaCoCo `jacocoTestCoverageVerification`, pytest `--cov-fail-under` / `[tool.coverage.report] fail_under` — lives in each Part II playbook.

---

## 6. The four-criteria completeness check (actually checked)

Each module's test file states how it addresses each, or why N/A:
1. **Functional completeness** — happy paths, primary use cases, state transitions.
2. **Boundary handling** — interface boundaries, data transformation, entry/exit edge cases.
3. **Failure behavior** — error states (network/validation/auth), recovery, graceful degradation.
4. **Resilience** — reconnection, timeout, malformed input.

---

## 7. Testing the proprietary (private, paid) capabilities

This tier governs `scraper-rulesets`, `fc-lookup`, and **every future token-gated capability** — the private rulesets we keep secret, injected into a generic public engine per the engine/data-separation strategy (see `engine_data_separation_strategy`: the public engine image stays generic; proprietary capability is shipped as runtime DATA, entitlement-gated). Two boundaries here are essential and must be contract-tested:

1. **The engine ↔ data plugin-API boundary** — the one rule that must never silently drift. Contract-test that the plugin registers exactly what the engine expects: every shipped site/ruleset registers via the real `register()` path, each ruleset's `siteId`/`version` is asserted, and `extract()`/`validate()` honor the `ExtractedData`/`ValidationResult` shapes from the shared `types.ts`. `scraper-rulesets/src/__tests__/plugin.test.ts` already does this for the plugin side — that is the template.

2. **The entitlement / token gate** — three cases, all deterministic:
   - **Authorized load succeeds** — a correctly-signed token → plugin registers, sites appear in the registry.
   - **Unlicensed denied** — missing or expired token → `register()` rejects (or the registry stays empty); no site is exposed.
   - **Tampering rejected** — a mutated token payload or mutated ruleset bytes → the signature/integrity check throws and nothing registers.
   Sign tokens with a fixed test key; use fake timers for any expiry check rather than real elapsed time.

**Why this tier carries its own gate:** a data/payload push has **NO CI release-gate** — there is no build, no merge ceremony between writing a ruleset and it reaching production. So these repos' tests *are* the safety net that replaces the release ceremony. That is why the proprietary-advantage repos must hit the **85% target**, not merely the floor, and why their plugin-boundary and entitlement tests are non-optional.

**Enforcement timing (the entitlement loader does not exist yet).** Until the loader is in code:
1. The **85% target binds only to the EXISTING plugin-API boundary** (`scraper-rulesets/src/__tests__/plugin.test.ts`). You cannot enforce coverage on a code path that does not exist, so the entitlement portion is aspirational until the loader lands.
2. The three entitlement cases (authorized / unlicensed / tampered) are tracked as **`it.todo`/pending contract specs** — registered and visible, but **NOT counted toward coverage**. They must **NOT** be written as assertion-bearing tests against an imagined loader API: a test that asserts against code that does not exist cannot fail for a real bug, which is a **Rule 5 violation** (it can only ever validate a test-only fake — the exact fake test that looks thorough but verifies nothing §0 warns about).
3. The three cases become **enforced and coverage-counted in the SAME PR that lands the loader**, written fail-first per TDD (red against the real, newly-imported loader before it passes). Only then does the 85% target extend to the entitlement boundary.

---

## 8. Enforcement — the automated checks that make the rules impossible to skip

1. **CI hygiene guard:** fail the build if `tests/` contain a real-time-delay primitive or a **raw HTTP-client** mock — except a line carrying an explicit, justified escape hatch. The client-mock ban targets the **raw HTTP client**, never a typed in-repo client module (§4 exception): mocking a shared typed module like `@figurecollecting/fc-shared` is allowed and must not be flagged. The grep is **adapted per stack** (the forbidden tokens differ): TS bans `setTimeout`/`setInterval` in tests, `jest.mock('axios')`, `axios.create` stubs, and **`global.fetch =`/`globalThis.fetch =` assignments** (the scraper uses no axios at all — its real client-mock antipattern is stubbing `global.fetch` in `webhookClient.test.ts`, and fc-backend stubs `global.fetch` in four `syncRoutes.*` tests; without this token the guard misses the actual violation while only catching axios). The TS grep is **scoped to test files** (`**/*.test.*`), excluding `setup.ts` and `__mocks__/`, so a legitimate `jest.setTimeout()` bump or a setup-file helper does not false-positive. Python bans `time.sleep` and `patch("...httpx")`-style client mocks; Java/Kotlin ban `Thread.sleep` and `RestClient` mocks, plus `mockk<...Api>()` of a Retrofit interface **only in boundary/contract test files** (e.g. files matching `*Api*Test`/`*Network*Test`) — interface fakes in L1/L3 ViewModel/logic tests are fine and require only the escape hatch if they trip the grep (see below). The escape hatch is a single commented line that surfaces in review:
   ```ts
   // test-doctrine-allow: <reason>   ← required justification, surfaced in review
   ```
   For **DB-boundary suites** also grep-ban SQL-dialect rewrites (Rule 6): `@compiles(..., 'sqlite')` rewrites and `is_postgres()`/ILIKE fallbacks in tests, plus a smoke check that the container actually has the prod extension (`to_tsvector`/`cypher()` callable) so a wrong-engine substitute fails loudly rather than passing while leaving production code unchecked.
2. **Agent wiring:** every `*-test-engineer` agent definition and each service `CLAUDE.md` references these rules as the source of truth.
3. **Coverage gate:** the one-way gate of §5 — every repo gated, 70/70 floor, 85 target for mature/critical/proprietary-advantage surfaces, never decreasing — enforced by the per-stack mechanism named in each playbook.
4. **PR review checklist:** determinism (Rule 1), fake-the-connection-not-the-client (Rule 2), named preconditions (Rule 3), contract fidelity (Rule 4), real assertions (Rule 5), real database engine (Rule 6 — DB-boundary tests on the real engine + extensions, no SQL-dialect rewrites).

**Suite-health visibility.** §8's other checks enforce the *input* side; this one observes the *running suite* over time, so decay becomes visible **before** it produces a prod miss (the §10 table is reactive — this is proactive). Each repo's CI emits and trends: (a) **skipped / todo / quarantined counts** (must not silently grow — pairs with the flaky-quarantine policy and the §7 `it.todo` entitlement specs); (b) the **N slowest tests + total suite run time** (a rising max single-test time flags a creeping Rule-1 violation); (c) the **coverage trend** (already gated per-PR — surface the curve); and (d) **per-test flake rate** from CI history. Wire it via Codecov's trend view (coverage), JUnit-XML test-report ingestion (skip/duration/flake), and a periodic suite-health check that warns or fails when skipped-count or max-duration regresses.

---

## 9. Rollout — these rules describe the target state, not today's reality

**Be honest: §8's automated checks are only partly built.** Today these rules still describe mostly where we are going, not where we are — but Phase 1 has begun. As of this writing: **MSW has landed in fc-shared** (the `client` / `figures` / `scraper` API trio, with `onUnhandledRequest: 'error'`) **and in scraper's `webhookClient`**; the **§8 grep guard is live in fc-shared's `build.yml`** (the `test-hygiene` job — real timers, raw-client/`global.fetch` mocks, and snapshots), still absent from the other repos' workflows; **`renderAuthenticated` does not exist** and `fc-frontend/src/test-utils.tsx` **still does not seed auth**; coverage gates are **partial** (jest `coverageThreshold` is set in fc-frontend, at a low 40-60, and now in **fc-shared at the 85 target**; absent in backend/scraper; fc-lookup has no test script at all); and **library-mobile's MockWebServer is declared-but-unused**. Outside fc-shared, the **only live automated control** over the qualitative failure classes is still **Codecov coverage %** — which these rules themselves (§5, §10 living-lessons) say catch **none** of these classes (test-that-can-never-fail, client-mock, real-time-delay, reachability, DB-engine all produce coverage). So shipping the rules without finishing the rollout would just repeat §0's history.

The sequence below is **safe** because it adopts positive controls *before* the hard ban — banning client-mocks before faking-the-connection exists would delete tests without replacing them and **reduce** safety.

### Phase 1 — adopt the positive controls first

Per repo, tightening via a **shrinking allowlist** (not a one-time sweep):
- Add **MSW v2** to the four TS-Jest repos **+ fc-frontend**; **respx** to media-manager; switch **library-mobile** to its already-declared **MockWebServer**.
- Make **`onUnhandledRequest: 'error'`** (and per-stack equivalents) the **shared default** so drift fails loudly.
- Write **`renderAuthenticated`** (Appendix B, Pattern B) and **delete** the orphaned `fc-frontend/src/test-utils/mocks/auth.ts`.
- Add/raise **coverage gates**: add jest `coverageThreshold` to **backend / scraper / fc-shared**; raise **fc-frontend** off 40-60 (toward the §5 intermediate step); **scaffold fc-lookup** with jest + a gate (it ships real HTTP with no tests — a proprietary-advantage-adjacent repo per §7 with no safety net). Add **per-class coverage** on the **FTS / AGE / gated-branch** classes (Rule 6).

### Phase 2 — build the §8 grep guard and make it a REQUIRED check

Build the grep guard described in §8.1 as an actual CI job, wired into every repo's `build.yml` as a **required** check (not `|| true`) — **but per repo, ONLY AFTER that repo's connection-faking tool is adopted in Phase 1.** Rationale (critical): banning client-mocks before connection-faking is adopted **deletes tests without replacing them and reduces safety**. Sequence adoption (Phase 1) before the hard ban (Phase 2), per repo.

### Now

**fc-shared is the first adopter — and step 1 has landed.** Its API trio — `client` / `figures` / `scraper` — is now covered by an MSW contract suite (`onUnhandledRequest: 'error'`), gated at the 85 target via jest `coverageThreshold`, and guarded by the §8.1 `test-hygiene` job in `build.yml`. This is **Phase-1, step 1** complete, and the **reference implementation** every other repo copies. fc-shared owns the network code that fc-mobile's typed-module mock relies on (§4 exception), so getting its MSW contract suite right is what makes that whole pattern honest downstream. Next steps: propagate MSW + the grep guard + a coverage gate to backend and scraper, then fc-frontend.

---

## 10. Living lessons (grows from real misses)

| Date | What slipped / was found | Rule that applies | Action |
|------|--------------------------|-------------------|--------|
| 2026-06-10 | `transforms` dropped `0` going to the API (truthiness gate) while the reverse path kept it | L1 edge: `0` vs absent | Fixed source to `!== undefined`; added regression tests |
| 2026-06-10 | `logger` level getter `LOG_LEVELS[level] \|\| error` collapsed `verbose` (0) → `error`, disabling verbose/info | L1 edge: falsy-coalescing on `0` | Fixed to `??`; added regression test |
| 2026-06-10 | fc-shared stores need React (zustand `create`) but nothing declared it | packaging/contract | Added react optional `peerDependency` + devDep |

**Template:** *Date · what slipped · which rule would have caught it · rule added or amended.* The point of this table is that these rules are never "done" — every escaped bug either matches an existing rule (enforcement failure) or demands a new one (coverage failure).

---

## 11. Standing policies (cross-cutting)

These are short, universal policies that close known ways tests can pass without checking the code. They apply across every stack; per-stack tools live in the playbooks.

### Snapshot policy

**Ban full-tree / serializer snapshots** of rendered components or large API payloads — a giant DOM/JSON snapshot executes lines, asserts nothing meaningful, and is "fixed" by blindly running `-u`. That is the single most common way a test that passes without checking the code creeps back after a cleanup. **Permit** narrow `toMatchInlineSnapshot` only for small, human-readable, intentionally-pinned values (a formatted error string, a generated Cypher fragment from `CypherQueryBuilder`) where the snapshot is visible in-diff and a reviewer can judge correctness. The §8 hygiene grep flags new `__snapshots__` files / `toMatchSnapshot(` and requires a `// test-doctrine-allow:` justification, matching the real-time-delay and client-mock guards.

### Test-data builders

Construct fixtures with **typed builders that are valid-by-default with overrides** — `aFigure({ collectionStatus: 'OWNED' })` returns a complete, contract-typed object and states only the field under test, so a contract change to a required field breaks one builder, not fifty hand-rolled literals. Per stack: fishery / lightweight typed builders (TS), `factory_boy` / a `make_*` style (Python — generalize media-manager's ad-hoc `make_auth_headers`), object-mother / test-data builders (Kotlin). This ties to **Rule 4** (builders return contract-typed objects, ideally seeded once from a captured real response) and **Rule 3** (the precondition-relevant field stays visible instead of buried in a 20-line literal).

### Flaky-test policy

**Blanket auto-retry of the suite is banned** — it hides product races (`jest.retryTimes`, Gradle `test { retry }`, retrying the whole run all mask real intermittent bugs, directly contradicting §0's "a test that passes without checking the code is worse than no test"). A flaking test is **quarantined explicitly**: moved to a tracked quarantine tag that still **RUNS and reports** but does not block the merge, with a **mandatory linked issue + owner + expiry date** — never a silent `.skip`. Quarantine is a **debt list surfaced in CI** whose count must trend to zero, not a parking lot. The fix is to make the test deterministic (Rule 1 / fake timers / Awaitility), then de-quarantine. A test cannot enter quarantine without an issue link.

### Mutation testing

Coverage is necessary, not sufficient (§5) — mutation testing is the **automated** measure of whether an assertion can actually catch a planted bug, the missing enforcement behind "coverage ≠ safety." Run it as a **periodic (nightly/weekly, not per-PR — it is slow)** quality probe on the highest-stakes surfaces first: the **proprietary-advantage/entitlement code (§7)**, **L1 pure transforms**, and **`CypherQueryBuilder`-style string builders**. Treat a low mutation score on those as a rule violation even when line coverage is green. Per stack: **Stryker** (TS-Jest, TS-Vitest), **mutmut** (Python), **Pitest** (Java/Spring — integrates with the existing JaCoCo/Gradle setup). Set an initial **mutation-score floor on the proprietary-advantage tier**, increasing it over time like §5. **For the proprietary-advantage tier this is required, not optional** — those repos run mutation testing weekly in CI and must clear the floor, because their tests are the only safety net (a data/payload push has no release gate, §7). Everywhere else it is strongly recommended and run on the highest-value code (the private rulesets, L1 pure transforms) as capacity allows.

---

# Part II — Per-stack playbooks

These playbooks are the concrete, current realization of Part I for each test stack in the ecosystem. Each one answers the same questions from these rules — runner & coverage gate, faking the network connection, no real time delays, reachability, contract source, stack gotchas — grounded in the actual configs and tests in each repo.

### Playbook: TypeScript + Jest — Node/service/library (fc-backend, fc-shared, scraper, scraper-rulesets, fc-lookup)

**Current state:** The four configured repos share a solid, consistent base — `ts-jest` preset, `testEnvironment: 'node'`, per-test DB isolation, and real coverage of models/controllers/extractors (fc-backend spins a real Mongo via `mongodb-memory-server` in `tests/testSetup.ts`; scraper-rulesets already contract-tests the plugin boundary in `src/__tests__/plugin.test.ts`; scraper uses `supertest` + a Puppeteer module mock). The concrete gap: external HTTP is mocked at the *client*, not the network connection — scraper's `webhookClient.test.ts` does `(global as any).fetch = jest.fn()` and backend stubs axios calls — so contract drift in URLs, headers, retries, and status handling goes untested. MSW is not a dependency in any repo. Secondary gaps: no coverage threshold is set in any config (only `collectCoverageFrom`), and fc-lookup has **no test script, no jest, and zero tests** despite shipping real HTTP (`src/fetcher.ts` uses global `fetch` + `AbortController`) and cheerio parsing.

**Runner and coverage:** Jest via `ts-jest` (`preset: 'ts-jest'`), config `jest.config.js` per repo, transform pinned to `tsconfig.test.json` with `diagnostics.warnOnly: true`. Current coverage gate: **none enforced** — configs only list `collectCoverageFrom`, so CI cannot fail on regressions. Recommended: add a `coverageThreshold.global` of `{ lines: 85, branches: 85, functions: 85, statements: 85 }` (matches the org's stated 85% bar) to each config, and scaffold fc-lookup with the same preset (`"test": "jest"`, add `jest`, `ts-jest`, `@types/jest`).

**Fake the network connection (HTTP/external):** MSW v2 (`msw/node`), intercepting at the network layer so the real `axios`/`fetch` client code runs unchanged — do **not** replace `global.fetch` or `jest.mock('axios')`. Minimal current API:
```ts
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

const server = setupServer(
  http.post('http://backend:5050/webhooks/item-complete', () =>
    HttpResponse.json({ ok: true }, { status: 200 })),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// per-test override (e.g. force a 500 to test retry):
server.use(http.post('http://backend:5050/webhooks/item-complete',
  () => new HttpResponse(null, { status: 500 })));
```
This covers axios in fc-backend/scraper and global `fetch` in scraper webhookClient and fc-lookup's `fetchPage`. Reserve `testcontainers` (already a scraper dep) for cases that need a *real* dependency process (DB/redis/container) rather than an HTTP contract; reserve `supertest` for the service's own API.

**Determinism / no real time delays:** Use Jest fake timers — `jest.useFakeTimers({ advanceTimers: true })` (already the pattern in scraper's `scrapeQueueProcessing.test.ts` and backend's `staleSessionMonitor.test.ts`) and drive elapsed time with `await jest.advanceTimersByTimeAsync(ms)` so promise microtasks flush. For retry/backoff (scraper `webhookClient`) prefer advancing fake timers over the current trick of mutating `webhookRetryConfig.baseDelayMs = 1`; for ordering, resolve a deferred promise rather than waiting. No-real-sleep rule for this stack: never `await new Promise(r => setTimeout(r, n))` and never lower real delays to "fast enough" — a test that consumes real clock time is a flake; advance the fake clock instead.

**Async dispatch boundary:** the in-process queue/worker surfaces (`scraper/src/services/scrapeQueue.ts` `setInterval` processing, `syncOrchestrator.ts`, `fc-backend/src/services/staleSessionMonitor.ts`, `webhookClient` retry/backoff) are enqueue→drain→side-effect pipelines, and fake timers cover the *timer* but not the *dispatch contract*. Assert the path deterministically by driving the processor with `jest.advanceTimersByTimeAsync` and checking **ordering** plus **each job's terminal state** (done / failed / retried / dead-lettered) — NOT by mutating `baseDelayMs = 1` (the playbook flags that as a smell). For `webhookClient`, assert the retry/backoff schedule by advancing fake timers and counting deliveries fed through the **faked network connection (MSW)**, not by shrinking real delays. State the **dispatch contract** each worker must test — at-least-once delivery, max-retries, dead-letter — and have a test that proves each holds.

**Reachability (preconditions):** Establish auth the way the app does. For fc-backend's own API, mint a JWT with `generateTestToken(userId)` (from `tests/setup.ts`, signs with `process.env.JWT_SECRET`) and send `request(app).get('/...').set('Authorization', `Bearer ${token}`)` against `createTestApp()` (`tests/helpers/testApp.ts`) — matching `lookupRoutes.test.ts`. For the proprietary plugin boundary (scraper-rulesets), construct the real precondition object the engine passes — a `PluginContext` with `logger`, `config`, and `services` (`EngineServices`) — and call `plugin.register(registry, context)` exactly as `plugin.test.ts` does. For the (not-yet-built) entitlement gate, the precondition is a valid signed license/token in the env/context; an authorized load supplies a correctly-signed token, the denied case omits/expires it, and the tampering case mutates the payload so the signature check must fail.

**Contract source:** Single source of truth, in priority order: (1) `@figurecollecting/fc-shared` types (`fc-shared/src/types/index.ts`: `User`, `IRelease`, `CollectionStatus`, etc.) for figure/user payloads shared across backend/frontend; (2) the gRPC protos under `protos/figure_collector/v1/*.proto` (`scraper_service.proto`, `messages.proto`) for backend↔scraper service messages; (3) the plugin interfaces in `scraper-rulesets/src/types.ts` (`ScraperPlugin`, `ExtractionRegistry`, `PluginContext`, `EngineServices`, `ExtractedData`) for the engine↔ruleset boundary. Build fixtures from these types (don't hand-roll shapes) so a contract change breaks compilation, not just assertions.

**Proprietary-plugin angle (scraper-rulesets / fc-lookup):** Two boundaries must be contract-tested. (a) **Plugin-API boundary** — already started in `plugin.test.ts`: assert `register()` calls `registry.registerSite`/`registerRuleset` for every shipped site, each ruleset's `siteId`/`version`, and that `extract()`/`validate()` honor the `ExtractedData`/`ValidationResult` shapes from `types.ts`; mock `PluginContext` services with `jest.fn()` (never reach the network). (b) **Entitlement/token gate** (strategic boundary per the engine/data-separation plan — not yet in code, so write the tests against the intended loader API): authorized load succeeds (valid signed token → plugin registers, sites appear in the registry); unlicensed denied (missing/expired token → `register()` rejects or registry stays empty, no site exposed); tampering rejected (token payload or ruleset bytes mutated → signature/integrity check throws and nothing registers). Keep all three deterministic — sign tokens with a fixed test key, and use fake timers for any expiry check rather than real elapsed time.

**Stack gotchas:**
- MSW does **not** officially support Jest (per MSW docs); it works but needs `testEnvironment: 'node'` (already set) so axios uses Node's http adapter MSW can intercept — under jsdom axios picks the XHR adapter and MSW/node won't catch it. Keep node env for all these service/library suites.
- `onUnhandledRequest: 'error'` is what makes MSW a *contract* test (an un-mocked URL fails loudly); without it, drift passes silently — the failure mode the current `global.fetch` stubs already have.
- `mongodb-memory-server` downloads a binary on first run; in CI cache it and bump `serverSelectionTimeoutMS` (fc-backend sets 5000ms) — cold downloads cause first-run timeouts. fc-backend has two competing setups (`tests/setup.ts` connects to a real localhost Mongo with a try/catch fallback; `tests/testSetup.ts` uses the memory server) — standardize on the memory-server path so suites don't silently "use mocked tests" when no Mongo is present.
- `ts-jest` here runs with `diagnostics.warnOnly: true`, so type errors in tests won't fail the run — rely on a separate `tsc --noEmit` (scraper-rulesets already wires this as `lint`) to catch contract-type breakage.
- Mock-reset config differs per repo (scraper/scraper-rulesets set `clearMocks/resetMocks/restoreMocks: true`; fc-backend/fc-shared don't) — when adding MSW, always `server.resetHandlers()` in `afterEach` regardless, since handler state lives outside Jest's mock registry.
- fc-lookup's `fetchPage` aborts after 15s via real `setTimeout` + `AbortController`; test the timeout path with fake timers (`advanceTimersByTimeAsync(15000)`) plus an MSW handler that uses `await delay('infinite')`, not a real slow server.

### Playbook: TypeScript + Jest + React Testing Library (jsdom) (fc-frontend)

**Current state:** fc-frontend tests with react-scripts/Jest under jsdom and React Testing Library, with a custom `render()` wrapping Chakra+Router+react-query+Helmet (`src/test-utils.tsx`) and jest-axe already wired in `src/setupTests.ts`. The concrete gap is the network connection: a hand-written axios stub with a hardcoded `responseMap` (`src/test-utils/mocks/axios.js`) is injected via `moduleNameMapper` and ALSO re-mocked in `setupTests.ts`, so two divergent fake clients drift from the real one; `src/api/__tests__/index.test.ts` rebuilds the axios instance + interceptors by hand and asserts against its own mock (a test that can never fail, because it only checks the fake object the test itself created). Gated views `jest.mock('../stores/authStore')` instead of seeding the real zustand store, and several tests reach for raw `setTimeout`.

**Runner and coverage:** Jest via `react-scripts test` (config in `jest.config.js`, `testEnvironment: 'jsdom'`, setup in `src/setupTests.ts`). Current gate is low (`coverageThreshold.global` = branches 40 / functions 50 / lines 60 / statements 60). Recommend raising to lines/statements 80, functions 75, branches 75 (the **authorized intermediate step** per §5 — branches at ≥75 rather than the project floor of 70, to keep room to climb) once the faked network connection below stops forcing untested error paths; the **final target is 85 across all four metrics** once the network-connection-faking cleanup lands. `collectCoverageFrom` already correctly excludes test-utils/mocks.

**Fake the network connection (HTTP/external):** Fake the connection at the HTTP layer with **MSW v2** (`setupServer` from `msw/node`), not the axios object. Delete the `^axios$` `moduleNameMapper` entry and the `jest.mock('axios')` in `setupTests.ts`; let axios issue a real request that MSW intercepts. Drive responses by URL+payload so tests fail when the real API contract changes:
```ts
// src/test-utils/server.ts
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

export const server = setupServer(
  http.get('*/api/figures', () =>
    HttpResponse.json({ success: true, data: [], count: 0, total: 0 })),
  http.post('*/api/auth/login', async ({ request }) => {
    const { email } = (await request.json()) as { email: string };
    return HttpResponse.json({ data: { user: { id: '123', email, token: 'jwt' } } });
  }),
);
// setupTests.ts
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```
Override per-test with `server.use(http.get('*/api/figures', () => new HttpResponse(null, { status: 500 })))`.

**Determinism / no real time delays:** Use `jest.useFakeTimers()` + `jest.advanceTimersByTime(ms)` (already done correctly in `useTokenRefresh.test.ts`), never raw `setTimeout`/`await new Promise(r => setTimeout(r, ...))`. For async UI, await RTL's `findBy*`/`waitFor` (retry-until-true), not a fixed delay. With fake timers + `@testing-library/user-event` v14, create the user with `userEvent.setup({ advanceTimers: jest.advanceTimersByTime })`. No real sleeps: a test must never block on the OS clock — advance virtual time or poll the DOM.

**Reachability (preconditions):** Seed the REAL zustand store instead of `jest.mock('../stores/authStore')`. The store is `useAuthStore` (`src/stores/authStore.ts`); in `beforeEach` set state via the public action so derived flags/persistence stay consistent: `useAuthStore.getState().setUser({ _id: '1', email: 'test@example.com', token: 'jwt' })` (sets `isAuthenticated`), then reset with `useAuthStore.getState().logout()` in `afterEach`. Render gated pages through the project `render()` from `src/test-utils.tsx` (passing `initialRoutes`) so Chakra/Router/react-query/Helmet match production.

**Contract source:** Local TypeScript types in `src/types/index.ts` (e.g. `Figure`, `User`, `PaginatedResponse`) are the source of truth — there is no `@figurecollecting/fc-shared` package or proto/OpenAPI artifact in this repo. Type MSW fixtures against those interfaces (e.g. `HttpResponse.json<PaginatedResponse<Figure>>(...)`) so a backend contract change surfaces as a compile error.

**Stack gotchas:** MSW v2 is not officially supported under Jest+jsdom — jsdom lacks `TextEncoder`/`Response`/`fetch`/streams, so `msw/node` throws on import. Use the `jest-fixed-jsdom` test environment (or set `testEnvironment: 'node'` for pure api/* tests, or polyfill undici `TextEncoder`/`ReadableStream`/`Response` in setup) and keep `testEnvironmentOptions.customExportConditions: ['']` so MSW resolves Node exports. Also remove the global `global.fetch = jest.fn()` stub in `setupTests.ts` — it shadows MSW's interception. Note the existing `react-app` preset (CRA) pins an older Jest; if MSW v2's import conditions misbehave, the cleanest fix is migrating off `react-scripts test` to a standalone Jest 29/30 config (already partially present in devDependencies).

### Playbook: TypeScript + Vitest + Preact (@testing-library/preact) (fc-mobile)

**Current state:** fc-mobile is the best example to copy — behavior-driven hook tests (`renderHook` from `@testing-library/preact`), `fake-indexeddb/auto` for the offline IndexedDB cache, deferred-async mocks at the `@figurecollecting/fc-shared` client connection point, and a Playwright e2e reachability smoke (`e2e/smoke.spec.ts`). The one real gap: `vitest.config.ts` configures `coverage` (v8 provider, `include` scoped to `src/hooks/**` + `src/pages/**`) but defines NO `thresholds`, so coverage is measured (`text`/`html`/`lcov`) yet never enforced — the comment even concedes "we don't force a threshold." Add a per-file gate on the critical hooks layer.

**Runner and coverage:** Vitest 4 (`vitest run`), config `vitest.config.ts`, environment `jsdom`, `globals: true`, setup `./src/test/setup.ts`. Coverage uses `@vitest/coverage-v8`. Current gate: none (informational only). Recommended — add a `thresholds` block; in Vitest 4 use `perFile: true` plus a per-glob override so the essential hooks layer is enforced without forcing it on JSX-heavy pages:
```ts
coverage: {
  provider: 'v8',
  include: ['src/pages/**/*.{ts,tsx}', 'src/hooks/**/*.{ts,tsx}'],
  thresholds: {
    perFile: true,
    'src/hooks/**': { lines: 85, functions: 85, branches: 85, statements: 85 },
  },
}
```
Caveat: glob thresholds do NOT inherit the global thresholds, and Vitest (unlike Jest) also counts glob-matched files into the GLOBAL thresholds — so adding a global block later would double-count the hooks files. Keep the hooks gate glob-only. Run with `npm run test:coverage` (`vitest run --coverage`).

**Fake the network connection (HTTP/external):** Fake at the module connection point the app actually calls, NOT a raw `fetch`/axios object. fc-shared API functions take an injected `AxiosInstance` (the app builds an authed client via `createApiClient`/`createSimpleApiClient` in `src/api/client.ts`), so tests `vi.mock('@figurecollecting/fc-shared')`, spread `importActual`, and stub only the called functions — no MSW (it appears only transitively in node_modules, not in deps):
```ts
vi.mock('@figurecollecting/fc-shared', async () => {
  const actual = await vi.importActual<typeof import('@figurecollecting/fc-shared')>('@figurecollecting/fc-shared');
  return { ...actual, validateMfcCookies: vi.fn(), executeFullSync: vi.fn() };
});
import { executeFullSync } from '@figurecollecting/fc-shared';
const mockedExecute = executeFullSync as unknown as ReturnType<typeof vi.fn>;
mockedExecute.mockResolvedValueOnce({ success: true, parsedCount: 10, queuedCount: 10, skippedCount: 0, errors: [] });
```
For Playwright e2e, fake the connection at the network edge with `page.route(/:5080\/api\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {} }) }))` (host-anchored regex so Vite's own module requests aren't swept up).

**Determinism / no real time delays:** Two complementary mechanisms. (1) Deferred async: drive React Query / promise resolution with `act` + `await waitFor(() => expect(result.current.isSuccess).toBe(true))` and resolve mocks via `mockResolvedValueOnce`/`mockRejectedValueOnce` — never poll real time. (2) For timer/`Date`-driven code use Vitest fake timers and advance the clock explicitly:
```ts
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
await vi.advanceTimersByTimeAsync(150); // flushes async-scheduled timers too
vi.useRealTimers(); // restore (setup.ts already calls vi.restoreAllMocks() in afterEach)
```
Rule: never `await new Promise(r => setTimeout(r, …))` against the real clock — advance fake timers or await a `waitFor` assertion instead.

**Reachability (preconditions):** A test reaches "authenticated/gated" state the same way the runtime does — by seeding the zustand auth store the API client reads from (`useAuthStore.getState().user?.token`). Set `useAuthStore.setState({ user: { _id, username, email, isAdmin: false, token: 'tok', tokenExpiresAt: Date.now()+60_000 }, isAuthenticated: true, lastActivity: Date.now(), twoFactorPending: null })`; `setup.ts` resets it to signed-out in `afterEach`. For React Query hooks, wrap in a `QueryClientProvider` with `retry: false`. In e2e, seed `localStorage` via `page.addInitScript` before boot (e.g. `onboarding_complete`, clear `auth-storage`) and fulfill `/auth/register` with tokens to land authenticated.

**Contract source:** `@figurecollecting/fc-shared` (linked `file:../figure-collector-services/fc-shared`) is the single source of truth — it owns the request/response TS types (`MfcSyncResult`, `MfcCookieValidationResult`, etc.) and the API functions. Fixtures and mock return shapes must match those exported types; tests `importActual` from it so non-mocked types/helpers stay real.

**Stack gotchas:** The preact/compat single-instance trap is the dominant pitfall. `vitest.config.ts` aliases `react`/`react-dom`/`react/jsx-runtime` to `preact/compat`, `dedupe`s `['preact','preact/hooks','preact/compat','zustand']`, and inlines third-party ESM (`zustand`, `wouter`, `framer-motion`, `@tanstack/react-query`, `@figurecollecting/fc-shared`, `preact`) via `server.deps.inline` so the alias applies transitively — otherwise Node ESM bypasses the alias and you get a second Preact copy and `Cannot read properties of undefined (reading '__H')`. `use-sync-external-store/shim` (pulled by wouter/zustand) `require("react")` at runtime and pierces the alias, so it's redirected to a local shim (`src/test/useSyncExternalStoreShim.ts`) re-exporting `useSyncExternalStore` from `preact/compat`. Other traps: jsdom stubs `matchMedia`/`IntersectionObserver`/`ResizeObserver` as undefined — install polyfills in `setup.ts` BEFORE importing modules that read them at import time; swapping `globalThis.indexedDB` does NOT reset state because `storage/db.ts` caches the db handle, so clear via the live connection (`db.clear('figures'|'metadata'|'pendingOps')`) in `afterEach`; and use `@preact/preset-vite` with `reactAliasesEnabled: false` since the aliases are managed manually.

### Playbook: Python + pytest (FastAPI + SQLAlchemy + Celery) — media-manager

**Current state:** media-manager has a genuinely good harness skeleton in `tests/conftest.py`: a `client` fixture wires `app.dependency_overrides[get_db]`/`[get_settings]`, dev-token auth header factories (`auth_headers`, `service_headers`, `make_auth_headers`), and an ownership helper (`link_image_to_user`); route and worker tests are real (`tests/test_upload_flow.py`, `tests/test_workers_coverage.py`). The concrete gap is the database boundary: every test runs against in-memory SQLite (`sqlite://` + `StaticPool`) with `@compiles(UUID/CITEXT, "sqlite")` rewrites turning them into `TEXT`, so the Postgres-only code paths are never exercised — `app/search.py:build_text_filter` has an `is_postgres()` branch that silently falls back to ILIKE on SQLite, meaning the production `to_tsvector`/`plainto_tsquery`/`@@` full-text path, the `ARRAY` `&&` tag-overlap operator, and real `CITEXT`/`UUID` semantics get zero test coverage. Secondary gaps: external HTTP is mocked at the client object (`patch("app.workers.tasks.httpx")`) rather than the network connection, and Celery tasks are tested by calling the function directly with `.delay` patched to a `MagicMock` no-op rather than through the task machinery.

**Runner and coverage:** pytest 8.3 with pytest-cov 7.0 (`poetry run pytest`), driven entirely from the CLI — there is no `[tool.pytest.ini_options]` block in `pyproject.toml` and no `pytest.ini`/`tox.ini`, and `pytest-asyncio ^0.23` is installed but `asyncio_mode` is unset (add `[tool.pytest.ini_options]` with `asyncio_mode = "auto"` so async tests don't need per-test markers). CI runs `pytest --cov=app --cov-report=xml --cov-report=term-missing` with Codecov `fail_ci_if_error: false` and no `--cov-fail-under`, so coverage is report-only and cannot fail a PR. Recommend gating in pyproject: `[tool.coverage.report] fail_under = 85` (or add `--cov-fail-under=85` to the CI invocation), matching the 85% org standard, then raise it over time.

**Fake the network connection (HTTP/external):** Use **respx** (the httpx-native transport-layer mock) — the app calls `httpx.get(url, timeout=30)` directly at `app/workers/tasks.py:276` in `ingest_gallery_images`. `responses` is only a transitive lock entry and is unused; it targets `requests`, not httpx, so it is the wrong tool here. Replace the current `patch("app.workers.tasks.httpx")` (which mocks the client object and would mask a real httpx call-site change) with a route registered at the URL connection point:
```python
import httpx, respx
@respx.mock
def test_ingest_downloads(db_session):
    respx.get("https://mfc.net/1.jpg").mock(
        return_value=httpx.Response(200, content=png_bytes))
    ingest_gallery_images(figure_id="mfc-1",
                          images=[{"url": "https://mfc.net/1.jpg", "position": 0}])
```
Keep **moto** (`mock_aws`) for the S3/boto3 boundary and **fakeredis** for Redis — both are already dev deps and are the correct process-boundary fakes for those clients.

**Determinism / no real time delays:** Use **freezegun**'s `freeze_time` — the app stamps rows with `dt.datetime.now(dt.timezone.utc)` (model `created_at`/`updated_at`/`deleted_at` defaults, soft-delete in `image_routes.py`/`gallery_routes.py`/`album_routes.py`) and computes JWT `iat`/`exp` from `now()` in `app/auth.py`. Freeze the clock to make token-expiry and soft-delete-ordering tests deterministic; advance with the injected factory instead of sleeping:
```python
from freezegun import freeze_time
@freeze_time("2026-06-09T00:00:00Z", as_arg=True)
def test_token_expires(frozen, make_auth_headers, client):
    headers = make_auth_headers()
    frozen.tick(delta=datetime.timedelta(minutes=90))  # past token_exp_minutes
    assert client.get("/images/1", headers=headers).status_code == 401
```
No-real-sleep rule in stack terms: never `time.sleep()` to wait out a TTL, token expiry, or rate-limit window — move the frozen clock with `.tick()`/`.move_to()`. For deferred async, drive resolution off a real await point rather than real elapsed time: `await` a respx-mocked response (the route's `return_value`/`side_effect` resolves the awaitable deterministically), or hold a pending state open with an `asyncio.Event` you `.set()` to release — `await event.wait()` resumes the moment you signal, never on a timer. Don't `await asyncio.sleep(n)` for real elapsed time.

**Reachability (preconditions):** Mint a real JWT the way the app does, not a hand-rolled header. conftest already exposes `auth_headers` (regular user), `service_headers` (`scopes=["assets:read"]`), and the `make_auth_headers(subject=..., tenant_id=..., scopes=...)` factory — all call `app.auth.create_token` against the test `Settings(jwt_secret="test-secret", allow_dev_tokens=True)`, and the `client` fixture overrides `get_db`/`get_settings` and clears the `lru_cache` so the test settings take effect. For resource-level gating (ownership), seed a `UserImageLink` via the `link_image_to_user` fixture so `require_auth_ctx`/policy checks (`app/policy.py`) see the caller as `owner`. For the Celery-eager option below, ownership/state still comes from the seeded DB rows, not from request headers.

**Contract source:** OpenAPI generated by FastAPI plus the Pydantic v2 request/response models in `app/schemas.py` (e.g. `CreateExternalRefRequest`, `ExternalAssetResponse`) are the source of truth for request/response fixtures — there is no `@figurecollecting/fc-shared` import and no protobuf/gRPC in this service. Build fixture payloads from those Pydantic models (or assert responses against them) so a schema change breaks the test; for cross-service consumers, treat the app's `/openapi.json` as the contract.

**Stack gotchas:**
- **SQLite-as-Postgres is the headline trap (Rule 6 — Test against the real database engine).** The `@compiles` rewrites and the `is_postgres()` ILIKE fallback mean tests pass while the real `to_tsvector`/`@@` FTS, `ARRAY`/`&&` overlap, `CITEXT` case-insensitive uniqueness, and native `UUID` behavior go untested. Stand up a real Postgres for DB-boundary tests — **testcontainers-python** (`PostgresContainer`) or a CI `services: postgres` container — run Alembic migrations against it, and drive the FTS/tag/`CITEXT` paths there. Add a smoke test that fails if `to_tsvector(...)` is unavailable (so a substituted/wrong engine can't pass), and a per-class coverage rule so `app/search.py`'s FTS class specifically hits ≥85. This is the highest-value fix; the SQLite engine can stay for fast unit tests but must not be the only DB.
- **Celery isn't really tested.** `make_celery()` binds a real Redis broker, and conftest patches each task's `.delay` to a `MagicMock`, so route tests only assert "a task was enqueued," and worker tests call task functions directly with `worker_session` monkeypatched. For task-dispatch coverage use Celery's pytest plugin with `task_always_eager=True` + `task_eager_propagates=True` (and `task_store_eager_result=True` if you assert results) via a `celery_config` fixture / `@pytest.mark.celery(task_always_eager=True)`, so `.delay()` runs the task synchronously and exercises the enqueue-to-execute path. Note Celery's own docs caution eager mode only emulates a worker — keep direct-call unit tests for transform/image logic and reserve eager mode for the dispatch boundary.
- **CI is report-only and lint-strict.** No `--cov-fail-under` means coverage regressions land silently; meanwhile `ruff check`, `ruff format --check`, and a strict `mypy app/` (disallow_untyped_defs, warn_unreachable) gate the build, so new test helpers must be typed and formatted or CI fails before tests run.
- **Stray fixture hygiene:** committed `test_debug*.db` and a root `.coverage` indicate prior runs leaked SQLite files; ensure DB fixtures are in-memory or temp-pathed and gitignored so artifacts don't accumulate.

### Playbook: Java + JUnit5 + Spring Boot (library-api, and any future JVM/Spring services)

**Current state:** library-api is the best example to copy on the JVM: JUnit5 + `spring-boot-starter-test`, real Testcontainers (Postgres 16 + Redis 7) in `BaseIntegrationTest`, WireMock `@WireMockTest` for every external provider (MusicBrainz/Google Books/IGDB/TMDB/etc.), and a JaCoCo 85% gate wired into `check`. Concrete gaps: Apache AGE graph code (`CypherQueryBuilder` building `SELECT * FROM cypher(...)`, migration `V2__enable_age_extension.sql`) runs against a plain `postgres:16-alpine` container, so the `cypher()` path is never exercised on real infra; `OAuthTokenManager` reads `Instant.now()` inline, making expiry/refresh logic non-deterministic; and the declared `spring-security-test` dependency is unused.

**Runner and coverage:** Gradle `useJUnitPlatform()` (JUnit Jupiter), config in `build.gradle.kts`. Coverage is JaCoCo with `jacocoTestCoverageVerification` (`minimum = 0.85`) made a dependency of `tasks.check` — this is the bar all FC services should match. Keep the 85% floor; add per-`bundle`/`class` rules (not just an overall ratio) so a thin DTO test can't mask an undertested service class, and consider excluding generated/config classes explicitly rather than letting them inflate the number.

**Fake the network connection (HTTP/external):** WireMock at the process connection — stub the HTTP server, never mock the `RestClient`. library-api already does this correctly:
```java
@WireMockTest
class MusicBrainzProviderTest {
    @BeforeEach void setUp(WireMockRuntimeInfo wm) {
        provider = new MusicBrainzProvider(propsPointingAt(wm.getHttpBaseUrl()), RestClient.create());
    }
    @Test void httpErrorReturnsEmpty() {
        stubFor(get(urlPathEqualTo("/ws/2/release")).willReturn(serverError()));
        assertTrue(provider.lookupByBarcode("0602537491070", "EAN_13").isEmpty());
    }
}
```
The provider's real base URL is overridden to `wm.getHttpBaseUrl()`, so timeouts, 5xx, malformed JSON, and User-Agent headers are all asserted against a real socket.

**Determinism / no real time delays:** Inject `java.time.Clock` and advance it; never `Thread.sleep` to wait out a timer. The repo's `OAuthTokenManager` (`Instant.now().isBefore(tokenExpiry.minusSeconds(REFRESH_BUFFER_SECONDS))`) should take a `Clock` bean so a test can use `Clock.fixed(...)` / a mutable test clock to prove the 5-minute refresh buffer without sleeping. For genuinely async waits (future webhook/sync workers), use Awaitility instead of sleeps:
```java
await().atMost(Duration.ofSeconds(5))
       .untilAsserted(() -> assertThat(repo.findByClientId(id)).isPresent());
```
Rule for this stack: no `Thread.sleep` in tests (none exist today — keep it that way); poll with `await().until(...)`/`untilAsserted(...)` and gate clocks with injected `Clock`.

**Reachability (preconditions):** Two faithful patterns. For full integration tests, establish auth the way the app does — register/login over the real endpoint and send a real bearer token, exactly as `CatalogIntegrationTest`/`SyncIntegrationTest` do (`headers.setBearerAuth(authToken)`), which also exercises the `JwtService`/jjwt filter and asserts 401 on missing auth. For sliced controller tests, add `spring-security-test` (already on the classpath, currently unused): `@WithMockUser` or `mockMvc.perform(get(...).with(user("u").roles("USER")))`. Note this app uses a custom jjwt bearer filter, NOT Spring resource-server — so `SecurityMockMvcRequestPostProcessors.jwt()` would not match its filter chain; prefer `user(...)`/`@WithMockUser` for sliced tests and the real token flow for end-to-end.

**Contract source:** OpenAPI via springdoc (`springdoc-openapi-starter-webmvc-ui`) is the source of truth for the HTTP boundary — `OpenApiIntegrationTest` already asserts `/v3/api-docs` serves the live spec; treat that generated schema as the fixture contract for request/response shapes. For cross-service contracts, use the shared protos/gRPC definitions (consumer derives fixtures from the proto, not from hand-copied JSON).

**Stack gotchas:** (1) Testcontainers image mismatch (Rule 6 — Test against the real database engine) — `BaseIntegrationTest` uses `postgres:16-alpine`, which has no AGE extension, so `cypher()`/`CypherQueryBuilder` paths and `V2__enable_age_extension.sql` are silently skipped. Add a smoke test that fails if `cypher(...)` is uncallable, and a per-class coverage rule so `CypherQueryBuilder` hits ≥85. To cover the graph boundary, run those tests against the official AGE image marked compatible with the Postgres module: `new PostgreSQLContainer<>(DockerImageName.parse("apache/age:release_PG16_1.6.0").asCompatibleSubstituteFor("postgres"))` (use `apache/age:dev_snapshot_PG16` if you want the rolling build — `PG16_latest` is not a real tag), then `LOAD 'age'; SET search_path = ag_catalog, "$user", public;` before querying. (2) `--enable-preview` is set in `jvmArgs` for Java 25 — every test JVM (and CI) must pass the same flag or classes fail to load. (3) Redis is a bare `GenericContainer` with `withExposedPorts(6379)` wired via `@DynamicPropertySource`; remember `getMappedPort(6379)`, not the fixed port. (4) Static-init containers in `BaseIntegrationTest` are shared across the suite (fast) but state leaks between tests — note how the suite sidesteps this with unique `System.nanoTime()` emails/barcodes per test rather than truncating tables.

### Playbook: Kotlin + JUnit4 + Android / Jetpack Compose (library-mobile)

**Current state:** library-mobile is an offline-first Compose app (AGP 9.0.1, Kotlin 2.2.10, Hilt, Room, Retrofit/Moshi) with a strong JVM unit suite already: MockK, Turbine, `kotlinx-coroutines-test`, Robolectric-driven Compose `ui-test`, and a Room in-memory androidTest. Two gaps must be closed by this playbook: there is **no CI** (`.github/workflows` is absent, unlike the `library-api` sibling which ships `build.yml`/`codeql.yml`/`security-scan.yml`), and coverage is **report-only** — `tasks.register<JacocoReport>("jacocoTestReport")` emits XML/HTML but enforces no threshold. A latent gap: `okhttp-mockwebserver` is declared but used by zero tests — every network test mocks the Retrofit `*Api` interface directly (`mockk<AuthApi>()`, hand-rolled `FakeCollectionApi`), so the Moshi+Retrofit serialization boundary is never crossed.

**Runner and coverage:** Runner is **JUnit4** on the Gradle JVM unit-test path: `./gradlew :app:testDebugUnitTest` (Robolectric supplies the Android runtime via `testOptions.unitTests.isIncludeAndroidResources = true`); instrumented reachability runs via `:app:connectedDebugAndroidTest`. Coverage tool is **JaCoCo 0.8.13** (pinned in the `jacoco {}` block for JDK 25 bytecode), driven by `enableUnitTestCoverage = true` on the debug buildType. Current gate: **none** (report-only). Recommended: add a `JacocoCoverageVerification` task reusing the same class/exec wiring as the existing report and **fail CI below 85% line / 85% branch** on the already-scoped business layers (`data/repository/**`, ViewModels, `domain/error`, `domain/sync`), so the gate matches what's actually report-scoped today:
```kotlin
tasks.register<JacocoCoverageVerification>("jacocoCoverageVerification") {
    dependsOn("jacocoTestReport")
    classDirectories.setFrom(tasks.named<JacocoReport>("jacocoTestReport").get().classDirectories)
    sourceDirectories.setFrom(files("src/main/kotlin", "src/main/java"))
    executionData.setFrom(tasks.named<JacocoReport>("jacocoTestReport").get().executionData)
    violationRules { rule { limit { counter = "LINE"; minimum = "0.85".toBigDecimal() }
                            limit { counter = "BRANCH"; minimum = "0.85".toBigDecimal() } } }
}
tasks.named("check") { dependsOn("jacocoCoverageVerification") }
```
CI: add `.github/workflows/build.yml` running `actions/setup-java` (Temurin 17, matching `compileOptions` `VERSION_17`) + `gradle/actions/setup-gradle`, then `./gradlew :app:testDebugUnitTest :app:jacocoCoverageVerification` on push/PR, and upload the JaCoCo XML to Codecov to mirror `library-api`. Keep `connectedAndroidTest` (emulator) off PRs — instrumented tests are manual/nightly, consistent with the consumer-owns-boundaries rule.

**Fake the network connection (HTTP/external):** Fake the connection at the **socket** with `okhttp3.mockwebserver.MockWebServer` (already a declared dep — `com.squareup.okhttp3:mockwebserver:4.12.0`, the classic `okhttp3.mockwebserver` package, *not* the `mockwebserver3` package), pointing a **real Retrofit + Moshi** client at it so DTO (de)serialization is actually exercised. Key the API discriminator off the **package**, not the version: 4.12 ships only `okhttp3.mockwebserver` (mutable `setBody`/`setResponseCode`/`shutdown`), while 5.x ships *both* artifacts — so a 5.x classpath still resolves `okhttp3.mockwebserver` and `mockwebserver3` differs (immutable `MockResponse` builder, `close()`). Match the snippets to the package you import, not the dependency version string. Do NOT `mockk<...Api>()` the Retrofit interface (the current pattern) for boundary/contract tests (the L2 layer, where the network is under test) — that skips the converter. Minimal current-API example:
```kotlin
private lateinit var server: MockWebServer
private lateinit var api: AuthApi

@Before fun setUp() {
    server = MockWebServer().apply { start() }
    api = Retrofit.Builder()
        .baseUrl(server.url("/"))                     // 4.12 API: HttpUrl from server
        .addConverterFactory(MoshiConverterFactory.create(Moshi.Builder().build()))
        .build().create(AuthApi::class.java)
}
@After fun tearDown() = server.shutdown()              // 4.12: shutdown(), not close()

@Test fun `login deserializes auth response`() = runTest {
    server.enqueue(MockResponse().setResponseCode(200)
        .setBody("""{"token":"t","userId":"u","email":"a@b.c","displayName":"A","refreshToken":"r"}"""))
    val res = api.login(LoginRequest("a@b.c", "pw"))
    assertEquals("t", res.body()!!.token)
    assertEquals("/auth/login", server.takeRequest().path)   // verify the wire contract
}
```
Use `enqueue(MockResponse().setResponseCode(401)...)` / `SocketPolicy.DISCONNECT_AT_START` to drive the 401/403/503/IO branches that `AuthRepositoryTest` and `OfflineFirstRepositoryTest` currently fake at the interface.

**Determinism / no real time delays:** Use `kotlinx-coroutines-test` (1.10.2): wrap every coroutine test in `runTest { }` and inject a `StandardTestDispatcher()` as `Dispatchers.setMain(dispatcher)` in `@Before` / `Dispatchers.resetMain()` in `@After` — exactly the `LoginViewModelTest` pattern. Drive ViewModel `viewModelScope` work to completion with `advanceUntilIdle()` (never read `uiState.value` before advancing), and assert intermediate Flow/StateFlow emissions with **Turbine** `.test { awaitItem() }`. For any time-based logic (debounce, retry backoff, sync timers) advance **virtual** time via `testScheduler.advanceTimeBy(...)` / `advanceUntilIdle()`. **No-real-sleep rule, in this stack:** never `Thread.sleep(...)`, never `Thread.sleep`-style polling of `uiState`, and never call real `delay()` outside the test dispatcher — production `delay()` inside `runTest` is auto-skipped on virtual time, so a passing-but-slow test means you escaped the test dispatcher (e.g. `withContext(Dispatchers.IO)` with an unswapped dispatcher) and must inject the test dispatcher there instead.

**Reachability (preconditions):** Gated screens require an authenticated session, modeled by `SessionManager` (DataStore-backed) and enforced by `TokenAuthenticator` on 401. JVM/Robolectric Compose tests sidestep nav by testing the stateless `*ScreenContent(uiState=..., onSubmit=...)` composables directly with a hand-built `LoginUiState` (see `LoginScreenTest`) — no real login needed. For **instrumented** Espresso/Compose reachability that must pass the auth gate, establish state the way the app does: seed a session before launching the gated screen, e.g. a Hilt test module binding a fake `AuthApi`/repository (or `MockWebServer` returning a valid `AuthResponse`) plus writing tokens through `SessionManager.saveSession(token, userId, email, displayName, refreshToken)`, then drive the Compose login flow (`performTextInput` email/password, `performClick` submit) so navigation reaches the collection screen — rather than deep-linking past auth.

**Contract source:** The source of truth is **library-api's OpenAPI** — the Spring service publishes `springdoc-openapi-starter-webmvc-ui:2.8.15` (`OpenApiConfig.java`) at `/v3/api-docs`. The Android Retrofit interfaces (`AuthApi`, `CatalogApi`, `CollectionApi`, `SyncApi`) and their Moshi DTOs (`AuthResponse`, `CatalogItemResponse`, `CursorPage`, etc.) mirror those endpoints (`auth/login`, `catalog/items`, `collections`, `sync/delta`). There are no protos and no shared `fc-shared` package here, so derive `MockWebServer` JSON fixtures from the live `/v3/api-docs` schema (paths + response shapes) to keep client DTOs honest against the server contract.

**Stack gotchas:** (1) **MockWebServer API package skew** — the discriminator is the package, not the version. The pinned 4.12.0 dep is the classic `okhttp3.mockwebserver` package with mutable `MockResponse().setBody().setResponseCode()` and `server.shutdown()`; do not copy `mockwebserver3` snippets (immutable `MockResponse` builder, `close()`) from current OkHttp docs. 5.x ships both artifacts, so even there the `okhttp3.mockwebserver` import keeps the mutable/`shutdown()` API — match the snippet to the package you actually import. (2) **MockK + Kotlin inline `Result<T>`** — MockK can't reliably stub functions returning `Result<T>`; `LoginViewModelTest` already documents this and works around it by using the real `AuthRepository` over a hand-rolled `AuthApi`. Note the L1/L3-vs-L2 distinction: Rule 2 governs **L2 boundary/contract** tests, where mocking the Retrofit interface (`mockk<...Api>()`) is banned because it skips the Moshi+Retrofit converter — those go through `MockWebServer`. Interface fakes (`mockk<AuthApi>()`, a hand-rolled `FakeCollectionApi`) are **fine in L1/L3 ViewModel/logic tests**, where the network is not under test; the §8 grep therefore only fires on boundary/contract files (`*Api*Test`/`*Network*Test`), and a non-boundary logic test that trips it just adds the `// test-doctrine-allow:` escape hatch. (3) **Robolectric SDK pin** — Compose UI tests run on the JVM only because `isIncludeAndroidResources = true`; tests pin `@Config(sdk = [33])` even though `compileSdk = 36`, since Robolectric ships emulation images lagging the latest SDK — bumping `compileSdk` without a matching Robolectric `@Config`/version will fail to find resources. (4) **JaCoCo class-dir paths are AGP-version-fragile** — the report globs three intermediate dirs (`built_in_kotlinc/...`, `transformDebugClassesWithAsm/...`, `javac/...`) because AGP 9.x relocated outputs; an AGP bump can silently zero out coverage if those paths move, so the verification gate must be smoke-checked (non-empty `executionData`) after any AGP upgrade. (5) **Compose lambdas inflate denominators** — the existing report deliberately includes only `*ViewModel*`/`*UiState` classes and excludes raw Composable `.kt` files; keep that scoping or generated Composable lambdas will tank the percentage and the new gate will fail for the wrong reason.

---

# Appendices

## Appendix A — Anti-pattern gallery (real, from our codebase)

These are the concrete files to fix during the frontend test cleanup. Each is a "do not do this."

- **Real time delays** — `pages/__tests__/AddFigure.test.tsx` (`setTimeout(0)` for mutation success); `components/__tests__/FigureForm.realcoverage.test.tsx` (3s `waitFor` + `<= 2`; 100ms real delay for a spinner).
- **Mock-drift** — `api/__tests__/scraper.test.ts`, `api/__tests__/index.test.ts`, `api/__tests__/index.enhanced.test.ts` (`jest.mock('axios')` + hand-rolled `create` stub; interceptor capture; `Object.assign(mockedAxios, mockApiInstance)`).
- **Over-mock** — `api/__tests__/index.enhanced.test.ts` (`"correct base URL"` and `"configure request interceptor"` asserting only that the mock's own stubs exist).
- **Unreachable-path** — `pages/__tests__/AddFigure.test.tsx` (`"error toast"` never wires the error mock); `components/__tests__/FigureForm.conditions.test.tsx` (`"cleanup on unmount"`, zero assertions).

## Appendix B — Reachability patterns (auth precondition)

Auth is a Zustand store (`useAuthStore`), **not** a React context. `ProtectedRoute` reads `isAuthenticated` from it.

- **Pattern B — seed the real store (THE DEFAULT).** This is the single documented default for every stack with a real auth store (fc-frontend, fc-mobile). It satisfies Rule 3 by establishing the precondition the way the runtime does:
  ```ts
  useAuthStore.setState({ user: mockUser, isAuthenticated: true, lastActivity: Date.now() });
  ```
- **Pattern A — mock the store (LEGACY / LAST-RESORT, discouraged).** `jest.mock('../../stores/authStore')` is the exact anti-pattern the fc-frontend playbook and Rule 3 forbid — it fakes the precondition away instead of establishing it. Use it **only when the store genuinely cannot be imported in the test env** (a real constraint, not convenience), and prefer fixing the import over reaching for it:
  ```ts
  jest.mock('../../stores/authStore');
  (useAuthStore as jest.MockedFunction<typeof useAuthStore>)
    .mockReturnValue({ user: mockUser, isAuthenticated: true, /* ... */ });
  ```
  If the unit reads `useAuthStore.getState()` statically (e.g. `useTokenRefresh`), you **must also** stub `getState` — this default-only sets the hook return.

**Codify:** a typed `renderAuthenticated(ui, { user })` helper that seeds the real store (Pattern B) then delegates to the shared render. **Delete** the orphaned `fc-frontend/src/test-utils/mocks/auth.ts` — it models a React-context shape that does not match the Zustand store and is imported by zero tests; it will mislead anyone copying a pattern from it.
