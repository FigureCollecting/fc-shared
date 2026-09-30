# @figurecollecting/fc-shared

Shared TypeScript types, API client, and state stores for the
[Figure Collector Services](https://github.com/FigureCollecting) frontends.

Published to GitHub Packages as `@figurecollecting/fc-shared`.

## What it provides

| Module | Exports |
| --- | --- |
| `types` | Shared domain types (figures, users, scraper payloads) |
| `api/client` | Configured axios client + request helpers |
| `api/figures` · `api/scraper` | Endpoint wrappers |
| `api/transforms` | Request/response transforms |
| `stores/auth` · `stores/sync` | Zustand stores for auth + sync state |
| `utils/logger` | Shared logger |
| `utils/trace` | OpenTelemetry trace-context helpers |
| `utils/sanitize` | Secret/PII redaction for logs and span attributes |

Everything is re-exported from the package root:

```ts
import { /* types, client, stores, ... */ } from '@figurecollecting/fc-shared';
```

## Subpath exports

The root barrel pulls in axios, zustand and react. A Node service that only
wants the trace tag on its log lines should not inherit a browser HTTP client
and a persisted auth singleton, so four **stateless** modules also resolve on
their own:

```ts
import { getTraceContext } from '@figurecollecting/fc-shared/utils/trace';
import { redactAttributes } from '@figurecollecting/fc-shared/utils/sanitize';
import { configureLogger } from '@figurecollecting/fc-shared/utils/logger';
import type { PaginatedResponse } from '@figurecollecting/fc-shared/types';
```

`@opentelemetry/api` is the only runtime dependency any of them reaches.

`stores/*` and `api/*` deliberately have **no** subpath. They are a persisted
zustand singleton and the axios client for legacy fc-backend; a second
resolution path to a module that holds state is how one half of an app ends up
logged in while the other half is not. `tests/package` enforces both halves of
this: that the four subpaths stay dependency-free, and that the stateful
modules stay barrel-only.

The ESM build emits shared chunks, so the barrel and a subpath resolve to one
instance of a module rather than two copies. Mixing `require` and `import` of
this package in a single process still yields two instances, as it always has.

## Server subpaths (Node only, 1.8.0)

Services share one log shape and one tracing setup through five node-only
subpaths. They are built by a separate esbuild run with `--platform=node`, so
the browser entry points above are byte-identical to 1.7.0, and nothing in the
barrel or the browser-safe subpaths can reach them (`tests/package` checks both).

| Subpath | Exports |
| --- | --- |
| `server/log` | `createLogger` (pino-compatible), `installConsoleBridge`, `resolveServiceIdentity` |
| `server/tracing` | `startTracing`, `RedactingSpanExporter`, `AllowlistPropagator`, `ESM_LOADER_HOOK`, `esmLoaderHookPath` |
| `server/connect` | `rpcServerInterceptor`, `rpcClientInterceptor` (rpc.in / rpc.out) |
| `server/express` | `httpLogMiddleware` (http.in, route template as `call`) |
| `server/job` | `runJob`, `itemContext`, `currentTraceparent`, `withTraceparent` |
| `server/log-shape.schema.json` | the log-line contract (JSON Schema 2020-12) for consumers' tests |

Every line is one JSON object on stdout: `time level service version event msg`,
then `call code duration_ms peer trace_id span_id job err queue_ms` when they
apply, then the event's own snake_case fields. `trace_id`/`span_id` are present
only under an active span, never zeroed.

The OpenTelemetry SDK and Connect are **optional peer dependencies**; a service
that uses `server/tracing` or `server/connect` installs them:

```bash
npm install @opentelemetry/sdk-trace @opentelemetry/core @opentelemetry/resources \
  @opentelemetry/context-async-hooks @opentelemetry/exporter-trace-otlp-grpc \
  @opentelemetry/instrumentation @connectrpc/connect
```

| Env | Effect |
| --- | --- |
| `OTEL_SERVICE_NAME`, `SERVICE_VERSION` | `service` and `version` on lines and on the trace resource |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP **gRPC** export; unset = no-op export (ids still in logs, nothing leaves the pod) |
| `LOG_LEVEL` | minimum level (default `info`) |
| `FC_LOG_FORMAT=text` | escape hatch: the same fields as one human-readable line |
| `JOB_NAME` | the Kubernetes Job name (downward API), stamped as `job` |
| `FC_TRACE_PROPAGATE_HOSTS` | extra hosts (exact or `*.suffix`) allowed to receive `traceparent` |

**Propagation allowlist.** `traceparent` and `baggage` go only to
`*.svc.cluster.local`, `*.svc` and `localhost`, never to store CDNs or other
third parties, for every instrumented `http` and `fetch` call as well as the
Connect client. A short Service name such as `ingest-server` is not on the
list; use the `.svc` name or add it through `FC_TRACE_PROPAGATE_HOSTS`.

**One tracing setup per process.** `startTracing` throws if another
OpenTelemetry setup (e.g. NodeSDK) already registered the context manager,
propagator or tracer provider; the allowlist and span redaction would
otherwise silently not apply. Remove the other setup.

**A dead collector** never throws into the app, and ending a span never
blocks: the queue drops past `maxQueueSize` (2048). `forceFlush`, `shutdown`
and `runJob`'s final flush do wait, at most `exportTimeoutMillis` (default
10 s) when the collector accepts connections and never answers.

