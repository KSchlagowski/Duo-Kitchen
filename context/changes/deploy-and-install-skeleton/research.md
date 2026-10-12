---
date: 2026-10-11T12:00:00+02:00
researcher: Claude (Opus 5.5) for KSchlagowski
git_commit: 6fae48d601e06183fbdfe5d5eddbfbd420246812
branch: feat/deploy-and-install-skeleton
repository: KSchlagowski/Duo-Kitchen
topic: "F-03 deploy-and-install-skeleton: auto-deploy from main and make the app installable"
tags: [research, codebase, ci, cloudflare-workers, wrangler, pwa, manifest, astro-layout]
status: complete
last_updated: 2026-10-11
last_updated_by: Claude (Opus 5.5)
---

# Research: F-03 deploy-and-install-skeleton

**Date**: 2026-10-11 (Europe/Warsaw, +02:00)
**Researcher**: Claude (Opus 5.5) for KSchlagowski
**Git Commit**: 6fae48d601e06183fbdfe5d5eddbfbd420246812
**Branch**: feat/deploy-and-install-skeleton
**Repository**: KSchlagowski/Duo-Kitchen

## Research Question

F-03 from `context/foundation/roadmap.md:103-114`: _"merging to `main` deploys the app to production with a production Supabase project, and the app installs to the home screen on desktop, Android and iOS."_ The roadmap scopes it as "adding auto-deploy from `main` and installability (PWA manifest)", with offline support parked. `change.md` adds no further constraints beyond the roadmap reference.

This was a non-interactive session, so I asked the user nothing. Assumptions are marked **Assumption** below.

## Summary

- **Production exists, but nothing deploys to it automatically, and it is several slices behind `main`.** The worker `duo-kitchen` is live at `https://duo-kitchen.mediewilnp.workers.dev`. A probe on 2026-10-11 showed `/join` 200 and `/targets` 302 to sign-in, so S-01 and S-02 are deployed. `/plan` and `/recipes` return **404**, so S-03, S-04 and S-05 were never deployed. The page title is still `10x Astro Starter`. No deploy command exists anywhere in the repo, so the earlier deploys were run by hand with `npx wrangler deploy` (README "Deployment" section).
- **CI already triggers on `main`** (`.github/workflows/ci.yml:3-7`) and runs two jobs: `ci` (lint, unit tests, astro check, build) and `smoke` (RLS and seed tests against hosted Supabase, then the smoke test against a local production preview). F-03 needs one new `deploy` job: `needs: [ci, smoke]`, only on `push` to `main`, running `npm run build` and then `wrangler deploy`. It needs two new repository secrets, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- **There is no separate production Supabase project, and CLAUDE.md effectively forbids one.** The "Supabase is cloud-only" hard rule pins one hosted project (`tvmfkhnxxsnmvogplknz`) for dev, CI and the app. **Assumption:** that single project _is_ the production project, and F-03 creates no second one. The live worker already runs against it. Its `SUPABASE_URL` / `SUPABASE_KEY` are Cloudflare worker secrets, set once by hand, which is why the deployed app works. See Open Questions for the trade-off: smoke runs leave `smoke-*` accounts in production.
- **Installability is completely absent.** There is no manifest, no app icons apart from a 733-byte `favicon.png`, and no `theme-color`, `apple-touch-icon` or iOS meta tags. The viewport meta is the bare `width=device-width`. Every page renders through the single `src/layouts/Layout.astro`, so all head tags go in one place. Static files in `public/` are served by the Workers assets binding before the worker runs, so the manifest and icons never hit `src/middleware.ts`'s auth redirect.
- **Schema/code ordering is already handled by convention.** Migrations are pushed by hand (`npx supabase db push`) **before** merge (CLAUDE.md hard rule; repeated in every archived plan). An automatic deploy after merge therefore always ships code against a schema that is already current. F-03 should **not** add `db push` to CI.

## Detailed Findings

### 1. CI workflow today

`.github/workflows/ci.yml`:

