# Deploy and Install Skeleton (F-03) — Implementation Plan

## Overview

Make every merge to `main` deploy the Worker to production once CI and smoke are green, guarded by a
check that the hosted Supabase schema already carries every migration in the repo; and make the app
installable to the home screen on desktop, Android and iOS through a web app manifest, icons and the
iOS meta tags. No service worker and no offline support.

## Current State Analysis

See `research.md`. In short: deploy is a manual `npx wrangler deploy`; CI has `ci` and `smoke` jobs
but no deploy job; the hosted Supabase project is the only database and its migrations are pushed by
hand; `Layout.astro` links only a 32×32 starter favicon and no manifest.

## Desired End State

- A push to `main` runs `ci` and `smoke`; when both pass, a `deploy` job checks that every
  `supabase/migrations/*.sql` version is recorded on the hosted project, deploys with
  `npx wrangler deploy`, and probes the production URL for the home page and the manifest.
  PRs never deploy.
- `https://duo-kitchen.mediewilnp.workers.dev/manifest.webmanifest` serves a valid manifest;
  Chrome on desktop and Android offers "Install"; iOS Safari's "Add to Home Screen" uses the Duo
  Kitchen icon and title and opens standalone.
- Smoke asserts the manifest, its icons and the `<head>` links on every CI run.

### Key Discoveries

- `wrangler` is already a devDependency; no third-party action is needed.
- CI has no DB password, so it cannot `db push`, but `supabase db query --linked` (Management API)
  can read `supabase_migrations.schema_migrations` — enough for a read-only gate.
- Static files in `public/` are served by the Cloudflare asset layer before the middleware.

## What We're NOT Doing

- No service worker, offline caching or custom install prompt.
- No automatic `supabase db push` from CI (no DB password; schema changes stay a reviewed manual step).
- No staging environment or second Supabase project.
- No rebrand of the starter's landing page beyond the `<title>` default.

## Implementation Approach

Two phases: installability first (testable locally against `npm run preview`), then the deploy
pipeline (testable only on `main`, so its pieces are verified locally where possible).

## Critical Implementation Details

- The maskable icon keeps its glyph inside the central 80 % safe zone on a full-bleed background;
  the `apple-touch-icon` is opaque (iOS paints transparency black).
