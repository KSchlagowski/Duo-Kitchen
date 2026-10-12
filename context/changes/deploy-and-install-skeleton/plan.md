# F-03 Deploy and Install Skeleton Implementation Plan

## Overview

Make every green merge to `main` deploy the app to the live Cloudflare worker `duo-kitchen` (`https://duo-kitchen.mediewilnp.workers.dev`), backed by the hosted Supabase project. Also make the app installable to the home screen on desktop Chromium, Android and iOS with a web app manifest, an icon set and the matching `<head>` tags. This is roadmap F-03 (`context/foundation/roadmap.md:103-114`). It unlocks the real-phone verification of S-04 and gives S-12 a reachable endpoint.

## Current State Analysis

- **Deploys are manual and production is stale.** No deploy command exists in the repo. The README "Deployment" section (`README.md:146`) describes `npx wrangler deploy` by hand. Production serves S-01/S-02, but `/plan` and `/recipes` return 404 (research §Summary). The first automatic deploy will therefore release S-03, S-04 and S-05 together.
- **CI** (`.github/workflows/ci.yml`) runs `ci` (lint, unit tests, `astro check`, build) and `smoke` (RLS + seed tests against hosted Supabase, then `npm run smoke` against a local production preview). Both run on `push` and `pull_request` to `main`. There is no `deploy` job, no `concurrency` and no `environment`.
- **Build output**: `astro build` writes `dist/server/wrangler.json` plus the redirect `.wrangler/deploy/config.json`, so a bare `npx wrangler deploy` after the build uses the generated config. That config contains an id-less `kv_namespaces: [{ binding: "SESSION" }]`, injected by `@astrojs/cloudflare` because `config.session` has no driver (`node_modules/@astrojs/cloudflare/dist/index.js:98-121`). The app never uses `Astro.session`. Wrangler would auto-provision that namespace on deploy, which needs a broader API token.
- **Verified here**: the installed Astro (7.3.2) accepts `session: false` (`node_modules/astro/dist/core/session/config.js:29` — `z.union([z.literal(false), SessionObjectSchema])`). The adapter's `usesCloudflareKVSessionDriver()` returns false for it (`index.js:35-36`), and line 109 skips the injection. So the binding can be removed with one config line.
- **Runtime secrets**: `SUPABASE_URL` / `SUPABASE_KEY` are `access: "secret"` (`astro.config.mjs:17-22`), read at runtime from the worker's env, and already set as worker secrets by hand. `wrangler deploy` preserves existing secrets.
- **Installability is absent.** `src/layouts/Layout.astro:13-20` has only charset, a bare `width=device-width` viewport, a 32×32 `favicon.png` and `<title>` (default `"10x Astro Starter"`). There is no manifest, no app icons and no theme or iOS meta. Every page uses this one layout.
- **Static assets bypass the worker.** Files in `public/` are served by the `ASSETS` binding before the worker runs (no `run_worker_first`), so the manifest and icons never reach `src/middleware.ts`'s auth redirect or its `getUser()` call.
- No `context/foundation/lessons.md` exists.

## Desired End State

- A push to `main` (normally a merged PR) runs `ci` and `smoke`. Only if both pass does a `deploy` job build and run `wrangler deploy` to the `duo-kitchen` worker, then confirm with a post-deploy probe that production answers. PRs never deploy. Two quick merges leave production on the newer one: a deploy run whose commit is no longer the tip of `main` skips its deploy. A manual "Run workflow" on `main` re-deploys the current `main`.
- Production serves `/manifest.webmanifest` (name "Duo Kitchen", `start_url` `/dashboard`, `display` `standalone`, 192/512 PNG icons plus a maskable 512) and `/icons/*`. Every page's `<head>` links the manifest and carries `theme-color`, `apple-touch-icon` and the iOS web-app meta.
- Chrome/Edge on desktop and Chrome on Android offer "Install app". iOS Safari "Add to Home Screen" shows the Duo Kitchen icon and label and opens standalone.
- The README and CLAUDE.md describe the auto-deploy, its secrets and the one-time manual setup.