- Triggers: `push` and `pull_request` on `main` (`:3-7`). The roadmap baseline's "CI triggers on `master`" is out of date. Commit `f5b5f2d` fixed it.
- Job `ci` (`:10-25`): `npm ci` → `astro sync` → `lint` → `npm test` → `astro check` → `npm run build` with `SUPABASE_URL` / `SUPABASE_KEY` env from secrets. It builds but uploads no artifact.
- Job `smoke` (`:27-60`): links the Supabase CLI with `SUPABASE_PROJECT_REF` / `SUPABASE_ACCESS_TOKEN`. It runs `test:rls` and `test:seed`, writes `.env` and `.dev.vars`, builds, starts `npm run preview` on :4321 and runs `npm run smoke`.
- No `deploy` job. No `concurrency` group. No `environment:`. The two jobs run in parallel and independently of each other.
- Node 22 (`.nvmrc` is `22.14.0`).

Implications for the deploy job:

- It should depend on **both** jobs (`needs: [ci, smoke]`) so a red smoke run blocks production. Both jobs already run on `push` to `main`, so the gate costs nothing extra.
- Guard with `if: github.event_name == 'push' && github.ref == 'refs/heads/main'` so PRs never deploy.
- Add `concurrency: { group: deploy-production, cancel-in-progress: false }` so two quick merges deploy in order instead of racing.
- It must rebuild (or download an artifact), because no job publishes `dist/`. Rebuilding is the simpler option and matches the existing pattern.
- `wrangler` is already a devDependency (`package.json`, installed 4.147.0), so `npx wrangler deploy` works without `cloudflare/wrangler-action`. Either option works. The action's main extra is wrapping secrets upload, which is not needed here (see §3).

### 2. Build and deploy mechanics (Astro + Cloudflare adapter)

- `astro.config.mjs:10-23`: `output: "server"`, `adapter: cloudflare()`, `env.schema` with both Supabase vars as `context: "server", access: "secret", optional: true`.
- `wrangler.jsonc`: `name: "duo-kitchen"`, `main: "@astrojs/cloudflare/entrypoints/server"`, `compatibility_date: "2026-05-08"`, `nodejs_compat`, `assets` (`binding: ASSETS`, `directory: ./dist`, `not_found_handling: "404-page"`), `observability.enabled`. There is no `account_id`, `routes` or custom domain, so it deploys to `*.workers.dev`.
- `astro build` writes `dist/server/wrangler.json` and a redirect file `.wrangler/deploy/config.json` → `../../dist/server/wrangler.json`. So a plain `wrangler deploy` after the build picks up the generated config (`main: entry.mjs`, `assets.directory: ../client`). Verified from the local build output.
- The generated config contains `kv_namespaces: [{ binding: "SESSION" }]` without an id, plus an `images: { binding: "IMAGES" }` binding. The adapter injects these by default: `node_modules/@astrojs/cloudflare/dist/index.js` enables Astro sessions on a KV binding named `SESSION` whenever `config.session` has no driver. The app never uses `Astro.session` (grep found no use). Manual deploys succeeded with this config, which suggests the installed wrangler (4.147) auto-provisions the id-less KV namespace. **Risk for CI:** auto-provisioning needs the API token to have **Workers KV Storage: Edit**, on top of **Workers Scripts: Edit**. The token permissions should cover KV, or the plan could disable the unused session driver so the binding disappears. That second option needs checking against Astro 7's `session` config. The adapter code tests `session === false`, but whether Astro's config schema accepts `false` is unverified.
- `public/.assetsignore` lists `_worker.js` / `_routes.json`, which are Pages-era leftovers and harmless. `dist/client/_headers` sets immutable caching on `/_astro/*` only. A manifest should **not** be cached immutably, because its URL does not change.
- `@astrojs/sitemap` is configured without `site`, so it emits nothing useful. This is out of scope, but if the plan sets `site` for absolute URLs it would also make the sitemap work.

### 3. Runtime secrets and the "production Supabase project"

