<!-- PLAN-REVIEW-REPORT -->
# Plan Review: F-03 Deploy and Install Skeleton Implementation Plan

- **Plan**: context/changes/deploy-and-install-skeleton/plan.md
- **Mode**: Deep (codebase claims verified inline; no sub-agent)
- **Date**: 2026-10-11
- **Verdict**: REVISE
- **Findings**: 1 critical, 3 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | FAIL |

## Grounding

Grounding: 6/6 paths ✓ (`.github/workflows/ci.yml`, `astro.config.mjs`, `src/layouts/Layout.astro`, `scripts/smoke.mjs`, `README.md:146,190`, `CLAUDE.md:59`; `public/icons/` and `public/manifest.webmanifest` correctly absent), 5/6 symbols ✓ (`SessionSchema = z.union([z.literal(false), …])` at `node_modules/astro/dist/core/session/config.js:29` ✓; `usesCloudflareKVSessionDriver(false) → false` and the `session !== false` guard in `@astrojs/cloudflare/dist/index.js` ✓; id-less `SESSION` in both top-level and `previews` of `dist/server/wrangler.json` ✓; `sharp@0.35.4` ✓ (an **optional** dependency of `astro`); no `Astro.session` use in `src/` ✓; ✗ `src/components/Welcome.astro:23` still renders "10x Astro Starter" — see F1), brief↔plan ✓, Progress↔Phase ✓ (3/3 phases, 8+6+8 rows match the Success Criteria bullets), `npx prettier --check README.md CLAUDE.md` passes today ✓. No `context/foundation/lessons.md` and no `docs/reference/contract-surfaces.md`, so those checks were skipped.

The plan is otherwise well grounded: the `session: false` claim, the build-then-deploy-in-one-job constraint, the static-asset bypass of the middleware and the PR guard all check out against the code.

## Findings

### F1 — Smoke assertion on `/` will always fail: Welcome hero says "10x Astro Starter"

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §4 Smoke test assertions (last bullet); Success Criteria 1.5 / 1.6
- **Detail**: Phase 1 §4 requires `GET /` to have `<title>` "Duo Kitchen" **and not contain "10x Astro Starter"**. `/` is `src/pages/index.astro`, which renders `<Welcome />`, and `src/components/Welcome.astro:23` has the `<h1>` text `10x Astro Starter`. Phase 1 only changes the layout's default title, so the body still contains the string and the new smoke block fails locally (1.5) and in CI (1.6) — blocking Phase 1 and therefore the deploy gate. ("What We're NOT Doing" excludes README/title rework but says nothing about `Welcome.astro`, so the implementer has no guidance.)
- **Fix A ⭐ Recommended**: Narrow the assertion to the document title only — `GET /` matches `<title>Duo Kitchen</title>` (and, if wanted, the `<title>` element does not contain "10x Astro Starter") — and leave `Welcome.astro` untouched. This tests exactly what the install label depends on and keeps scope.
- **Fix B**: Keep the whole-body assertion and add `src/components/Welcome.astro` to Phase 1 §3, replacing the hero `<h1>` text with "Duo Kitchen" (and update "What We're NOT Doing" to say the rest of the starter welcome page is untouched).
- **Decision**: FIXED — Fix A: Phase 1 §4 assertion narrowed to the `<title>` element; `Welcome.astro` left untouched and named in What We're NOT Doing; Testing Strategy wording aligned.

### F2 — Concurrency group does not keep deploys in commit order; an older run can overwrite a newer release

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 2 §2 Deploy job (`concurrency`), Assumption A6, Desired End State ("Two quick merges deploy in order")
- **Detail**: The `deploy` job enters `concurrency: deploy-production` only after its own run's `ci` and `smoke` finish. Each push gets its own workflow run, and `smoke` duration varies (hosted Supabase tests, preview start-up, network). If merge A's smoke is slower than merge B's, B deploys first and A deploys afterwards, putting **older** code on production while `main` is at B. `cancel-in-progress: false` only serialises jobs; it does not order them by commit. The plan's claim "two quick merges deploy in order" is therefore not guaranteed, and nothing detects the regression (the probe in Phase 2 §3 passes for either commit).
- **Fix A ⭐ Recommended**: Add a step to `deploy`, before `npx wrangler deploy`, that skips the deploy when this run's commit is no longer the tip of `main` — e.g. `head=$(git ls-remote origin refs/heads/main | cut -f1); if [ "$head" != "$GITHUB_SHA" ]; then echo "main moved to $head; newer run will deploy"; exit 0; fi` (then gate the deploy/probe steps on an output, or put the check and deploy in one `run:`). Document it in the CI section of README/CLAUDE.md.
  - Strength: Production always converges on the newest green `main`; the existing jobs, triggers and concurrency stay exactly as planned.
  - Tradeoff: If the newest commit's `smoke` fails, the older green commit is not deployed either — production stays on the last deployed version until `main` is green again (arguably the right behaviour).
  - Confidence: HIGH — `git ls-remote` needs no extra checkout depth or token beyond the default `GITHUB_TOKEN`.
  - Blind spot: A `workflow_dispatch` run on `main` checks out the tip at dispatch time, so it passes the check unless `main` moves mid-run, which is correct.
