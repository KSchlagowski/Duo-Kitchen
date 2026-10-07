<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Household-Scoped Data Access

- **Plan**: context/changes/household-data-scope/plan.md
- **Scope**: All phases (1–3 of 3)
- **Date**: 2026-10-07
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Verification evidence

- `npm run lint`: pass (exit 0)
- `npx astro check`: 0 errors, 0 warnings, 0 hints
- `npm run build`: complete
- `npm run test:rls`: "household_isolation: all assertions passed"
- Residue check (`auth.users` with `@rls-test.local`): 0
- `npx supabase db advisors --linked`: only `auth_leaked_password_protection` (Auth setting, not related to these tables/functions)
- `npm run smoke`: not run locally (it signs up an account in the hosted project). CI run 37627017195 on `c50268c`: `ci` success, `smoke` success

## Triage

Fixed: F1, F2 (Fix A), F3, F4, F5, F6 (6). Post-fix: `npm run lint` exit 0, `npx astro check` 0 errors, `npm run test:rls` passes.

## Findings

### F1 — Claude allowlist permits any SQL against the hosted DB

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: .claude/settings.json:3
- **Detail**: `Bash(npx supabase db query --linked:*)` auto-approves any SQL, including `drop`/`delete`/`update`, against the only Supabase project. That project also backs the live app (https://duo-kitchen.mediewilnp.workers.dev). The plan only needed `npm run test:rls` and the read-only residue check.
- **Fix**: Narrow the allowlist to `Bash(npm run test:rls)` and `Bash(npx supabase db query --linked -f supabase/tests/household_isolation.sql)`. Any other ad-hoc SQL then asks first.
  - Strength: Destructive SQL against production always needs a human click, and the routine test still runs without a prompt.
  - Tradeoff: Ad-hoc read-only queries prompt each time.
  - Confidence: HIGH: committed settings apply to every session in this repo.
  - Blind spot: User-level settings may hold broader allows too.
- **Decision**: FIXED — allowlist narrowed to `npm run test:rls` and the exact isolation-test command

### F2 — CI tests the deployed schema, not the branch's migrations

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: .github/workflows/ci.yml:38
- **Detail**: The smoke job runs `npm run test:rls` against whatever is already pushed to the hosted project. It never applies the PR's `supabase/migrations/*`. A later migration that breaks household privacy, or a new table with no policies, therefore passes CI until someone runs `db push` by hand. After that the breakage is already live. The plan states the CI step's intent as "so a later migration can't silently break household privacy". The cloud-only rule (no local stack, no branching DB) makes this a structural gap, not a bug in this change.
- **Fix A ⭐ Recommended**: Document the gap and the workflow. In CLAUDE.md, require running `npx supabase db push` and then `npm run test:rls` before merging any migration. The isolation test should also gain a catch-all check: every `public` table with a `household_id` column must have RLS enabled and policies for every operation.
  - Strength: No new infrastructure or cost. The catch-all check covers the most likely regression, a new table without policies.
  - Tradeoff: Still depends on discipline, and a migration is applied to production before it is tested.
  - Confidence: MED: it keeps today's cloud-only setup but does not truly gate merges.
  - Blind spot: Haven't checked whether Supabase Branching is on the project's plan.
- **Fix B**: Add a separate hosted Supabase "CI" project. In the smoke job, `db push` the branch's migrations to it, then run `test:rls` and smoke against it.
  - Strength: A real pre-merge gate that keeps the production DB out of CI.
  - Tradeoff: A second project to maintain (free-tier pausing, more secrets), plus migration drift between the two projects.
  - Confidence: MED: this is the standard pattern, but it adds operational load to a two-person app.
  - Blind spot: Free-tier project limits and pause behaviour.
- **Decision**: FIXED via Fix A — CLAUDE.md "db push, then test:rls before merging a migration"; catch-all assertion added to the isolation test (verified: passes on current schema, fails with "catch-all: public.rls_catchall_probe has no SELECT policy for authenticated" on an unprotected probe table, rolled back)

### F3 — Supabase access token exposed to every smoke-job step

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: .github/workflows/ci.yml:29-30
- **Detail**: `SUPABASE_ACCESS_TOKEN` is a personal access token with account-wide Management API rights. It is set at job level, so `npm ci` lifecycle scripts, the build and the preview server can all read it. Only the link step and the `test:rls` step need it.
- **Fix**: Move the `env: SUPABASE_ACCESS_TOKEN` block from the job down to the two steps that need it: "Link hosted Supabase project" and "Run household isolation test".
- **Decision**: FIXED — SUPABASE_ACCESS_TOKEN scoped to the link and test:rls steps

### F4 — Dashboard swallows household errors without logging

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/dashboard.astro:13-15
- **Detail**: The planned neutral fallback is in place, but the empty `catch {}` discards the error. A broken RLS policy or query in production would show "Household information is unavailable right now." and nothing in the Worker logs (observability is enabled). The smoke test also stays green, because it only asserts a 200.
- **Fix**: `catch (error) { console.error("getCurrentHousehold failed", error); }`
- **Decision**: FIXED — console.error with a targeted no-console disable

### F5 — wrangler.jsonc reformatted outside Prettier style (unplanned edit)

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: wrangler.jsonc
- **Detail**: Pre-plan commit f57db93 renamed the worker to `duo-kitchen` and also reformatted the file with tabs and no trailing newline. `npx prettier --check wrangler.jsonc` now fails, and the change is not in the plan. The other unplanned edits (`.gitattributes`, the `.claude/` ESLint ignore, the README live URL) are benign tooling and docs changes.
- **Fix**: `npx prettier --write wrangler.jsonc` (keeps the rename, restores the formatting).
- **Decision**: FIXED — npx prettier --write wrangler.jsonc

### F6 — Progress 2.5 ticked while CI was red

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/household-data-scope/plan.md (Progress 2.5)
- **Detail**: Item 2.5 ("CI smoke job shows the new step passing") is marked with `f76ce70`. But every CI run up to `be1fa4f` failed, and the first green smoke job was `4ce8b72` on 2026-10-07, after the repository secrets were configured. The criterion is met now; only the evidence SHA is wrong.
- **Fix**: Change the 2.5 annotation to `— 4ce8b72`.
- **Decision**: FIXED — Progress 2.5 annotation changed to 4ce8b72