- `src/lib/config-status.ts` reads `SUPABASE_URL` / `SUPABASE_KEY` from `astro:env/server`. With `access: "secret"` they are **not** inlined at build time. On Cloudflare they are read from the worker's env at runtime. That is why the live worker works: the two values were set as worker secrets by hand (README: "Set `SUPABASE_URL` and `SUPABASE_KEY` as secrets in your Cloudflare dashboard or via `npx wrangler secret put`").
- `wrangler deploy` keeps existing secrets. The deploy job therefore does **not** need to push Supabase secrets on each run. **Assumption:** the plan keeps secret management manual and one-time, and documents it. It will not re-sync secrets from GitHub on every deploy, which would widen the token's blast radius.
- The CI build still needs the vars only so that `astro check` / build type-checks pass, matching the existing `ci` job.
- CLAUDE.md "Supabase is cloud-only" pins project `tvmfkhnxxsnmvogplknz` for everything, CI included. The roadmap wording "with a production Supabase project" therefore resolves to: **the hosted project is production.** No second project, no staging. See Open Question 1.
- Supabase Auth URL config: `supabase/config.toml:154-156` has `site_url = "http://127.0.0.1:3000"`. That file is for the local stack, which the project does not run. The hosted project's Site URL is set in the dashboard. Email confirmation is disabled (README) and no code passes `emailRedirectTo` (grep), so no auth emails link back to the app today. The plan should still note that the dashboard Site URL should be the production URL, for when confirmation is enabled.
- The invite link is built from `Astro.url.origin` (`src/pages/dashboard.astro:82-83`), so it is correct in production without configuration.

### 4. Installability: what each platform needs (and what exists)

The current head is in `src/layouts/Layout.astro:13-20`: charset, `viewport` = `width=device-width`, `<link rel="icon" href="/favicon.png">`, `<title>`. `<html lang="en">`, while the UI is mostly Polish. S-14 owns that. The default title is `"10x Astro Starter"` (`:10`), and that is what shows up as the installed app name on iOS when no `apple-mobile-web-app-title` is set. Every page in `src/pages/**/*.astro` imports `Layout` (grep for pages without it returned none), so one edit covers the app.

Requirements (general platform knowledge; Context7 was not permitted in this session, so these were not re-checked against current docs. The plan should confirm them):

- **Chromium (desktop Chrome/Edge, Android Chrome)**: HTTPS (workers.dev provides it). A linked web app manifest with `name` or `short_name`, `icons` including 192×192 and 512×512 PNG (a `maskable` purpose icon is recommended for Android), `start_url`, and `display` of `standalone` / `fullscreen` / `minimal-ui`. Current Chrome no longer requires a service worker with a fetch handler to offer install. **Assumption:** no service worker in F-03, consistent with "No offline support (parked)". If the plan wants Android's richer install UI or to be safe on older Chromium, a minimal pass-through SW is the fallback. It must not cache authenticated SSR HTML.
- **iOS / iPadOS Safari**: there is no install prompt API. The user installs manually through Share → "Add to Home Screen". It uses `<link rel="apple-touch-icon" href="…180×180.png">`. Without it, iOS shows a screenshot. iOS reads the manifest (`display: standalone`, name) on recent iOS versions. Adding `apple-mobile-web-app-title` and status-bar meta is cheap insurance. In standalone mode on iOS, cookies are isolated from Safari, so the user signs in once more inside the installed app. The cookie-based Supabase session (`src/lib/supabase.ts`) works there unchanged. The plan should mention this in verification notes.
- **Common**: `<meta name="theme-color">`, a viewport with `initial-scale=1` (and possibly `viewport-fit=cover` for the notch). Icons need artwork. None exists beyond `favicon.png`, so the plan needs a decision on producing a simple generated icon set. A dependency-free option is SVG artwork rendered to the required PNG sizes once and committed.
- **`start_url` choice**: `/` is the public starter `Welcome` page (`src/pages/index.astro`). `/dashboard` is protected and redirects to `/auth/signin` when signed out (`src/middleware.ts:3-10,23-27`). **Assumption/recommendation:** `start_url: "/dashboard"` with `scope: "/"`, so an installed app opens on the useful page and the middleware handles the signed-out case.
- **Middleware interaction**: `PROTECTED_ROUTES` matches by `startsWith` on `/dashboard`, `/targets`, `/plan`, `/recipes` (`src/middleware.ts:3-10,23`). A manifest at `/manifest.webmanifest` and icons under `/icons/…` match none of these. Because they live in `public/` they are served straight from the ASSETS binding anyway. The middleware still calls `supabase.auth.getUser()` on every **worker** request. Static assets bypass the worker by default (no `run_worker_first`), so installability adds no auth cost.
- **Serving the manifest**: from `public/`, Workers assets infers the content type from the extension. `.webmanifest` → `application/manifest+json` should be confirmed after deploy with `curl -I`. Today `GET /manifest.webmanifest` on production returns 404.