Verify by: the CI smoke test asserting manifest, icons and head tags on the preview; the deploy job's post-deploy probe; and a manual install on the three platforms.

### Key Discoveries:

- `.github/workflows/ci.yml:3-7` — triggers already on `main`. The deploy job only adds a job (plus `workflow_dispatch`).
- `node_modules/astro/dist/core/session/config.js:29` + `@astrojs/cloudflare/dist/index.js:35-36,109` — `session: false` removes the `SESSION` KV binding.
- `src/layouts/Layout.astro:10-20` — the single `<head>`. Each page passes its own `title` (`src/pages/**`), and only `index.astro` uses the default.
- `scripts/smoke.mjs:10,45-50` — `BASE_URL` / `Origin` client to reuse for the manifest checks. Assertions use the existing request helper and failure style.
- `src/styles/global.css:8,14` — light `--background` is white (`oklch(1 0 0)`), `--primary` near-black (`oklch(0.205 0 0)` ≈ `#171717`).
- `sharp@0.35.4` is installed transitively via `astro`, which gives a way to render PNG icons once from an SVG source.

## Assumptions (settled here, non-interactive session)

- **A1 — The hosted project is production.** CLAUDE.md "Supabase is cloud-only" pins `tvmfkhnxxsnmvogplknz` for everything, so "a production Supabase project" (roadmap) is that project. No second project and no staging. Smoke-run `smoke-*` accounts landing in it is accepted; the README cleanup queries already exist and the docs will say so explicitly.
- **A2 — No `db push` in CI.** Migrations keep reaching the hosted DB by hand **before** merge (CLAUDE.md hard rule), so post-merge code is always deployed against a current schema.
- **A3 — Worker secrets stay manual and one-time.** The deploy job does not sync `SUPABASE_URL` / `SUPABASE_KEY` to the worker. The Cloudflare token only needs to deploy scripts.
- **A4 — Disable Astro sessions (`session: false`)** rather than widen the API token to Workers KV Storage: Edit. The app does not use `Astro.session`, and Supabase sessions live in their own cookies (`src/lib/supabase.ts`). The `IMAGES` binding is left as generated: it needs no provisioned resource and manual deploys already succeeded with it.
- **A5 — `npx wrangler deploy` (devDependency 4.147.0), not `cloudflare/wrangler-action`.** This keeps the wrangler version locked by `package-lock.json` and matches the existing `npx` pattern in the workflow.
- **A6 — Deploy is gated on both `ci` and `smoke`** (`needs: [ci, smoke]`), runs only for `push` / `workflow_dispatch` on `refs/heads/main`, uses `concurrency: { group: deploy-production, cancel-in-progress: false }`, skips the deploy when its commit is no longer the tip of `main` (concurrency alone does not order runs by commit), and uses `environment: { name: production, url: <prod URL> }`. Secrets stay repository-level. The environment only gives a deployment record and a link in GitHub.
- **A7 — No service worker.** Current Chromium offers install with a manifest alone. Offline is parked (PRD v2). If manual verification shows an older target needs one, that is a follow-up, not this change.
- **A8 — `start_url: "/dashboard"`, `scope: "/"`, `display: "standalone"`.** The middleware redirects a signed-out launch to sign-in. `/` is the starter welcome page and a poor landing.
- **A9 — Icon artwork is a generated mark**: "DK" (as SVG path outlines, not font text) in white on a `#171717` rounded tile, with a maskable variant that keeps the mark inside the 80 % safe zone on a full-bleed tile. Branding is out of scope.
- **A10 — Name, colour, language.** `name` and `short_name` are "Duo Kitchen". `theme_color` and `background_color` are `#ffffff` (the light `--background`). `<html lang>` and the manifest `lang` are left to S-14, so the manifest omits `lang`. The layout's default title becomes "Duo Kitchen", and per-page titles are unchanged.
- **A11 — Stay on `workers.dev`.** All manifest URLs are relative, so a later custom domain only touches `wrangler.jsonc`.
- **A12 — Post-deploy check is a light HTTP probe, never the full smoke suite.** The full suite would create more accounts in production.

