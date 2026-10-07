<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Seed Products and Recipes

- **Plan**: context/changes/seed-products-and-recipes/plan.md
- **Scope**: Phases 1–3 of 3 (commits 7edd598, 374ec05, 6e0504e, 01fc52c)
- **Date**: 2026-10-07
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | WARNING |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | WARNING |

## Summary of evidence

- **Plan drift**: every planned file exists and matches the plan's intent. The two schema deviations are recorded in the plan's Implementation Notes: `restrict_violation` is caught alongside `foreign_key_violation`, and the indexes cover the full composite FKs. This review agrees with both. The integrity test also checks that copied steps keep their component. That check was not in the plan, but it is benign and in scope.
- **Safety**:
  - All five `public` tables have RLS, four `to authenticated` policies through `private.user_household_ids()`, no anon access, and `truncate/references/trigger` revoked.
  - `private.seed_household()` and the replaced `handle_new_user()` follow definer discipline: `security definer`, `search_path = ''`, fully qualified names, and `revoke execute`.
  - The template tables are revoked from `public, anon, authenticated`.
  - Composite FKs make cross-household references impossible.
  - No injection surface: the dynamic SQL in the tests uses `format('%I')` over fixed table lists.
- **Seed content**: base amounts, piece multiples, half-piece flags and Atwater values were spot-checked by hand. They match the integrity rules (for example, eggs 200 g = 4 × 50 g with a minimum of 1 egg, bread 140 g = 4 × 35 g with halves allowed, and chicken 98 kcal vs 97.7 kcal by formula).
- **Automated checks run in this review**:
  - `npm run lint`: pass.
  - `npx astro sync && npx astro check`: 0 errors, 0 warnings.
  - `npm run build`: pass.
  - `node --check scripts/smoke.mjs`: pass.
- **Manual rows** (1.7, 1.8, 2.8, 2.9, 3.5, 3.6) are all still `[ ]`, and correctly so, because none could be observed without the hosted project. No row is rubber-stamped. Rows 1.4 and 2.3 are `[x]` on the strength of PGlite runs, which the Implementation Notes record.

## Findings

### F1 — Hosted verification still pending

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/seed-products-and-recipes/plan.md (Progress 1.1–1.3, 1.5, 2.1, 2.2, 2.4–2.6, 3.4)
- **Detail**: Eleven automated rows depend on the hosted Supabase project and are still `[ ]`: `db push`, advisors/`db lint`, `test:rls`, `test:seed`, the backfill query and `smoke`. The SQL was proven only against PGlite. CI runs `test:rls`/`test:seed` against the already-deployed schema, so merging before `db push` turns the smoke job red. The plan's Implementation Notes already list the run order.
- **Fix**: Run `npx supabase link` → `npx supabase db push` → `npm run test:rls` → `npm run test:seed` → backfill query → `npm run build && npm run preview` + `npm run smoke` before merging, then tick the rows and set `change.md` to `implemented`.
- **Decision**: DEFERRED — needs hosted Supabase credentials, which this environment does not have.

### F2 — test:seed allowlist entry missing

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: .claude/settings.json:3-6
- **Detail**: Phase 2 §3 plans an allowlist entry for `npm run test:seed` that mirrors the `test:rls` entries. The file still lists only the two `test:rls` entries. The Implementation Notes record this as not done because write permission was denied.
- **Fix**: Add `"Bash(npm run test:seed)"` and `"Bash(npx supabase db query --linked -f supabase/tests/seed_integrity.sql)"` to `permissions.allow`.
- **Decision**: DEFERRED — this review session was again denied write permission to `.claude/settings.json`, so the user must add the two entries by hand.

### F3 — Smoke cleanup query leaves seeded orphan households

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: README.md:173 (CI section); plan.md Performance Considerations
- **Detail**: Before this change, an orphaned smoke household was one empty row. Now every CI run leaves about 170 seeded rows behind, and the documented cleanup (`delete from auth.users …`) removes only accounts and memberships. Data grows without bound, and the docs offer no way to reclaim it.
- **Fix**: Document a follow-up statement, `delete from public.households h where not exists (select 1 from public.household_members m where m.household_id = h.id)`, which cascades through all five tables (the cascade itself is proven by `seed_integrity.sql`'s copy-fidelity block).
- **Decision**: FIXED — README CI section and plan Performance Considerations updated. Blind spot: once S-01 can leave a household temporarily memberless, revisit the query.
