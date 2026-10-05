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
when printing changes the key (`/login?token` prints as `/login`). The query
and form keys `code`, `code_verifier`, `sig` and `signature` are sensitive:
their values are masked as `token`'s and `password`'s are, whatever key
pattern a service gives, within these bounds. `code_verifier`, `sig` and
`signature`, as a word of the key (`X-Amz-Signature`, `urlSig`,
`codeVerifier`), mask their value as an object key at any depth, a form key
and the name of a header line. `code` (an OAuth code) masks its value as a
form key, as a word of the key (`device_code`). As an object key at any depth
(a parsed query `{ q: req.query }`, axios `config.params`, a JSON body) the
OAuth and one-time code keys `code`, `auth_code`, `authorization_code`,
`device_code`, `user_code`, `oauth_code`, `verification_code`, `reset_code`,
`mfa_code` and `confirmation_code` (`authCode` and `Code` too, and with an
index: `code[0]`), also as a top-level key that prints as one
(`authCode?x=1`), mask a string (a `String` object too) or an array,
whatever it reads as: a reset code `493817` cannot be told from an error code
`ENOENT`, so an error code under `code` in a plain object is masked too (an
Error prints as `{name, message, stack}`, never through its `code` key). A
number, a boolean, null and any other object under them print, and so does
any other key with the word `code` (`statusCode`, `jan_code`, `error_code`).
The log shape's own `code` field (a top-level `code` or `Code` of the call or
of a child's bindings)
prints a string only when it is a code the library writes: `ok`, `error`, one
of the 16 Connect code names, or a three-digit status from 100 to 599. Any
other string prints as the placeholder, so a query handed to the call as its
fields (`log.info(req.query)`, `log.info({ ...req.query })`) does not print
its OAuth code. A number prints as a string. `call` is also cut at its first
`?` or `#`.

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
  any other rule reads it (a value that is a whole JSON document is parsed
  first, and each string in it is cut);
- a header line (`Cookie: ...` at the start of a line) and a raw header list
  (`rawHeaders`: name, value, ...) have each sensitive header's value masked;
- a value that is wholly a form-encoded list (`key=value&key=value`, no
  whitespace, as axios sends a `URLSearchParams` body) has the value of each
  sensitive key masked, the key read as a server reads it (`+` is a space,
  `api%5Fkey` is `api_key`; an escape that is not UTF-8 is read as U+FFFD,
  never an error);
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
...): a secret in prose, JSON or a form embedded in a longer sentence, and a
path in the middle of a sentence with its query (`see /docs?page=2`,
`fetch /x?sig=... failed`), are left as written. Free text is never searched
for a form: text that holds `key=value` pairs is read as one only when it is a
form as a whole, so form-like text inside a longer sentence, with or without
a `?` before it (`retry with code=...&sig=...`, `callback /cb?code=...&state=x`),
prints as written; a query is cut only where the rules above cut it (a
value that starts with a URL or path, a `scheme://` URL, a request target
after an HTTP method).

A child logger given an empty or unknown level, or one that is not a string,
keeps its parent's level and never throws (Fastify 5 passes `{ level: '' }`
for every request); pino's keeps it for an empty level and throws for an
unknown one.

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