## What We're NOT Doing

- No service worker, offline cache or push notifications.
- No second Supabase project, no staging environment and no preview deploys for PRs.
- No `supabase db push` or other schema step in CI.
- No syncing of worker secrets from GitHub, and no custom domain or `routes`.
- No localisation (`lang`, PL strings) or dark-mode manifest colours (S-14).
- No renaming of `package.json` `name` and no README template image or title rework beyond the deploy and install sections, and no change to the starter welcome page (`src/components/Welcome.astro`) beyond the layout's default `<title>`.
- No `_headers` cache rules for the manifest. Workers assets' default revalidating cache is correct for a fixed-URL file.
- No roadmap status edit. That happens on archive.

## Implementation Approach

Three phases, each verifiable on its own:

1. Ship installability first. It is pure static files plus one layout edit, and it is testable in the existing CI preview through the smoke test.
2. Add the deploy pipeline: `session: false`, the `deploy` job and the post-deploy probe. The job can only truly run after merge, so Phase 2's automated checks prove the build output and workflow shape on the branch.
3. Do the one-time manual setup (GitHub secrets and the token), the docs, and the merge that triggers the first automatic release. Then verify production and real-device installs.

## Critical Implementation Details

- **Ordering of the first release.** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must exist as repository secrets **before** the PR merges. Otherwise the first `deploy` run fails (no harm is done; re-run it with "Run workflow" after adding them). The worker secrets `SUPABASE_URL` / `SUPABASE_KEY` are already set. Confirm in the Cloudflare dashboard (Worker → Settings → Variables and Secrets) before merging, because a deploy cannot restore missing ones.
- **The deploy job must build in its own job.** No job uploads `dist/`, and `wrangler deploy` reads the build-generated `.wrangler/deploy/config.json`. So `npm ci` → `npm run build` → `npx wrangler deploy` must run in the same job, from the repo root.
- **`session: false` removes a binding from the live worker** on the first deploy. That is intended, since nothing reads it. If a `SESSION` KV namespace was auto-created by an earlier manual deploy, it becomes orphaned and can be deleted from the dashboard later. It is harmless.
- **iOS standalone cookie jar.** An app installed on iOS does not share cookies with Safari, so the user signs in once more inside the installed app. Expect this during manual verification; it is not a bug.

## Phase 1: Installability (manifest, icons, head tags)

### Overview

Add the web app manifest, a generated icon set and the `<head>` tags so every page is installable. Extend the smoke test to assert all of it against the CI production preview.

### Changes Required:

#### 1. Icon source and generator

**File**: `public/icons/icon.svg`, `scripts/generate-icons.mjs`

**Intent**: Commit an SVG source mark (A9), with the "DK" drawn as `<path>` outlines (or simple geometric shapes), never `<text>` — librsvg rasterises `<text>` with whatever fonts the local machine has, so PNGs would differ per OS — and a one-off, manually run script that renders the PNG set from it with `sharp`. The PNGs are committed, so CI and the build never run the script.

**Contract**: The script writes these files to `public/icons/`:

- `icon-192.png` (192×192)
- `icon-512.png` (512×512)
- `icon-maskable-512.png` (512×512, full-bleed background, mark within the central 80 %)
- `apple-touch-icon.png` (180×180, opaque background, because iOS fills transparency with black)

Run it with `node scripts/generate-icons.mjs`. `sharp` is imported as an existing transitive (optional) dependency of `astro`, so its presence is not guaranteed on every install. If ESLint or Node resolution rejects that, add `sharp` as a devDependency pinned to the installed `0.35.4` rather than working around it. `favicon.png` stays as is.

#### 2. Web app manifest

**File**: `public/manifest.webmanifest`

**Intent**: Declare the installable app (A8, A10).

**Contract**: The manifest is JSON with:

- `name` and `short_name`: "Duo Kitchen"
- `id`: `"/dashboard"`
- `start_url`: `"/dashboard"`
- `scope`: `"/"`
- `display`: `"standalone"`
- `theme_color` and `background_color`: `"#ffffff"`
- `icons`: `[192 any, 512 any, 512 maskable]`, all `type: "image/png"` with relative `src` under `/icons/`

There is no `lang` field.

#### 3. Layout head

**File**: `src/layouts/Layout.astro`

**Intent**: Link the manifest and add the platform tags in the one shared `<head>`, and replace the starter default title.

**Contract**:

- Default `title` becomes `"Duo Kitchen"`.
- Viewport becomes `width=device-width, initial-scale=1, viewport-fit=cover`.
- Add these tags:
  - `<link rel="manifest" href="/manifest.webmanifest">`
  - `<meta name="theme-color" content="#ffffff">`
  - `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`
  - `<meta name="apple-mobile-web-app-title" content="Duo Kitchen">`
  - `<meta name="mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-capable" content="yes">`
  - `<meta name="apple-mobile-web-app-status-bar-style" content="default">`
- The favicon link is unchanged.

#### 4. Smoke test assertions

**File**: `scripts/smoke.mjs`

**Intent**: Prove in CI that the preview serves an installable app, with no account needed. Add the checks as an early, signed-out block in the existing assertion style, and extend the header comment with an F-03 line.

**Contract**:

- `GET /manifest.webmanifest` returns 200, with `content-type` `application/manifest+json` or `application/json`, and parses as JSON.
- The manifest's `name` is "Duo Kitchen", `start_url` is `/dashboard` and `display` is `standalone`.
- `icons` includes `192x192` and `512x512` with `image/png`, and at least one has `purpose` containing `maskable`.
- Every listed icon `src` and `/icons/apple-touch-icon.png` returns 200 `image/png`.
- `GET /auth/signin` HTML contains `rel="manifest"`, `rel="apple-touch-icon"`, `name="theme-color"` and `apple-mobile-web-app-title`.
- `GET /` has `<title>Duo Kitchen</title>`, and its `<title>` element does not contain "10x Astro Starter". The assertion targets the title only: the body still renders `src/components/Welcome.astro`'s starter hero ("10x Astro Starter"), which stays untouched.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Types check: `npx astro check`
- Unit tests still pass: `npm test`
- Build succeeds and `dist/client/manifest.webmanifest` plus the four `dist/client/icons/*.png` exist: `npm run build`
- Smoke test passes against the local preview, including the new F-03 block: `npm run build && npm run preview` then `BASE_URL=http://localhost:4321 npm run smoke`
- CI `ci` and `smoke` jobs are green on the PR

#### Manual Verification:

- Chrome DevTools → Application → Manifest on the local preview shows no installability errors, and the icons render correctly, including the maskable preview
- The generated icons look acceptable at every size (the mark is legible at 180/192 and not clipped in the maskable variant)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Auto-deploy pipeline

### Overview

Remove the unused session KV binding, then add a gated `deploy` job that ships `main` to the `duo-kitchen` worker and probes production afterwards.

### Changes Required:

#### 1. Disable Astro sessions

**File**: `astro.config.mjs`

**Intent**: Stop the Cloudflare adapter from injecting the id-less `SESSION` KV binding, so CI deploys need only a Workers Scripts token (A4). Add a one-line comment saying why.

**Contract**: Top-level `session: false`. After `npm run build`, `dist/server/wrangler.json` has no `SESSION` entry in `kv_namespaces` (top level and `previews`).

#### 2. Deploy job

**File**: `.github/workflows/ci.yml`

**Intent**: Deploy every green `main` automatically (A5, A6) and allow a manual re-deploy of `main`.

**Contract**:

- Add `workflow_dispatch:` to `on:`. The existing jobs run on it too, which is the intended gate.
- Add a workflow-level `env: PRODUCTION_URL: https://duo-kitchen.mediewilnp.workers.dev` (or a job-level one).
- Add a new job `deploy`:
  - `needs: [ci, smoke]`
  - `if: github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')`
  - `concurrency: { group: deploy-production, cancel-in-progress: false }`
  - `environment: { name: production, url: ${{ env.PRODUCTION_URL }} }` (if the expression context rejects `env` there, inline the URL)
  - `runs-on: ubuntu-latest`