- The deploy job must `needs: [ci, smoke]` and be gated with
  `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, with a non-cancelling
  `concurrency` group so two quick merges deploy in order and neither is aborted mid-upload.
- The migration gate derives versions from file names (`YYYYMMDDHHmmss_…sql` → leading 14 digits) and
  raises with the list of missing versions, so the failure message names the fix (`npx supabase db push`).
- Do not pass Supabase secrets to `wrangler deploy`; the Worker's runtime secrets persist across deploys.

## Phase 1: Installability

### Overview

Icons, manifest, `<head>` tags, and smoke coverage.

### Changes Required:

#### 1. Icons — `public/icons/`

Generate and commit: `icon-192.png`, `icon-512.png` (purpose any), `icon-maskable-512.png`
(purpose maskable, glyph in the 80 % safe zone), `apple-touch-icon.png` (180×180, opaque), and
replace `public/favicon.png` (32×32) with the same mark. Keep the generator out of the build: a
one-off script in the change's scratch or a documented ImageMagick command; commit only the PNGs.

#### 2. Manifest — `public/manifest.webmanifest`

```json
{
  "name": "Duo Kitchen",
  "short_name": "Duo Kitchen",
  "description": "Plan, solve and cook three days of meals for two.",
  "id": "/",
  "start_url": "/dashboard",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "icons": [192 any, 512 any, 512 maskable]
}
```

#### 3. Layout head — `src/layouts/Layout.astro`

- Default title `"Duo Kitchen"`.
- `viewport` → `width=device-width, initial-scale=1`.
- `<link rel="manifest" href="/manifest.webmanifest">`, `<meta name="theme-color" content="#0f172a">`,
  `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`,
  `<meta name="apple-mobile-web-app-title" content="Duo Kitchen">`,
  `<meta name="apple-mobile-web-app-status-bar-style" content="black">` (opaque, so standalone pages start below the status bar; no page pads for safe-area insets),
  `<meta name="mobile-web-app-capable" content="yes">`.

#### 4. Smoke — `scripts/smoke.mjs`

Anonymous steps near the top (no Supabase needed):

- `home links the manifest and touch icon`: `/` body matches `rel="manifest" href="/manifest.webmanifest"`
  and `rel="apple-touch-icon"`.
- `manifest is installable`: `/manifest.webmanifest` is 200, parses as JSON, has `name`, `start_url`,
  `display: "standalone"`, a 192 and a 512 `any` icon and a `maskable` icon.
- `manifest icons are served`: each icon `src` plus the touch icon return 200 with an `image/png`
  content type.

The step runner only compares `status` / `location` / `body`; add a small `check` hook (a function
returning an error string or null) so JSON and header assertions do not need a new runner. The
`request()` helper exposes the `content-type` header.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build succeeds: `npm run build`
- The manifest and icon smoke steps pass against `npm run preview` (the anonymous steps run without
  Supabase; later steps need the hosted project and run in CI)

#### Manual Verification:

- Chrome desktop on the production URL shows the install icon in the omnibox and installs a
  standalone window titled Duo Kitchen.
- Android Chrome offers "Install app"; the home-screen icon is the maskable icon, not a white square.
- iOS Safari → Share → Add to Home Screen shows the Duo Kitchen icon and title and opens standalone.

## Phase 2: Auto-deploy from main

### Overview

Migration gate script, deploy job, post-deploy probe, documentation.

### Changes Required:

#### 1. Migration gate — `scripts/check-migrations.mjs` and `npm run check:migrations`

Dependency-free Node: read `supabase/migrations/*.sql`, take each file's leading 14-digit version,
build one `do $$ … $$` block that compares them with
`supabase_migrations.schema_migrations.version` and `raise exception` listing every missing version
plus the hint `run npx supabase db push`, and run it with
`npx supabase db query --linked "<sql>"` via `child_process.execFileSync` (inherit stdio, exit with
its status). Only version strings matching `^\d{14}$` are interpolated.

#### 2. Deploy job — `.github/workflows/ci.yml`

```yaml
  deploy:
    needs: [ci, smoke]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    concurrency: { group: deploy-production, cancel-in-progress: false }
    environment: { name: production, url: https://duo-kitchen.mediewilnp.workers.dev }
    steps:
      - preflight: fail with ::error:: naming each missing secret if CLOUDFLARE_API_TOKEN or
        CLOUDFLARE_ACCOUNT_ID is empty (main stays honestly red until the owner sets them up)
      - checkout, setup-node 22 (npm cache), npm ci
      - link Supabase (SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF)
      - npm run check:migrations
      - npm run build (SUPABASE_URL / SUPABASE_KEY env, as in ci)
      - npx wrangler deploy (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
      - probe: curl -fsS the production / and /manifest.webmanifest, with retries
```

The probe is a **liveness** check only: after the first deploy the previous version answers it too.
The authority for "this commit is live" is `wrangler deploy`'s exit status, which fails on any upload
or activation error. No version marker is added.

#### 3. Documentation

- `README.md` §Deployment: auto-deploy from `main`, the two Cloudflare secrets and how to create the
  token, the migration gate, manual `wrangler deploy` as the fallback; §CI: the third job; §Auth
  routes untouched; a short "Install on your phone" section (desktop / Android / iOS steps).
- `CLAUDE.md` §CI: the `deploy` job and its secrets; §Commands: `npm run check:migrations`.
- `context/foundation/roadmap.md`: F-03 status → done (on archive).

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Workflow YAML parses and the `deploy` job has `needs: [ci, smoke]`, the `main`-push `if` and a non-cancelling `concurrency` group: `python3 -c "import yaml; j=yaml.safe_load(open('.github/workflows/ci.yml'))['jobs']['deploy']; print(j['needs'], j['if'], j['concurrency'])"`
- `node scripts/check-migrations.mjs` builds the expected SQL (dry-run flag prints the SQL without
  running it) and every migration file yields a 14-digit version

#### Manual Verification:

- Owner adds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
- `npm run check:migrations` passes against the hosted project (needs `SUPABASE_ACCESS_TOKEN`).
- First merge to `main` after this change: the `deploy` job is green and the production URL serves
  the manifest.

## Testing Strategy

- HTTP: smoke steps for manifest, icons and head links (CI, production preview).
- Pipeline: the migration gate's dry-run locally; the deploy job itself is only exercisable on `main`.

## Performance Considerations

Manifest and icons are static assets served by Cloudflare's asset layer; no Worker invocation.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Installability

#### Automated

- [ ] 1.1 Lint passes: `npm run lint`
- [ ] 1.2 Type check passes: `npx astro check`
- [ ] 1.3 Build succeeds: `npm run build`
- [ ] 1.4 Manifest and icon smoke steps pass against `npm run preview`

#### Manual

- [ ] 1.5 Chrome desktop installs a standalone Duo Kitchen window
- [ ] 1.6 Android Chrome installs with the maskable icon
- [ ] 1.7 iOS Safari Add to Home Screen shows icon and title and opens standalone

### Phase 2: Auto-deploy from main

#### Automated

- [ ] 2.1 Lint passes: `npm run lint`
- [ ] 2.2 Workflow YAML parses and the deploy job is gated
- [ ] 2.3 Migration gate dry-run prints a version for every migration file

#### Manual

- [ ] 2.4 Owner adds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets
- [ ] 2.5 `npm run check:migrations` passes against the hosted project
- [ ] 2.6 First merge to `main`: deploy job green, production serves the manifest
