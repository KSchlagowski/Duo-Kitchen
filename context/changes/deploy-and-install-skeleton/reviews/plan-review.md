<!-- PLAN-REVIEW-REPORT -->
# Plan Review: deploy-and-install-skeleton

- **Plan**: `context/changes/deploy-and-install-skeleton/plan.md`
- **Research**: `context/changes/deploy-and-install-skeleton/research.md`
- **Date**: 2026-10-10
- **Verdict**: SOUND WITH FIXES — scope matches the roadmap (auto-deploy + manifest, no offline); four
  findings, none structural.

## Findings

### F1 — WARNING: `black-translucent` status bar hides the top of every page on iOS

In an iOS standalone web app, `apple-mobile-web-app-status-bar-style: black-translucent` lets the
page draw under the status bar / notch. No page pads for `env(safe-area-inset-top)`, so the Topbar
and page headings would sit under the clock.

- **Fix**: use `black` (opaque bar, page starts below it). No safe-area CSS needed.
- Decision: FIXED — status bar style is `black` in Phase 1 §3.

### F2 — WARNING: a missing Cloudflare secret fails the deploy with an obscure wrangler error

Until the owner adds `CLOUDFLARE_API_TOKEN`, every push to `main` runs `wrangler deploy`, which fails
with a non-interactive-auth error that does not say which repository secret is missing.

- **Fix A (Recommended)**: a first deploy step that fails with
  `::error::` naming the missing secret(s) when `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` is
  empty, and the README lists both. Main stays honestly red until set up.
- **Fix B**: skip the deploy silently when the secret is absent. Rejected-leaning: a green `main`
  that did not deploy hides the gap this change exists to close.
- Decision: FIXED — Fix A: preflight step naming missing Cloudflare secrets added to Phase 2 §2.

### F3 — WARNING: the post-deploy probe cannot tell the new version from the old one

`curl /` and `/manifest.webmanifest` succeed against the previous deployment too (after the first
deploy of this change), so the probe proves liveness, not that this commit is live. Overclaiming it
in the plan invites trusting it as a version check.

- **Fix**: keep the probe but describe it as a liveness check in the plan and README; the authority
  for "this commit deployed" is `wrangler deploy`'s exit status (it fails on any upload or
  activation error). No version marker (would need a build-time public env field — not worth it here).
- Decision: FIXED — probe described as liveness only; `wrangler deploy` exit status named as the authority (Phase 2 §2).

### F4 — OBSERVATION: Phase 2 YAML check names no concrete tool

"Workflow YAML parses (e.g. … `yaml-lint`-equivalent)" is not runnable as written; the repo has no
YAML parser dependency.

- **Fix**: verify with `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"`
  (PyYAML in the dev container) and check the `deploy` job keys (`needs`, `if`, `concurrency`) in the
  parsed result.
- Decision: FIXED — concrete PyYAML check in Phase 2 success criteria and Progress 2.2.