- Its steps:
  1. checkout
  2. setup-node 22 with npm cache
  3. `npm ci`
  4. `npm run build` with the same `SUPABASE_URL` / `SUPABASE_KEY` env as the `ci` job's build
  5. one `run:` step (id `deploy`) with env `CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}` and `CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}` that first checks this run's commit is still the tip of `main` and only then deploys:
     ```sh
     head=$(git ls-remote origin refs/heads/main | cut -f1)
     if [ "$head" != "$GITHUB_SHA" ]; then
       echo "main moved to $head; the newer run will deploy"
       echo "deployed=false" >> "$GITHUB_OUTPUT"
       exit 0
     fi
     npx wrangler deploy --message "$GITHUB_SHA"
     echo "deployed=true" >> "$GITHUB_OUTPUT"
     ```
     This keeps production on the newest green `main`: `concurrency` only serialises deploy jobs, it does not order them by commit, so a slower older run could otherwise overwrite a newer release. If the newest commit's `smoke` fails, the older commit is not deployed either, and production stays on the last deployed version until `main` is green again. `--message "$GITHUB_SHA"` makes each Cloudflare version traceable to its commit for `wrangler rollback`. `wrangler deploy`'s exit code is the authoritative "new version is live" signal; the probe proves the release is healthy.
  6. the post-deploy probe, with `if: steps.deploy.outputs.deployed == 'true'`

#### 3. Post-deploy probe

**File**: `.github/workflows/ci.yml` (inline `run:` step in `deploy`)

**Intent**: Confirm the release answers on production without creating accounts (A12). Retry briefly, because a new version can take a few seconds to propagate.

**Contract**: With up to ~10 attempts a few seconds apart, the step fails unless all of the following hold:

- `$PRODUCTION_URL/` returns 200.
- `$PRODUCTION_URL/manifest.webmanifest` returns 200 and its body contains `"Duo Kitchen"`.
- `$PRODUCTION_URL/recipes` returns 302 with no redirect following. That route is protected, so 302 proves the current routes are live; a 404 would mean a stale deploy.
- `$PRODUCTION_URL/auth/signin` returns 200 and its body does **not** contain `Supabase nie jest skonfigurowany` (the banner from `src/lib/config-status.ts`). This catches missing `SUPABASE_URL` / `SUPABASE_KEY` worker secrets, which `/recipes` alone cannot: without them the middleware still 302s.

It uses `curl` only. After the first release the `/recipes` 302 no longer tells the new version from the previous one, so the probe is a health check; `wrangler deploy`'s exit code (step 5) is what proves the new version is live.

### Success Criteria:

#### Automated Verification:

- Build succeeds and the generated config no longer declares the session KV binding: `npm run build` then `node -e "const c=require('./dist/server/wrangler.json'); if (JSON.stringify(c).includes('SESSION')) process.exit(1)"`
- Lint, types, unit tests still pass: `npm run lint`, `npx astro check`, `npm test`
- Smoke test still passes on the local preview (the session change must not affect auth): `BASE_URL=http://localhost:4321 npm run smoke`
- The workflow file is valid YAML and GitHub accepts it: the PR's checks list shows `ci` and `smoke` green and `deploy` **skipped** (proves the PR guard)
- Optional dry-run with the real token from a local shell: `npx wrangler deploy --dry-run` succeeds after `npm run build`

#### Manual Verification:

- The workflow diff reads correctly: `deploy` cannot run on `pull_request`, and it waits for both other jobs

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: One-time setup, docs and first production release

### Overview

Configure the secrets the pipeline needs, document the new flow, merge, and verify the first automatic release and real-device installs.

### Changes Required:

#### 1. One-time manual setup (human, not code)

**Intent**: Give CI permission to deploy, and confirm the runtime config the deploy relies on.

**Contract**:

