# Testing Doctrine — Rollout Tracker

**Companion to `TESTING.md` §9 (Rollout).** That section defines the *strategy* (adopt positive
controls before the hard ban, per repo). This file is the *operational tracker*: the measured
baseline as of the survey date, and a concrete, file-level, sequenced checklist per repo. When a
step lands, check it off here and update the baseline.

**Survey date:** 2026-06-09 (fc-frontend, fc-backend, scraper surveyed in full; fc-shared already
done; fc-mobile / catalog-* / image-manager / fc-lookup not yet re-surveyed for this tracker).

**Nothing here is merged into a service repo yet** — this tracker exists so each adoption lands as a
reviewed PR against a known baseline, not a blind sweep.

---

## Measured baseline (actual coverage, not configured thresholds)

These are the numbers a real `--coverage` run produced (from each repo's committed
`coverage-summary.json` / `lcov-report`), which is the ratchet starting point under §5
("the number can only go up"). Note the gap between *configured* and *measured* — fc-frontend's
`jest.config.js` declares 40/50/60 but actually sits much higher, and that config is **dead**
anyway (see its prereq below).

| Repo | Runner | Tests | Lines | Stmts | Funcs | Branches | Gate today | MSW? |
|------|--------|------:|------:|------:|------:|---------:|------------|------|
| **fc-shared** | jest + ts-jest (node) | 107 | ~80 | ~80 | — | — | codecov 70/70 ✅ + MSW reference suite | **yes (reference)** |
| **fc-frontend** | CRA `react-scripts test` (jsdom) | 68 | 71.6 | 70.2 | 59.2 | 63.5 | codecov 70 proj / 80 patch | no |
| **fc-backend** | jest + ts-jest (node) | 55 | 95.5 | 95.4 | 93.7 | 81.7 | codecov 70/70 | no |
| **scraper** | jest + ts-jest (node) | 27 | 83.6 | 82.7 | 82.2 | **64.6** | codecov 70 proj / 80 patch | no |

**Ratchet implications (where a naive flat-70 Jest `coverageThreshold` would FAIL today):**
- **fc-frontend** — functions 59.2 and branches 63.5 are below 70. A Jest gate must start at the
  *measured* floor (≈ lines 70 / stmts 70 / funcs 58 / branches 62) and climb, per §5's intermediate
  steps — never a flat 70 dropped on top.
- **scraper** — branches 64.6 is below 70. Same: gate the measured floor first, raise branches via
  real tests, then lift the threshold.
- **fc-backend** — already clears 70 on every metric (branches 81.7 the lowest); a 70 Jest gate is
  safe to add immediately, and an 80-branch gate is within reach.

---

## Per-repo checklists

Ordering within each repo follows §9: **Phase 1 (adopt positive controls)** before
**Phase 2 (the hard grep ban)**. Each repo's grep guard goes live only after that repo's
connection-faking tool is adopted.

### fc-shared — ✅ DONE (the reference implementation)

MSW v2 boundary suite (`client`/`figures`/`scraper`), `installMswServer()` helper with
`onUnhandledRequest: 'error'`, the `test-hygiene` grep job already in `build.yml`, codecov 70/70.
This is what every other repo copies. No further action; keep it green.

### fc-frontend — the hardest; one keystone blocker

**PREREQ (do first, breaks nothing): the live Jest config is NOT `jest.config.js`.** Under CRA
`react-scripts test`, config is read from the `package.json` `jest` key + `src/setupTests.ts`;
`jest.config.js` (where the `coverageThreshold` and `^axios$` mapping live) is **dead config**. So:
- [ ] Decide config home: migrate the intended knobs into `package.json`'s `jest` block, **or**
  move off `react-scripts test` to a standalone Jest 29/30 config (devDeps already partially present).
  Until this is resolved, *any coverage gate or moduleNameMapper added to `jest.config.js` silently
  does nothing.* This is the prerequisite for every later step.

**Phase 1 — adopt:**
- [ ] Add `msw` devDep + stand up `src/test-utils/server.ts` (`setupServer` + `onUnhandledRequest:
  'error'`) as an **opt-in alongside** the existing axios mock — do not delete the global mock yet.
- [ ] **Keystone removal:** the global `jest.mock('axios')` in `src/setupTests.ts` is what makes MSW
  impossible suite-wide (MSW needs the real axios to issue an interceptable request). Remove it only
  *after* the api tests below are converted, or the suite breaks.
- [ ] Pilot MSW on the 3 HTTP-boundary tests — `src/api/__tests__/index.test.ts`,
  `index.enhanced.test.ts`, `scraper.test.ts` — convert to real-axios + MSW handlers, drop their
  per-file `jest.mock('axios')`. These are the only tests that actually exercise the HTTP client;
  the other ~65 mock at the React/store/hook level and are mostly unaffected.
- [ ] jsdom + MSW caveat: use `jest-fixed-jsdom` (or `testEnvironment: 'node'` for pure `api/*`
  tests) + remove the `global.fetch = jest.fn()` stub in `setupTests.ts` (it shadows MSW).
- [ ] Reachability: write `renderAuthenticated()` (Appendix B Pattern B — seed the real `useAuthStore`),
  replace `jest.mock('../stores/authStore')` usages, **delete** orphaned `src/test-utils/mocks/auth.ts`.
- [ ] Coverage: keep the gate at the **codecov** layer (already 70 proj / 80 patch, met on lines).
  Do **not** add a flat-70 Jest `coverageThreshold` — funcs 59 / branches 63 would fail. If gating in
  Jest, set the measured floor and ratchet (§5 intermediate step ~80, branches ≥75 for headroom).