### 5. Verification surfaces available

- The smoke test (`scripts/smoke.mjs`) runs against `BASE_URL` (default localhost) and sends `Origin: BASE_URL` (`:8-10,45-50`). It can add cheap assertions: `GET /manifest.webmanifest` is 200 with valid JSON and the required fields, the icons it lists are 200, and the layout HTML contains `<link rel="manifest">` and `apple-touch-icon`. These run in the CI preview before deploy.
- A post-deploy check (`curl -sf https://duo-kitchen.mediewilnp.workers.dev/` plus the manifest URL) at the end of the deploy job would confirm the release actually went live. Running the full smoke suite against production would create more `smoke-*` accounts in the production database, so it is **not recommended** as a post-deploy step.
- Real install on Android, iOS and desktop is manual verification only.

### 6. Docs that will need updating (for the plan's docs phase)

- `README.md` "Deployment" (manual `wrangler deploy`) → describe auto-deploy on merge, the two new GitHub secrets, the one-time worker secrets and the token scopes. "CI" section → add the `deploy` job. The title and template image still say "10x Astro Starter".
- `CLAUDE.md` "CI" section → add the `deploy` job and its required secrets.
- `context/foundation/roadmap.md` → F-03 status and the baseline line about `master`/no auto-deploy, when the change is archived.
- `package.json` `name` is still `10x-astro-starter`. It is cosmetic and not tied to the worker name (that comes from `wrangler.jsonc`).

## Code References

- `.github/workflows/ci.yml:3-7` - triggers on push/PR to `main`
- `.github/workflows/ci.yml:10-25` - `ci` job (lint, test, check, build)
- `.github/workflows/ci.yml:27-60` - `smoke` job (RLS, seed, preview + smoke)
- `wrangler.jsonc:1-16` - worker `duo-kitchen`, assets binding, observability
- `astro.config.mjs:10-23` - SSR, Cloudflare adapter, `astro:env` secret schema
- `dist/server/wrangler.json` (generated) - adds id-less `SESSION` KV and `IMAGES` bindings
- `.wrangler/deploy/config.json` (generated) - redirects `wrangler deploy` to the generated config
- `node_modules/@astrojs/cloudflare/dist/index.js` (adapter ~`:63-130`) - default session-on-KV injection
- `src/layouts/Layout.astro:10-20` - the single `<head>`; default title, viewport, favicon
- `src/middleware.ts:3-27` - `PROTECTED_ROUTES` and the per-request `getUser()`
- `src/pages/index.astro:1-8` - public starter welcome page (poor `start_url`)
- `src/pages/dashboard.astro:82-83` - invite link built from request origin
- `src/lib/config-status.ts:1-21` - runtime check of Supabase secrets (banner when missing)
- `public/` - only `favicon.png`, `template.png`, `.assetsignore`
- `dist/client/_headers` - immutable cache only for `/_astro/*`
- `supabase/config.toml:154-156` - local-only auth `site_url` (not used by the hosted project)
- `scripts/smoke.mjs:6-10,45-50` - `BASE_URL` / `Origin` handling to extend with manifest checks

## Architecture Insights