- Create a **custom** Cloudflare API token (not the "Edit Cloudflare Workers" template, which also grants KV, R2, Routes and other edit permissions) with only Account → Workers Scripts: Edit, scoped to the one account and no zone resources. If `wrangler deploy` fails with an authentication error naming another permission, add only that permission. `CLOUDFLARE_ACCOUNT_ID` stays set so wrangler needs no user/membership read.
- Add the GitHub repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- Confirm the `duo-kitchen` worker still has the `SUPABASE_URL` / `SUPABASE_KEY` secrets.
- Set the hosted Supabase project's Auth → URL Configuration → Site URL to the production URL. This is not used today (email confirmation is off and there is no `emailRedirectTo`), but it is correct for later.

#### 2. README

**File**: `README.md`

**Intent**: Replace the manual-deploy instructions and document the pipeline and its setup.

**Contract**:

- **"Deployment"** (`:146`): merging to `main` deploys automatically after `ci` + `smoke`. Re-deploy with Actions → CI → Run workflow on `main`, with this sentence: "Run workflow re-runs the full CI and smoke suite, which adds two `smoke-*` accounts to the production project; use the cleanup queries below afterwards." Roll back with `npx wrangler rollback` (or the dashboard's Deployments tab), the cheaper path for reverting. Include the one-time setup from §1 (custom Workers Scripts: Edit token, the two GitHub secrets, worker secrets set once with `npx wrangler secret put`). Manual `npx wrangler deploy` remains possible locally.
- **"CI"** (`:190`): add the `deploy` job, its gate, its tip-of-`main` check (a run whose commit is no longer the tip of `main` skips its deploy), its secrets and its post-deploy probe.
- **Cleanup note**: smoke-run accounts land in the production project by design (A1).
- **Installing the app**: one short subsection covering desktop/Android "Install app" and iOS Share → Add to Home Screen, including the separate sign-in inside the installed iOS app.

#### 3. CLAUDE.md

**File**: `CLAUDE.md`

**Intent**: Keep the agent rules accurate.

**Contract**:

- In the **"CI"** section, add a `deploy` bullet: push/dispatch on `main` only, `needs: [ci, smoke]`, skipped when the run's commit is no longer the tip of `main`, `wrangler deploy --message "$GITHUB_SHA"` to `duo-kitchen`, and the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets.
- One sentence noting `session: false` in `astro.config.mjs` is deliberate: re-enabling Astro sessions needs a KV binding and a wider token.
- One line in Architecture noting that installability lives in `public/manifest.webmanifest`, `public/icons/` and `Layout.astro`'s head.

#### 4. Merge and first release

**Intent**: The merge to `main` is the first automatic production deploy, and it releases S-03, S-04 and S-05 together with F-03.

**Contract**: The PR merges only after secrets from §1 exist and all migrations on `main` are already pushed. They are; the last ones landed with S-04.

### Success Criteria:

#### Automated Verification:

- Prettier/lint on changed docs passes (pre-commit hook): `npx prettier --check README.md CLAUDE.md`
- After merge, the `deploy` job on `main` is green, including the post-deploy probe
- `curl -sI https://duo-kitchen.mediewilnp.workers.dev/manifest.webmanifest` returns 200 with a manifest/JSON content type

#### Manual Verification:

- Production: sign in, then `/plan`, `/plan/day`, `/recipes` and `/recipes/<id>` work against the hosted DB (the first release of S-03–S-05)
- Desktop Chrome or Edge offers "Install app", and the installed window opens on `/dashboard` (or sign-in when signed out)
- Android Chrome offers install, and the home-screen icon is the maskable DK mark, uncropped, opening standalone
- iOS Safari Share → Add to Home Screen shows the label "Duo Kitchen" and the DK icon, and the app opens standalone. Signing in inside the app works.
- A second trivial merge (or "Run workflow") deploys again with no manual step

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- None. No domain logic changes; vitest suites must stay green.

### Integration Tests:

- The smoke test's new F-03 block runs in the CI production preview: manifest content and type, every icon reachable as PNG, head tags present, starter `<title>` gone.
- `test:rls` / `test:seed` are unaffected, since there is no schema change.
- The deploy job's post-deploy probe is the production-side integration check.

### Manual Testing Steps:

1. Local preview: DevTools → Application → Manifest shows no errors, and Lighthouse PWA "Installable" passes, if available in the installed Chrome.
2. After merge: the GitHub Actions run shows `ci` ✓, `smoke` ✓, `deploy` ✓ and the `production` environment link.
3. Production walkthrough of `/plan`, `/plan/day`, `/recipes`.
4. Install on desktop, Android and iOS as listed in Phase 3.
5. PR check: a fresh PR shows `deploy` as skipped.

## Performance Considerations

- The manifest and icons are static assets served before the worker, so they add no worker CPU and no Supabase `getUser()` calls.
- Icons stay small: flat PNGs, each well under 50 KB.
- The deploy job adds about one build plus an upload (~1–2 min) after `smoke`. It does not slow PR feedback.

## Migration Notes

- No database migration.
- The first deploy removes the worker's unused `SESSION` KV binding, and any auto-created namespace can be deleted later from the dashboard.
- **Rollback**: `npx wrangler rollback` (or the Cloudflare dashboard → Deployments) restores the previous worker version. Then revert the offending commit on `main`, which redeploys through the pipeline.

## References

- Related research: `context/changes/deploy-and-install-skeleton/research.md`
- Roadmap item: `context/foundation/roadmap.md:103-114`
- CI workflow: `.github/workflows/ci.yml:1-61`
- Session injection: `node_modules/@astrojs/cloudflare/dist/index.js:35-47,98-121`; schema `node_modules/astro/dist/core/session/config.js:29`
- Single head: `src/layouts/Layout.astro:10-20`
- Smoke client: `scripts/smoke.mjs:10,17-60`
- Push-before-merge convention: `context/archive/2026-10-07-link-partner-household/plan.md:46,110,121`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Installability (manifest, icons, head tags)

#### Automated

- [ ] 1.1 Lint passes: `npm run lint`
- [ ] 1.2 Types check: `npx astro check`
- [ ] 1.3 Unit tests still pass: `npm test`
- [ ] 1.4 Build succeeds and `dist/client/manifest.webmanifest` plus the four `dist/client/icons/*.png` exist
- [ ] 1.5 Smoke test passes against the local preview, including the new F-03 block
- [ ] 1.6 CI `ci` and `smoke` jobs are green on the PR

#### Manual

- [ ] 1.7 Chrome DevTools Manifest panel shows no installability errors and icons render (incl. maskable)
- [ ] 1.8 Generated icons look acceptable at every size

### Phase 2: Auto-deploy pipeline

#### Automated

- [ ] 2.1 Build succeeds and the generated config no longer declares the session KV binding
- [ ] 2.2 Lint, types, unit tests still pass
- [ ] 2.3 Smoke test still passes on the local preview
- [ ] 2.4 PR checks show `ci` and `smoke` green and `deploy` skipped
- [ ] 2.5 Optional: `npx wrangler deploy --dry-run` succeeds after build

#### Manual

- [ ] 2.6 Workflow diff reviewed: `deploy` cannot run on `pull_request` and waits for both jobs

### Phase 3: One-time setup, docs and first production release

#### Automated

- [ ] 3.1 Prettier check on changed docs passes
- [ ] 3.2 After merge, the `deploy` job on `main` is green including the post-deploy probe
- [ ] 3.3 Production `/manifest.webmanifest` returns 200 with a manifest/JSON content type

#### Manual

- [ ] 3.4 Production `/plan`, `/plan/day`, `/recipes`, `/recipes/<id>` work (first release of S-03–S-05)
- [ ] 3.5 Desktop Chrome/Edge offers install and opens on `/dashboard`
- [ ] 3.6 Android Chrome installs with an uncropped maskable icon, standalone
- [ ] 3.7 iOS Add to Home Screen shows "Duo Kitchen" + icon, opens standalone, sign-in works
- [ ] 3.8 A second merge or "Run workflow" deploys again with no manual step
