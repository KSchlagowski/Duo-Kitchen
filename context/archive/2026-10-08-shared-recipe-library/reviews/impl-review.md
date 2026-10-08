<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: F-04 Shared Recipe Library

- **Plan**: context/changes/shared-recipe-library/plan.md
- **Scope**: Full plan (Phases 1–3 of 3), commits c7937bb..45da339
- **Date**: 2026-10-08
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 7 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Success criteria re-run by the reviewer on 2026-10-08:
- `db push --dry-run`: up to date.
- `npm run test:rls`: all assertions passed.
- `npm run test:seed`: all assertions passed.
- Live counts: 46 products, 8 recipes.
- `npm run lint`: 0 problems.
- `astro check`: 0 errors.
- `npm run build`: OK.
- `npm run smoke` against `npm run preview`: all steps passed.

Manual items 1.6, 1.7 and 1.8 have evidence in the plan's implementation notes. Items 2.5 and 2.6 were done over HTTP rather than in a browser, and manual testing step 3 (the PATCH from a browser console) was not done; both are disclosed in the plan. Plan drift check: no behavioural drift; the `redeem_household_invite` body is identical apart from the planned removals.

## Findings

### F1 — `authenticated` still holds PG17 `MAINTAIN` on library tables

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261008150000_shared_recipe_library.sql:421-449, supabase/tests/household_isolation.sql:762
- **Detail**: On PG17, Supabase's default "grant all" includes `MAINTAIN`. The revoke list (`insert, update, delete, truncate, references, trigger`) leaves it in place, and the hosted DB confirms `has_table_privilege('authenticated', 'public.<lib>', 'MAINTAIN')` is true for all five tables. That allows VACUUM/ANALYZE/REINDEX/CLUSTER/REFRESH/LOCK TABLE. PostgREST can't reach it, but it contradicts "client-read-only", and the grants assertion doesn't check it.
- **Fix**: Add a forward migration that runs `revoke maintain` on the five library tables from `authenticated`, and add `MAINTAIN` to both privilege arrays in the isolation test's grants block.
- **Decision**: FIXED — new migration 20261008160000_library_revoke_maintain.sql (applied with db push); MAINTAIN added to both grants arrays in household_isolation.sql.

### F2 — Plan-unlisted doc rewordings and extras

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: README.md:190, CLAUDE.md:40
- **Detail**: The plan said the README "spare redemption origins" warning stays unchanged, but its last sentence was reworded: the cascade now names household data instead of products/recipes. That is more accurate after F-04. CLAUDE.md gained a new "Ownership classes" bullet. Stricter test/guard additions are benign too: guard check (c) for partial copies, the extra classification checks, and the extra seed-shape checks.
- **Fix**: Record these in the plan's Progress implementation notes as an addendum, so the plan stays the source of truth.
- **Decision**: FIXED — recorded as an implementation-review addendum at the end of plan.md Progress.

### F3 — Grants assertion misses column-level privileges

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/tests/household_isolation.sql:762
- **Detail**: `has_table_privilege` sees table-level grants only, so a `grant update (name) on public.products to authenticated` would pass the "second lever" assertion. CLAUDE.md now recommends column-level `grant insert (<cols>)` for S-07, which makes this the likely shape of a future regression.
- **Fix**: In the same loop, also assert `not has_any_column_privilege('authenticated', 'public.<lib>', p)` for INSERT, UPDATE and REFERENCES.
- **Decision**: FIXED — has_any_column_privilege assertions for INSERT/UPDATE/REFERENCES added to the grants loop.

### F4 — Household policy catch-all skips partitioned tables

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/tests/household_isolation.sql:636
- **Detail**: The new classification catch-all accepts `relkind in ('r','p')` with `household_id` as household-scoped. The policy catch-all only iterates `relkind = 'r'`, so a partitioned household table would be classified and then skip every policy check.
- **Fix**: Change `c.relkind = 'r'` to `c.relkind in ('r', 'p')` at :636.
- **Decision**: FIXED — policy catch-all now iterates relkind in ('r', 'p').

### F5 — View check rejects `security_invoker = on`

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/tests/household_isolation.sql:704
- **Detail**: The check matches the literal `'security_invoker=true'`, but reloptions keep the spelling used at creation (`on`, `1`, `yes`). A correctly invoker-secured view would fail CI. This fails safe, but it is a false positive.
- **Fix**: Match the option case-insensitively against `^security_invoker=(true|on|yes|1)$`.
- **Decision**: FIXED — view check matches ^security_invoker=(true|on|yes|1)$ case-insensitively.

### F6 — Seed-integrity test lost its row-count tripwire

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/tests/seed_integrity.sql:326-332
- **Detail**: Copy fidelity used to pin household copies to template counts. Now only "non-empty" and "5–10 recipes" remain, so a seed migration that accidentally deletes some seed products, components or steps passes as long as the rest stays consistent.
- **Fix**: Pin the exact seed counts (46 products, 8 recipes, 14 components, 69 ingredients, 33 steps) in check (b), with a note that a deliberate seed content migration updates them.
- **Decision**: FIXED — check (b) pins exact seed counts per table; CLAUDE.md test:seed note says seed migrations update them.

### F7 — Comment inaccuracies in the isolation test

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: supabase/tests/household_isolation.sql:153, :1158-1161
- **Detail**: The FK-probe comment says `on delete restrict` "raises restrict_violation"; core Postgres reports 23503 `foreign_key_violation`, though the handler accepts both. The rejection-block comment has a broken mid-sentence line wrap left from an edit.
- **Fix**: Reword the comment to "raises foreign_key_violation" and rewrap the paragraph.
- **Decision**: FIXED — FK-probe comment says foreign_key_violation; rejection-block paragraph rewrapped.

### F8 — Guard ran without locking the guarded tables

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20261008150000_shared_recipe_library.sql:39-135 vs :289
- **Detail**: The guard reads under ACCESS SHARE, and the drop takes ACCESS EXCLUSIVE later. Under READ COMMITTED, a client write committed in between would pass the guard and then be dropped. The migration has already been applied, the guard passed, and the window was milliseconds, so nothing to fix in code.
- **Fix**: Accept for this migration (already applied; editing it would not change the hosted DB). Future guarded destructive migrations should `lock table … in share row exclusive mode` before the check.
- **Decision**: ACCEPTED — migration already applied and its guard passed; editing it would not change the hosted DB. Future guarded destructive migrations should lock the guarded tables before checking.