- **Fix B**: Add a workflow-level `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: ${{ github.event_name == 'push' }} }` so a newer push to `main` cancels the older run entirely (ci, smoke and deploy).
  - Strength: One YAML block, no shell logic; also saves CI minutes and smoke accounts on superseded commits.
  - Tradeoff: A cancel that lands mid-`wrangler deploy` can leave the older run's upload half-way (Cloudflare versions are atomic, so the risk is a failed run, not a broken worker); intermediate commits on `main` are never fully tested.
  - Confidence: MED — cancellation timing relative to the deploy step is not controllable.
  - Blind spot: Interaction with the job-level `deploy-production` group would need to be re-checked.
- **Decision**: FIXED — Fix A: the deploy step checks the `git ls-remote` tip of `main` before `wrangler deploy` and sets a `deployed` output that gates the probe; Desired End State, A6 and the README/CLAUDE.md CI contracts updated.

### F3 — Post-deploy probe cannot detect missing worker secrets or a stale version

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 §3 Post-deploy probe; Critical Implementation Details (worker secrets)
- **Detail**: The probe checks `/` 200, the manifest body and `/recipes` 302. If `SUPABASE_URL` / `SUPABASE_KEY` are missing on the worker, `createClient()` returns null, the middleware sets `user = null` and `/recipes` **still** 302s, while every page shows the "Supabase nie jest skonfigurowany" banner (`src/lib/config-status.ts:15`) and auth is dead — the probe passes. The plan names missing secrets as the one thing a deploy cannot fix, yet only covers it by a manual dashboard check. Separately, after the first release the `/recipes` 302 no longer distinguishes the new version from the previous one, so the probe is a liveness check only.
- **Fix**: Add to the probe: `GET $PRODUCTION_URL/auth/signin` returns 200 and its body does **not** contain `Supabase nie jest skonfigurowany`. Run the deploy as `npx wrangler deploy --message "$GITHUB_SHA"` so each Cloudflare version is traceable to its commit for `wrangler rollback`, and state in the plan that `wrangler deploy`'s exit code is the authoritative "new version is live" signal while the probe proves the release is healthy.
- **Decision**: FIXED — Fix: probe adds `/auth/signin` 200 without the config banner; deploy runs `wrangler deploy --message "$GITHUB_SHA"`; plan states the exit code is the live signal and the probe a health check.

### F4 — Token template contradicts the "deploy-only token" rationale

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 3 §1 One-time manual setup; Assumptions A3, A4
- **Detail**: A3 says "the Cloudflare token only needs to deploy scripts", and A4 disables Astro sessions precisely to avoid a KV-capable token. Phase 3 §1 then says to create the token from the **"Edit Cloudflare Workers"** template, which also grants Workers KV Storage, R2, Workers Routes and other edit permissions — the wider blast radius both assumptions were avoiding, stored as a GitHub secret.
- **Fix**: Replace the template instruction with a **custom token**: Account → Workers Scripts: Edit, scoped to the one account (no zone resources), and note "if `wrangler deploy` fails with an authentication error naming another permission, add only that permission". Keep `CLOUDFLARE_ACCOUNT_ID` set so wrangler needs no user/membership read.
- **Decision**: FIXED — Fix: Phase 3 §1 now specifies a custom Account → Workers Scripts: Edit token (no template), the add-only-the-named-permission note and the kept account ID; README setup line updated.

### F5 — Icon text rendering depends on the local machine's fonts

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1 Icon source and generator; Assumption A9
- **Detail**: The mark is "DK" text in an SVG rendered by `sharp` (librsvg). SVG `<text>` is rasterised with whatever fonts fontconfig finds on the machine that runs the script, so the committed PNGs depend on the developer's OS (this repo is developed on Windows) and are not reproducible elsewhere; a missing family can also fall back to an unexpected face. `sharp` is also an **optional** dependency of `astro` (`node_modules/astro/package.json` `optionalDependencies`), so its presence is not guaranteed on every install — the plan's devDependency fallback covers this.
- **Fix**: Draw the "DK" mark in `public/icons/icon.svg` as `<path>` outlines (or simple geometric shapes) rather than `<text>`, so every regeneration produces identical PNGs; keep the devDependency fallback for `sharp` as written.
- **Decision**: FIXED — Fix: Phase 1 §1 and A9 require the DK mark as SVG path outlines, not `<text>`; `sharp` noted as an optional dependency, devDependency fallback kept.

### F6 — `workflow_dispatch` re-runs the full smoke suite against production

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 §2 (`workflow_dispatch:`), Phase 3 §2 README "Re-deploy with Actions → CI → Run workflow"
- **Detail**: The plan intends `workflow_dispatch` to re-run `ci` and `smoke` as the gate, which is sound, but every manual re-deploy (and every dispatch on a non-`main` branch, which runs both jobs and then skips `deploy`) creates two more `smoke-*` accounts and a shared household in the production database (A1). For a pure "re-deploy the same commit" this is a side effect the README should mention, and `wrangler rollback` / the dashboard is the cheaper path for reverting.
- **Fix**: In the README "Deployment" text (Phase 3 §2), add one sentence: "Run workflow re-runs the full CI and smoke suite, which adds two `smoke-*` accounts to the production project; use the cleanup queries below afterwards." No workflow change.
- **Decision**: FIXED — Fix: Phase 3 §2 README Deployment contract adds the Run-workflow smoke-accounts sentence and names rollback as the cheaper revert path.
