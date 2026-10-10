<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Deploy and Install Skeleton (F-03)

- **Plan**: context/changes/deploy-and-install-skeleton/plan.md
- **Scope**: Full plan — Phases 1–2 of 2 (commits d15594c, fb389dc)
- **Date**: 2026-10-10
- **Verdict**: PASS WITH PENDING MANUAL CHECKS
- **Findings**: 0 critical, 0 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS (automated); manual pending |

### Success criteria evidence (re-run during this review)

| Command | Result |
|---|---|
| `npm run lint` | PASS (after `astro check` generated types, as CI's `astro sync` does) |
| `npx astro check` | PASS — 0 errors, 0 warnings, 0 hints |
| `npm test` | PASS — 51/51 |
| `npm run build` | PASS — manifest and icons in `dist/client` |
| smoke F-03 steps vs `npm run preview` | PASS — 7/7 anonymous steps (home links, manifest criteria, 4 icons as `image/png`); manifest served as `application/manifest+json` |
| non-vacuity | Setting `display` to `browser` in the built manifest fails the step with `check failed: display is "browser"` |
| `python3 … yaml.safe_load(ci.yml)` | PASS — `deploy` needs `[ci, smoke]`, main-push `if`, `cancel-in-progress: false` |
| `node scripts/check-migrations.mjs --dry-run` | PASS — 9 versions for 9 files |
| `node scripts/check-migrations.mjs` (unlinked) | Fails closed (exit 1, "Cannot find project ref") |

The steps after sign-up in `npm run smoke`, `npm run test:rls` and a real `check:migrations` run need the
hosted project's credentials, which this environment lacks; CI runs all three.

## Findings

### O1 — OBSERVATION: the migration gate is unverified against the hosted project

The SQL is a plain `do` block of the kind `test:rls` already runs through `supabase db query --linked`,
and it fails closed when not linked, but the success path ("All 9 migrations are applied") has not
been observed. Covered by Progress 2.5 and by the first `main` deploy.
- Decision: ACCEPTED — manual check 2.5.

### O2 — OBSERVATION: `main` stays red until the Cloudflare secrets exist

By design (plan-review F2, Fix A): the preflight names the missing secret. The owner must add
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` before or right after merging.
- Decision: ACCEPTED — manual check 2.4, documented in README §Deployment.

### O3 — OBSERVATION: the favicon changed

`public/favicon.png` was the starter's mark; it is now the Duo Kitchen mark, the same as the
install icons. The plan said to do this, so it is in scope; noted because it is a visible change on every tab.
- Decision: ACCEPTED.
