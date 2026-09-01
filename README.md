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

All exports are re-exported from the package root:

```ts
import { /* types, client, stores, ... */ } from '@figurecollecting/fc-shared';
```

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

Only `dist/` is published (see `files` in `package.json`); `prepublishOnly`
rebuilds it automatically before every publish.

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
