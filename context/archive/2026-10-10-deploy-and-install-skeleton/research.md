---
date: 2026-10-10
change_id: deploy-and-install-skeleton
topic: "F-03 — auto-deploy from main and installability (PWA manifest)"
status: complete
---

# Research: Deploy and install skeleton (F-03)

## Research Question

What already exists for deploying Duo Kitchen and for installing it to a home screen, and what is the
smallest change that makes (a) a merge to `main` deploy the Worker to production and (b) the app
installable on desktop (Chrome/Edge), Android (Chrome) and iOS (Safari "Add to Home Screen")?
Scope per `context/foundation/roadmap.md` §F-03: auto-deploy from `main` plus a PWA manifest; **no
offline support** (parked).

## Summary

- **Deploy today is manual.** `README.md` §Deployment says `npm run build && npx wrangler deploy`.
  `.github/workflows/ci.yml` runs `ci` (lint, unit tests, `astro check`, build) and `smoke`
  (isolation test, seed test, production preview + `npm run smoke`) on push/PR to `main`, but has no
  deploy job. The Worker is already named `duo-kitchen` (`wrangler.jsonc`) and the production URL is
  stable: `https://duo-kitchen.mediewilnp.workers.dev`.
- **Production Supabase is the one hosted project** (`tvmfkhnxxsnmvogplknz`, CLAUDE.md "Supabase is
  cloud-only"). There is no separate staging database, so "a production Supabase project" in the
  roadmap outcome is already satisfied by the existing project. The Worker reads `SUPABASE_URL` /
  `SUPABASE_KEY` at runtime as Cloudflare secrets (`astro:env/server`, `access: "secret"`), which are
  already set on the live Worker — a CI deploy does not have to (and must not) re-upload them.
- **Schema drift is the real deploy hazard.** Migrations are applied by hand with
  `npx supabase db push` before merging (CLAUDE.md hard rule). CI has `SUPABASE_ACCESS_TOKEN` and
  `SUPABASE_PROJECT_REF` but **no database password**, and `supabase db push` needs one, so CI cannot
  push migrations. It *can* read `supabase_migrations.schema_migrations` through
  `supabase db query --linked` (Management API, the same path `npm run test:rls` uses). A pre-deploy
  gate that fails when a file in `supabase/migrations/` is not recorded remotely turns "forgot to db
  push" into a red deploy instead of a broken production app.
- **Installability today: nothing.** `src/layouts/Layout.astro` (used by every page) only links
  `/favicon.png` (32×32 RGBA, the starter's). No manifest, no `apple-touch-icon`, no `theme-color`,
  default title `"10x Astro Starter"`, `<meta name="viewport" content="width=device-width">` without
  `initial-scale=1`. `public/` holds `favicon.png` and `template.png` only.
- **Current install criteria** (Chromium desktop and Android): served over HTTPS, a linked web app
  manifest with `name` or `short_name`, `icons` including 192 px and 512 px, `start_url`, `display` of
  `standalone` / `fullscreen` / `minimal-ui`, and `prefer_related_applications` not `true`. Chromium
  no longer requires a service worker with a fetch handler for the install prompt. **iOS Safari** has
  no install prompt: users use Share → "Add to Home Screen"; it uses `apple-touch-icon` (180×180) for
  the icon, and honours the manifest's `display: standalone` (iOS 16.4+), with
  `apple-mobile-web-app-title` / `-status-bar-style` meta as the legacy hints.
- **A service worker is not needed and would be a liability here.** The app is SSR with cookie
  sessions; a caching worker risks serving one user's stale authenticated HTML. With offline parked,
  shipping no service worker is the conservative choice.

## Detailed Findings

### CI and deploy (`.github/workflows/ci.yml`, `wrangler.jsonc`)

- Triggers: `push` and `pull_request` on `main`. Two jobs, `ci` and `smoke`, both independent.
- `smoke` writes `.env` / `.dev.vars` from secrets, builds, and runs `npm run preview` (the Cloudflare
  runtime) for `npm run smoke`.
- `wrangler.jsonc`: `name: duo-kitchen`, `main: @astrojs/cloudflare/entrypoints/server`, assets
  binding `ASSETS` from `./dist`, `not_found_handling: 404-page`, observability on. No `account_id`
  (wrangler resolves it from `CLOUDFLARE_ACCOUNT_ID` or the token).
- `wrangler` ^4.131 is a devDependency, so `npx wrangler deploy` works in CI after `npm ci` without a
  third-party action. Non-interactive deploy needs `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare
  Workers") and, when the token can see more than one account, `CLOUDFLARE_ACCOUNT_ID`. Neither secret
  exists in the repo yet (they are not referenced anywhere) — a manual setup step for the owner.
- `wrangler deploy` uploads code and assets only; existing Worker secrets survive a deploy.

### Static assets and middleware (`src/middleware.ts`)

- `PROTECTED_ROUTES` uses `pathname.startsWith(route)` for `/dashboard`, `/targets`, `/plan`,
  `/recipes`. A manifest at `/manifest.webmanifest` and icons under `/icons/` match none of those.
- With `assets.directory: ./dist`, files from `public/` are served by Cloudflare's asset layer before
  the Worker runs, so the manifest and icons never hit the middleware or Supabase. Cloudflare serves
  `.webmanifest` as `application/manifest+json`.

### Pages and navigation in standalone mode

- Every page renders through `Layout.astro`, so one `<head>` change covers the whole app.
- In `display: standalone` there is no browser back button. Navigation is already closed: the
  dashboard links to `/targets`, `/plan`, `/recipes` and has a sign-out form; those pages carry the
  `Topbar` (Dashboard link); `/plan/day` links back to `/plan`; `/recipes/[id]` back to `/recipes`;
  auth pages link to each other. No dead ends.
- `start_url`: `/dashboard` is the useful landing page for an installed app; the middleware already
  redirects a signed-out visitor to `/auth/signin`, and sign-in lands on `/`, whose hero links onward.
- Theme: `src/styles/global.css` defines a `.dark` variant but pages use the starter's dark "cosmic"
  look (`bg-cosmic`); a dark `theme_color`/`background_color` (e.g. `#0f172a`) matches it.

### Icons

- Needed: 192×192 and 512×512 `purpose: "any"`, a 512×512 `purpose: "maskable"` (content inside the
  80 % safe zone, full-bleed background), 180×180 `apple-touch-icon` (opaque — iOS fills transparency
  with black), and a 32×32 favicon. ImageMagick (`convert`) and Python Pillow are available in the dev
  container; icons are committed as static PNGs, not generated at build time (no new dependency).

### Tests

- `scripts/smoke.mjs` is a flat `steps` array of `[name, fn, expectation]` run against `BASE_URL`;
  expectations support `status`, `location` and a `body` regex. Adding anonymous checks for the
  manifest (200, parses, has the install-relevant fields) and for the `<link rel="manifest">` in the
  home page fits the existing shape and runs in CI against the production preview.
- No Supabase rows, no RLS surface: this change adds no table or function, so the isolation and seed
  tests are untouched.

## Code References

- `.github/workflows/ci.yml` — jobs `ci`, `smoke`; no deploy job.
- `wrangler.jsonc` — Worker `duo-kitchen`, assets from `./dist`.
- `src/layouts/Layout.astro:16-21` — the `<head>`; favicon only, title default "10x Astro Starter".
- `src/middleware.ts:4-11` — `PROTECTED_ROUTES` prefix list.
- `scripts/smoke.mjs:223-224` — first anonymous steps (`home renders`).
- `README.md` §Deployment, §CI — manual deploy instructions to update.

## Assumptions (non-interactive session)

- "Production Supabase project" = the existing hosted project; no second project is created.
- The owner adds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets; until then
  the deploy job fails loudly on `main` (it is gated on push to `main` only, never on PRs).
- Cloudflare Workers Builds (Cloudflare's own git integration) is **not** connected; if it were, it
  would double-deploy and one of the two must be switched off.
- No service worker, no offline support, no install-prompt UI (browsers' own install affordances).

## Open Questions

- None blocking. The deploy secrets are an owner action, recorded as a manual step in the plan.