**Console bridge.** `installConsoleBridge(logger)` turns `console.*` into
`app.console` lines: a leading `[TAG]` (e.g. `[BROWSER POOL]`) becomes `tag`,
and objects, printf arguments and JSON strings are key-redacted with the
logger's own options, as logger fields are.

**ESM services** (`"type": "module"`) must preload the OpenTelemetry loader hook,
or instrumentations (pg, for one) never see modules loaded through `import`:

```bash
node --experimental-loader=@opentelemetry/instrumentation/hook.mjs \
     --import ./dist/tracing.js dist/server.js
```

## Toolchain baseline

fc-shared is the estate's BOM anchor, and ships the compiler settings that go
with it. Consuming repos inherit target, module resolution and strictness
rather than restating them:

```jsonc
// tsconfig.json
{ "extends": "@figurecollecting/fc-shared/tsconfig.base.json" }
```

This repo's own `tsconfig.json` extends the same file, so the baseline cannot
drift from what consumers get.

## Installation

GitHub Packages requires the `@figurecollecting` scope to point at its registry.
Add to the consuming project's `.npmrc`:

```
@figurecollecting:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Then:

```bash
npm install @figurecollecting/fc-shared
```

The token needs `read:packages`. Keep it out of version control (use an env var,
as above).

## Development

```bash
npm install        # install deps
npm run build      # tsc -> dist/
npm run lint       # tsc --noEmit type check
```

Only `dist/`, `schema/` and `tsconfig.base.json` are published (see `files` in
`package.json`); `prepublishOnly` rebuilds `dist/` automatically before every
publish.

## CI on forks (shift-left)

Development happens on personal forks; pull requests go to `FigureCollecting/*`.
CI on a fork follows one rule. The push gate (its four cases are documented in
a comment block) sits at the top of `build.yml`; `publish.yml` and `release.yml`
carry an org-only gate.

- **Feature branches on your fork run the core CI on every push**: test-hygiene
  check, typecheck, build and tests, so problems surface before the PR is opened.
- **No `NODE_AUTH_TOKEN` is needed here** (this package has no private
  dependencies); the service repos that consume it use a fork secret
  `NODE_AUTH_TOKEN` = classic PAT with **only** `read:packages`.
- **`develop` and `main` on your fork are mirrors of upstream: pushes to them
  run no jobs.** The workflows still trigger, so each sync leaves grey
  `skipped` runs in the Actions tab; that is the gate working, not a failure.
  This repo's only manual trigger (`publish.yml`) is org-only, so nothing at all
  runs on a fork's `develop`/`main`.
  The gate compares branch names case-insensitively, so do not name a feature
  branch `Develop` or `MAIN`.
- **Publishing (the npm package, GitHub releases) and Codecov uploads happen
  only from the org**; those jobs and steps are skipped on forks.

## License

[MIT](./LICENSE) © FigureCollecting