**Phase 2 — ban (only after the above):**
- [ ] Add the `test-hygiene` grep to `build.yml`. Today it would red-wall: `jest.mock('axios')` in
  4 files (incl. `setupTests.ts`) + real-`setTimeout` delay hacks in ~5 files. Land last, after the
  keystone removal; annotate any legitimate residue with `// test-doctrine-allow:`.

### fc-backend — most mature; unify three mock styles

**Phase 1 — adopt:**
- [ ] Coverage gate: add a Jest `coverageThreshold` at the measured floor (safe — 70 on every metric
  already; set branches 80 since it's at 81.7). codecov already 70/70.
- [ ] Add `msw` devDep + a shared scraper-handler module. The backend calls the scraper three
  inconsistent ways today — `jest.mock('axios')` (3 files: `figureController.test.ts`,
  `figureRoutes.test.ts`, `interServiceCommunication.test.ts`), `global.fetch = jest.fn()` (4 files:
  `syncRoutes.{proxy,activeJob,cancel,jobCrud}.test.ts`), and `jest.mock('node-fetch')` (1 file).
  MSW intercepts axios *and* fetch at the network layer, unifying all three. This is the
  highest-leverage step.
- [ ] Migrate the 7 controller tests (`tests/controllers/*`) off mongoose-model mocks onto the
  existing `tests/testSetup.ts` in-memory engine (mongodb-memory-server already wired) → full Rule 6
  compliance. The model/integration suites already use the real engine.
- [ ] Consolidate the two confusable setup files: `tests/testSetup.ts` (global, memory-server) vs
  `tests/setup.ts` (helper that silently falls back to mocks against a non-existent
  `localhost:27017`). Standardize on the memory-server path.

**Phase 2 — ban:**
- [ ] Add the grep guard. ~14 files trip it today (the axios/fetch/node-fetch mocks + mongoose
  mocks); add after the MSW + controller migrations so it goes green. The `cross-service/` live-axios
  E2E setup (excluded from PRs) is a legitimate exception → `// test-doctrine-allow:`.

### scraper — smallest surface; one coverage gap

**Phase 1 — adopt:**
- [ ] Add `msw` devDep + convert `src/__tests__/unit/webhookClient.test.ts` from
  `(global as any).fetch = jest.fn()` to `setupServer` + `http.post` handlers — assert the real URL,
  `X-Webhook-Signature` HMAC header, and body (`onUnhandledRequest: 'error'`,
  `server.resetHandlers()` in `afterEach`). This is the single highest-value change and the
  reference for fetch-based services. **Leave the 3 `jest.mock('../../services/webhookClient')`
  consumer tests alone** — that's the §4 typed-in-repo-client exception, not a violation.
- [ ] Replace the 3 real-`setTimeout` delays (`browserPool.test.ts:273`, `scrapeQueue.test.ts:548,567`)
  with fake timers; refactor `webhookClient` retry tests off the `baseDelayMs = 1` mutation onto
  `advanceTimersByTimeAsync` (`scrapeQueueProcessing.test.ts` already shows the pattern).
- [ ] Raise branch coverage above 70 (currently **64.6**) with real tests, then add a Jest
  `coverageThreshold` (measured floor first). Statements/functions/lines (82–84) already clear 70.

**Phase 2 — ban:**
- [ ] Add the grep guard scoped to `src/__tests__/**/*.test.ts`, **excluding** `setup.ts` and
  `__mocks__/`. Critically, the stock token list is wrong for this repo: it has no axios, and the
  real antipattern is `global.fetch =` (see the proposed doctrine amendment below). Add only after
  steps above so it goes green on the first run.

---

## Cross-cutting

- **Grep guard is per-repo, not global.** Each repo's `build.yml` gets its own `test-hygiene` job
  with stack-appropriate tokens, turned on only after that repo's Phase 1 lands.
- **No fork/upstream CI conditioning exists.** None of the workflows use `if: github.repository ==`;
  the image name is just `${{ github.repository }}`, so the fork pushes to its own GHCR namespace
  implicitly. New hygiene jobs can be added unconditionally. (This is also the relevant fact for
  Phase 1 of the *k3s* track — feature-branch image builds — which is a separate effort.)
- **Adopt-before-ban is non-negotiable** (§9): banning client-mocks before MSW exists deletes tests
  without replacing them and *reduces* safety.

---

## Proposed doctrine amendments (flagged for sign-off)

The survey found one genuine bug and one precision gap in the signed doctrine:

1. **§8.1 grep token list — APPLIED in this PR, needs sign-off.** The TS ban listed
   `jest.mock('axios')` / `axios.create` / `setTimeout` but **not** `global.fetch =` /
   `globalThis.fetch =`. The scraper uses no axios at all; its real antipattern is the
   `global.fetch` stub in `webhookClient.test.ts`, and the backend stubs `global.fetch` in 4 files.
   As written, the guard would miss the actual violation while false-positiving on benign
   `jest.setTimeout()`. The amendment adds the `global.fetch`/`globalThis.fetch` tokens and the
   scoping caveat (test files only; exclude `setup.ts`/`__mocks__/`). **If you disagree, revert that
   one-line edit in `TESTING.md` §8.1.**

2. **§5 / §9 baselines — captured here, not edited into TESTING.md.** The doctrine cites *configured*
   thresholds (fc-frontend 40/50/60); the *measured* numbers above are the real ratchet floors. Left
   in this tracker rather than amending the doctrine, since they change every release.

---

## How to use this file

When you complete a checklist item: tick it, and if it changed a coverage number, update the
baseline table. When a new repo is surveyed, add its row + checklist. The doctrine (`TESTING.md`) is
the *law*; this tracker is the *docket*.
