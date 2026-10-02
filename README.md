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
| `OTEL_PROPAGATION_ALLOWLIST` | hosts (exact or `*.suffix`, comma-separated; an entry written with a scheme or port counts as its host) that get `traceparent` and auto spans; replaces the default `*.svc.cluster.local,*.svc,localhost` |

**Propagation allowlist.** `traceparent` and `baggage` go only to the hosts
in `OTEL_PROPAGATION_ALLOWLIST` (default `*.svc.cluster.local`, `*.svc` and
`localhost`), never to store CDNs or other third parties, for every
instrumented `http` and `fetch` call as well as the Connect client. The `http`
and `undici` instrumentations skip any other host entirely: no header and no
auto span (a service that wants a span for a store fetch opens its own); this
holds whether `instrumentations` is flat or nested one level, as in
`[getNodeAutoInstrumentations()]`. A short Service name such as
`ingest-server` is not on the default list; use the `.svc` name or list it.

**Span redaction.** Before export, `url.full`, `url.original`, `http.url`,
`http.target` and `db.connection_string` lose their query, fragment and
userinfo; `url.query` and every `http.request.header.*` and
`http.response.header.*` attribute are dropped; then the shared key and
secret-shape policy runs.

**One tracing setup per process.** `startTracing` throws if another
OpenTelemetry setup (e.g. NodeSDK) already registered the context manager,
propagator or tracer provider; the allowlist and span redaction would
otherwise silently not apply. Remove the other setup.

**A dead collector** never throws into the app, and ending a span never
blocks: the queue drops past `maxQueueSize` (2048). `forceFlush`, `shutdown`
and `runJob`'s final flush do wait, at most `exportTimeoutMillis` (default
10 s) when the collector accepts connections and never answers.

**Log redaction.** Every value the logger prints (`msg` and its parts,
`err.type` and `err.message`, each extra field and object key, the reserved
`call`, `code`, `peer`, `job` and `event`, and every bridged or printf console
argument) goes through one policy, with the logger's own options. An Error's
message is printed by it wherever it appears: as `err.message`, in `msg`
(`console.error(err)`, `log.info('failed', err)`) and in its stack. A key that
names a secret (`password`, `token`, `cookie` ...) has its value masked, also
when printing changes the key (`/login?token` prints as `/login`). `call` is
also cut at its first `?` or `#`.

- a `scheme://` or `//` URL anywhere in the text loses its userinfo, and its
  query and fragment up to the next whitespace (a quote does not end it; a
  closing quote, bracket or punctuation after the query is kept); a request
  target after an HTTP method (`GET /items?sig=...`, Fastify's
  `GET:/items?sig=...`) loses its query the same way;
- a value whose first token reads as a URL or path, with or without a scheme
  (`/login?token=...`, `api/v1/items?sig=...`, `cdn.example?sig=...`,
  `localhost:3000/a?sig=...`, `mailto:a@b?subject=...`), or is followed by a
  query of `key=value` pairs (`scraper?token=...`, `[::1]:8080?sig=...`), is
  cut at its first `?` or `#`, whatever follows; so a bare query of
  `key=value` pairs prints empty;
- a value under a URL-named key (`url`, `uri`, `href`, `link`, `path`,
  `target`, `endpoint`, `location`, `referer`, `redirect`, their plurals, and
  keys made of them such as `imageUrl` or `redirect_uri`), at any depth and
  through arrays and objects under it, is cut at its first `?` or `#` before
  any other rule reads it;
- a header line (`Cookie: ...` at the start of a line) and a raw header list
  (`rawHeaders`: name, value, ...) have each sensitive header's value masked;
- a value that is wholly a form-encoded list (`key=value&key=value`, no
  whitespace, as axios sends a `URLSearchParams` body) has the value of each
  sensitive key masked, the key read as a server reads it (`api%5Fkey` is
  `api_key`; an escape that is not UTF-8 is read as U+FFFD, never an error);
- a string that is, as a whole, a JSON object or array is key-redacted and
  made compact (JSON inside such a string too, up to four levels);
- an object is key-redacted in its JSON form (`toJSON` honoured): an Error
  prints as `{name, message, stack}` whatever its `toJSON`, never its own
  properties. Its stack's header is written again from the name and the
  printed message (`name: message`, or node's `name [CODE]: message` when the
  stack starts with it). When the stack starts with the header V8 or node
  wrote for this name and message and only frames follow, those frames are
  kept; otherwise only the frame lines that end the stack are, so a
  frame-shaped line (`    at ...`) left from an earlier message can remain.
  Under a URL-named key, at any depth, its message and stack are URL values;
  binary data as
  `[binary]`; a node HTTP message, or a wrapper holding one in `raw`
  (Fastify's Request and Reply), as a summary (an incoming request `{method,
  url}`, an outgoing request `{method, host, path}`, a response
  `{statusCode}`) and any other stream (a socket) as `[ClassName]`, never its
  raw headers or parsed query; an object that hides itself from
  `util.inspect` (fetch `Headers`, a class with `util.inspect.custom` and no
  `toJSON`) as `[ClassName]`; four levels, 100 entries per array or object and
  1000 entries in all at most, JSON strings inside the value counted in the
  same 1000 (a string the value holds many times is read once);
- a value that cannot be read (a throwing getter, a revoked Proxy) prints as
  `[unserializable]`; a log call never throws for what it was given.

Other free text is masked only by the secret-shape patterns (Bearer, JWT,
...): a secret in prose, JSON or a form embedded in a longer sentence, a path
in the middle of a sentence (`see /docs?page=2`), or query parameters held
without a `?` (`{ query: 'sig=...' }`, axios `config.params`) whose names are
not sensitive (`sig`), are left as written.

A child logger given an empty or unknown level, or one that is not a string,
keeps its parent's level, as pino's does for the first two: Fastify 5 passes
`{ level: '' }` for every request.

**Console bridge.** `installConsoleBridge(logger)` turns `console.*` into
`app.console` lines, redacted as above: a leading `[TAG]` (e.g.
`[BROWSER POOL]`) that the first argument, a string, starts with becomes
`tag`, and an Error argument becomes `err`.

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