- **Gate, then ship.** The repo's quality bar is the `ci` and `smoke` jobs. Deploying only after both pass on the merge commit keeps production equal to "the last green `main`".
- **Schema leads code.** Migrations reach the hosted DB before merge (manual `db push`), so post-merge code deploys are always forward-compatible. This also means production code lags the schema between push and merge. Every archived plan already accepts that window. Note: production is currently 3 slices behind, so the first automatic deploy will release S-03, S-04 and S-05 at once.
- **One `<head>`.** `Layout.astro` is the only document shell, so installability is a single-file change plus static assets in `public/`.
- **Static assets bypass the worker and the auth middleware.** This is good for the manifest and icons. It also means nothing in `public/` can be protected, which is fine because none of it is private.
- **Secrets live in two places on purpose.** The GitHub secrets feed CI builds and tests. The Cloudflare worker secrets feed the runtime. A deploy token only needs to deploy, not manage secrets.

## Historical Context (from prior changes)

- `context/archive/2026-10-07-link-partner-household/research.md:262` - already noted that F-03 is independent and that the production URL `https://duo-kitchen.mediewilnp.workers.dev` is stable, which the invite link relies on.
- `context/archive/2026-10-07-link-partner-household/plan.md:46,110,121` - the "CI tests the deployed schema; push before merge" constraint. It is the reason a CI deploy step must not also run `db push`.
- `context/archive/2026-10-08-shared-recipe-library/plan.md:57,63` - push the git commit right after the tests pass, to keep the window where `main` and the hosted schema disagree short.
- Commit `f57db93` - renamed the worker to `duo-kitchen` and documented the live URL (the first manual deploy). Commit `f5b5f2d` - moved CI from `master` to `main`.
- `context/foundation/tech-stack.md` - `ci_default_flow: auto-deploy-on-merge`. Note `deployment_target: cloudflare-pages`, while the project actually deploys to **Workers** with static assets (`wrangler.jsonc` `main` + `assets`). The plan should follow the code and use Workers.
- `context/foundation/prd.md:127-128,134` - the installability NFR. Offline check-off is deferred to v2, which confirms no service worker or offline cache is needed.

## Related Research

- `context/archive/2026-10-07-link-partner-household/research.md` (mentions F-03 and the stable production URL)

## Open Questions

1. **One Supabase project for dev, CI and production.** Is it acceptable that the production database also receives CI's `smoke-*` accounts and RLS/seed test transactions (the transactions are rolled back, the accounts are not)? The CLAUDE.md hard rule says yes by implication. A separate production project would contradict it and need its own migration flow. **Assumption:** keep one project. Optionally have the plan add a short README note that smoke accounts in production are expected and how to clean them up (the cleanup queries already exist in the README).
2. **API token scope.** Will the account's existing token include Workers KV Storage: Edit (needed if wrangler auto-provisions `SESSION` on CI deploys), or should the plan disable the unused Astro session driver? It should be verified with one deploy run, or by checking whether the existing worker already has a `SESSION` binding in the dashboard.
3. **Icon artwork.** Nothing exists beyond `favicon.png`. **Assumption:** a simple generated mark (e.g. initials "DK" on a solid colour) is enough for F-03. Branding is not in scope.
4. **App name, language and theme colour.** Manifest `name` / `short_name` ("Duo Kitchen") and `lang`: S-14 owns PL/EN and light/dark. **Assumption:** F-03 uses `"Duo Kitchen"`, leaves `lang` as is, and picks one `theme_color` / `background_color` matching the current light palette (`src/styles/global.css` `--background`). The same change should replace the layout's default title `"10x Astro Starter"` so the iOS home-screen label is right.
5. **Custom domain.** None is configured. **Assumption:** stay on `workers.dev`. A later domain change only touches `wrangler.jsonc` routes, while the manifest uses relative URLs.
6. **First deploy releases three slices at once** (S-03, S-04, S-05). They have all been verified against the hosted schema, so this is low risk, but the plan should state it so the first post-merge check covers `/plan`, `/plan/day` and `/recipes` on production.
