# F-03 Deploy and Install Skeleton — Plan Brief

> Full plan: `context/changes/deploy-and-install-skeleton/plan.md`
> Research: `context/changes/deploy-and-install-skeleton/research.md`

## What & Why

Two things change in F-03. A green merge to `main` will deploy the app to production automatically. And the app becomes installable to the home screen on desktop, Android and iOS. Without this, S-04 can only be tried on localhost, while the primary success criterion is the couple using a solved day on their phones in the kitchen. S-12 also needs a reachable endpoint.

## Starting Point

The `duo-kitchen` worker is live at `https://duo-kitchen.mediewilnp.workers.dev`, but it was deployed by hand and is three slices behind (`/plan` and `/recipes` return 404). CI already runs `ci` and `smoke` on `main` but has no deploy job. There is no manifest, no app icons and no install meta. The layout's default title is still "10x Astro Starter".

## Desired End State

Every push to `main` that passes `ci` and `smoke` is built and deployed with `wrangler deploy`. A curl probe then confirms production answers. PRs never deploy. Production serves a manifest, icons and head tags, so Chrome and Edge offer "Install app" and iOS "Add to Home Screen" shows a proper Duo Kitchen icon and label.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Production Supabase | The single hosted project `tvmfkhnxxsnmvogplknz` | CLAUDE.md "cloud-only" rule; there is no second project | Research |
| Schema in CI | No `db push`; migrations are pushed by hand before merge | Existing convention keeps deployed code forward-compatible | Research |
| Deploy gate | `needs: [ci, smoke]`, push/dispatch on `main` only, serialized | Production = last green `main` | Research + Plan |
| Deploy tool | `npx wrangler deploy` (locked devDependency) | No new action; version pinned by the lockfile | Plan |
| Session KV binding | `session: false` in `astro.config.mjs` | The binding is unused and would need a KV-capable token; verified that Astro 7.3.2 accepts `false` | Plan |
| Worker secrets | Manual, one-time; never synced by CI | Smaller token blast radius | Research |
| Post-deploy check | curl probe (`/`, manifest, `/recipes` → 302); never the full smoke suite | The full suite would add accounts to production | Research + Plan |
| Service worker | None | Chromium installs without one; offline is parked | Research |
| `start_url` | `/dashboard`, `display: standalone` | The useful landing page; middleware handles signed-out users | Research |
| Icons | Generated "DK" mark; SVG source plus committed PNGs rendered once with `sharp` | No artwork exists and branding is out of scope | Plan |

## Scope

**In scope:**

- Manifest, icons and `<head>` tags in `Layout.astro`
- Smoke-test assertions for installability
- `session: false`
- The `deploy` job with `workflow_dispatch` and a post-deploy probe
- README and CLAUDE.md updates
- One-time token and secret setup
- First release and real-device checks

**Out of scope:**

- Service worker and offline support
- A second Supabase project, staging or PR previews
- `db push` in CI and syncing secrets
- A custom domain
- Localisation and dark-mode colours (S-14)
- The roadmap status edit (done on archive)

## Architecture / Approach

Static installability files go in `public/`. The Workers assets binding serves them before the worker runs, so they skip the auth middleware. All head tags go in the single `Layout.astro`. The deploy job rebuilds in its own job, because `wrangler deploy` reads the build-generated `.wrangler/deploy/config.json`. It authenticates with `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` and keeps the worker's existing Supabase secrets.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Installability | Manifest, icons, head tags, smoke assertions | Workers assets content type for `.webmanifest` (the smoke test accepts manifest or JSON) |
| 2. Auto-deploy pipeline | `session: false`, gated `deploy` job, probe | The job can only truly run after merge; on the PR it shows as skipped |
| 3. Setup, docs, first release | Secrets, docs, merge, production and device verification | First release ships S-03 to S-05 together; secrets must exist before merge |

**Prerequisites:** Cloudflare account access to create a Workers token. GitHub repo admin access to add secrets. All migrations already pushed (true as of S-04).

**Estimated effort:** about 1–2 sessions across 3 phases.

## Open Risks & Assumptions

- Smoke runs keep creating `smoke-*` accounts in the production database. This is accepted and documented with the existing cleanup queries.
- `sharp` is used as a transitive dependency of `astro`. If lint or resolution complains, it gets pinned as a devDependency.
- iOS standalone apps have their own cookie jar, so users sign in once more inside the installed app.
- If an older Chromium target refuses install without a service worker, that is a follow-up, not this change.

## Success Criteria (Summary)

- Merging a PR to `main` puts it on production with no manual step, and PRs never deploy.
- The app installs from Chrome/Edge desktop, Android Chrome and iOS Safari with a proper icon and name, and opens standalone on the dashboard.
- `/plan`, `/plan/day` and `/recipes` work on production.
