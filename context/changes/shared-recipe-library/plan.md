# F-04 Shared Recipe Library Implementation Plan

## Overview

Turn the five household-copied library tables (`products`, `recipes`, `recipe_components`, `recipe_ingredients`, `recipe_steps`) into **one public library shared by every authenticated user**. No row is owned by a household. The plan retires the per-household seed copying (`private.seed_household()`, the `private.seed_*` templates, the seeding branch of the sign-up trigger) and the KD006 redemption guard that only existed to protect household-owned library rows. It then rewrites the isolation, seed-integrity and smoke tests and the docs. This unblocks S-03, S-05, S-06 and S-07, which must reference a library row that never moves with a household.

Grounding research: `context/changes/shared-recipe-library/research.md`. The session was non-interactive. Every decision below is the research's recommended option, and any assumption is stated inline and collected in [Assumptions](#assumptions).

## Current State Analysis

- All five tables carry `household_id uuid not null`, `seed_id uuid`, `unique (household_id, seed_id)`, `unique (id, household_id)`, and child → parent composite FKs that include `household_id` (`supabase/migrations/20261007120000_products_and_recipes.sql:33-142`).
- RLS gives `authenticated` full per-operation household policies (`:148-239`). Only `truncate/references/trigger` are revoked, so **a client can already insert, edit and delete its household's library rows through PostgREST**. Carrying those policies into a shared table would let any user vandalise every couple's library, so F-04 has to close them.
- `private.seed_*` templates (`:246-310`) are already in the final public shape: plain FKs, `unique (id, recipe_id)` on components, `unique (name)` on products, stable `5eed000N-…` ids (`20261007120100_seed_products_and_recipes.sql:13-14`).
- `private.handle_new_user()` was redefined to call `private.seed_household()` (`20261007120000_products_and_recipes.sql:373-394`). The F-01 body without the seed call is at `20261006120000_household_data_scope.sql:88-107`.
- `public.redeem_household_invite()` holds the KD006 guard, which counts `seed_id is null` rows **by `household_id`** across the five tables (`20261007120200_household_invites.sql:261-282`). KD006 is documented at `:93`, `:236-238` (inside the KD008 comment) and `:315`. Both columns the guard reads disappear.
- Live data (read-only queries, 2026-10-08, research §2): 34 households, 1,564 product rows = 34 × 46, **zero non-seed rows, zero seed copies that differ from their template**. No view, FK or function outside `seed_household`/`redeem_household_invite` depends on the tables. Nothing has to be preserved.
- App code only **counts** the library (`src/lib/services/recipes.ts:4-22` → dashboard `Library:` line, `src/pages/dashboard.astro:51-53, 91-92`). `src/lib/services/invites.ts:16` maps KD006 to a user message.
- Tests: `supabase/tests/household_isolation.sql` asserts trigger seeding (`:57-85`), per-household library fixtures (`:87-119`), an id-indexed read loop where `household_invites` must stay element 6 (`:256-288`), household write isolation and the composite-FK probe (`:290-349`), template denial (`:413-432`), post-redemption seed counts and a `prosrc` check (`:841-862`), C/D identical counts (`:874-945`), and the KD006 rejection case (`:1160-1163`). `supabase/tests/seed_integrity.sql` reads `private.seed_*` everywhere and ends with "copy fidelity" through `seed_household()` (`:287-340`).

## Desired End State

- `public.products`, `public.recipes`, `public.recipe_components`, `public.recipe_ingredients` and `public.recipe_steps` have **no** `household_id` or `seed_id`. Each holds exactly one canonical set of rows, and the seed rows keep their stable `5eed000N-…` ids as primary keys.
- Every `authenticated` user sees the whole library through one `select … using (true)` policy per table. No client role can insert, update, delete or truncate it, and `anon` cannot read it.
- Signing up creates a household and a membership only. No library rows are created.
- `private.seed_household()` and the five `private.seed_*` tables no longer exist.
- `public.redeem_household_invite()` has no KD006 guard. KD006 is documented as retired and never reused, and the UI mapping no longer contains it.
- `npm run test:rls` passes with a library visibility block, a library write-denial block, grant assertions, a "seed mechanism gone" block and a **classification catch-all**: every `public` table is household-scoped, `households`, or a declared library table.
- `npm run test:seed` passes against the seed rows of the public tables.
- `npm run smoke` passes and additionally proves that two **unlinked** accounts see the same `Library:` line.
- CLAUDE.md, README and roadmap describe the implemented public library and the deferred authorship rule.

**Verify** with `npx supabase db push`, `npm run test:rls`, `npm run test:seed`, `npm run lint`, `npx astro check`, `npm run build` and `npm run smoke` (dev server or preview), plus a manual dashboard check with two fresh accounts.

### Key Discoveries:

- The final public DDL can mirror `private.seed_*` almost line for line (`20261007120000_products_and_recipes.sql:246-301`) plus `created_at` and the comments.
- `recipe_steps (component_id, recipe_id) → recipe_components (id, recipe_id) on delete set null (component_id)` needs `unique (id, recipe_id)` on components. This is the PG15+ column-list form, and the hosted project runs PG 17.11.
- Supabase default privileges grant everything on a **newly created** `public` table to `anon` and `authenticated`. Because the tables are recreated, the revokes are load-bearing and have to be asserted with `has_table_privilege`.
- The isolation read loop builds fixture ids from its loop index (`household_isolation.sql:264-285`). If the five library names are deleted without restructuring, `household_invites` silently becomes index 1 (`…a001`) and the test fails confusingly.
- The rejection-case block is ordered so the case that would mutate on regression (KD006) runs last (`:986-988`). With KD006 gone, every remaining case raises before any write, and the ordering comment has to be reworded.
- `supabase db query --linked -f` runs the whole test file in one session (the files already rely on `begin … rollback` and transaction-local GUCs). Temp views created inside it therefore persist for the rest of the file and vanish on rollback.

## What We're NOT Doing

- **No client write path to the library.** No insert/update/delete policies or RPCs. S-07 (products) and S-12/S-13 (agent) add their own.
- **No `created_by` column yet.** Assumption (research §7.3, Open Question 1): authorship lands with S-07, the first slice that writes. The rule is recorded now: seed rows (`created_by is null`) stay immutable to people, and user rows are editable by their author and the author's current household partner.
- No UI changes beyond removing the KD006 message. The dashboard `Library:` line is unchanged.
- No recipe browsing (S-05), ratings (S-06) or plan references (S-03). No decision on whether a redeemer's plans should block redemption (S-03 owns it).
- No change to `household_invites`, `macro_targets`, membership tables, or the README cleanup queries' logic.
- No relaxation of `unique (name)` on products. S-07 may revisit it.
- No rollback migration. The change is forward-fix only (see Migration Notes).

## Implementation Approach

One migration **drops and recreates** the five tables in their final shape, after a guard that re-verifies at push time that only unmodified seed copies exist. It fills the new tables from `private.seed_*` while keeping ids, and only then drops the templates and the seeding function. The sign-up trigger is restored to its F-01 body, and the redemption function is re-issued without KD006. Recreate is preferred over `alter … drop column` because it reads as the final shape and avoids dropping generated constraint names. It is safe only because the guard proves there is nothing to lose.

The test rewrites ship **in the same commit as the migration**. CI runs `test:rls`/`test:seed` against the *deployed* schema, so the order inside Phase 1 is: write the migration and both test files, `db push`, run both tests, then commit and push. This keeps the window in which `main`'s CI and the hosted schema disagree to minutes. Phases 2 and 3 are app/smoke and docs, and each is independently green.

## Critical Implementation Details

- **Migration step order is a safety property, not style.** The order is: guard → `handle_new_user` → `redeem_household_invite` → `drop function seed_household` → drop the five public tables → recreate → copy from templates → **drop templates last** → RLS/grants. If `db push` is not transactional per file (assumption, see below) and a step after the drop fails, the templates still exist and the copy can be re-run by a forward-fix migration.
- **Transaction assumption.** It is believed, not verified, that `supabase db push` applies each migration file in one transaction. Before pushing, run `npx supabase db push --dry-run` to confirm that only this file is pending. The step ordering above makes a partial failure recoverable either way.
- **Deploy sequencing.** Do not `db push` until both rewritten test files are ready locally. Push the git commit immediately after `test:rls` and `test:seed` pass (memory: every commit is pushed).

---

## Phase 1: Public library schema, redemption cleanup and DB tests

### Overview

The migration, plus the rewritten isolation and seed-integrity tests. After this phase the hosted schema is F-04 and both SQL test suites prove it.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/20261008150000_shared_recipe_library.sql` (timestamp after `20261008120000_macro_targets.sql`)

**Intent**: Convert the library to one public, client-read-only set of tables, retire per-household seeding and the KD006 guard, and fail loudly instead of destroying data if anything but unmodified seed copies exists.

**Contract** (in this order):

1. **Header comment.** Covers the F-04 rationale (public library, PRD Access Control); "public" means every *authenticated* user, never `anon`; the authorship rule deferred to S-07; the rollback note ("re-running F-02 is not a rollback; forward-fix only"); and the SQLSTATE note "KD006 retired (F-04) — do not reuse".
2. **Guard `do` block** that raises with a descriptive message when either condition holds:
   - (a) any of the five tables has a row with `seed_id is null`;
   - (b) any seed copy differs from its template. Compare every content column for products, recipes, ingredients and steps, as research §2 did; for components compare `position`, `name` and `cooked_yield_ratio`; for references compare by seed identity (copy → parent copy's `seed_id` = template's parent id). Use a **null-safe set difference per table**, never a `join … where c.col <> t.col` (which treats `null <> 5` as not different and skips orphan copies): `(select c.seed_id, <content cols>, <parent copy's seed_id> from public.<t> c left join <parent copies>) except (select id, <content cols>, <parent seed ids> from private.seed_<t>)`, and raise if it returns any row. `EXCEPT` compares with `IS NOT DISTINCT FROM` semantics, so it catches nullable-column edits (`grams_per_piece`, `rounding_step_g`, `min_amount_g`, `cooked_yield_ratio`, `duration_minutes`, step `component_id`) and orphan copies whose `seed_id` matches no template.
3. **`create or replace function private.handle_new_user()`** with the F-01 body (household + membership only, `20261006120000_household_data_scope.sql:88-105`), then `revoke execute … from public, anon, authenticated`.
4. **`create or replace function public.redeem_household_invite(text)`**:
   - The body is identical to `20261007120200_household_invites.sql:179-309` minus `v_non_seed` and the KD006 block (`:261-282`).
   - Rewrite comments that mention KD006 or seeding: the header at `:175-177` should say "the library is public (F-04), so redemption never touches it", the KD008 comment at `:236-238` drops the "KD006 is no substitute" sentence, and the comment at `:192` ("reused for the KD004/KD006 checks") drops KD006. Keep every other check, lock and comment, including the "single `update`" membership-move rule.
   - Re-issue `revoke execute … from public, anon;` and `grant execute … to authenticated;`.
   - Re-issue `comment on function` without KD006.
5. `drop function private.seed_household(uuid);`
6. `drop table public.recipe_steps, public.recipe_ingredients, public.recipe_components, public.recipes, public.products;` This drops their policies and indexes. The enums are untouched.
7. **Recreate the five tables** in the `private.seed_*` shape:
   - `id uuid primary key default gen_random_uuid()`, the same columns and checks, and `created_at timestamptz not null default now()`.
   - `products`: `unique (name)`.
   - `recipe_components`: `recipe_id … references public.recipes on delete cascade`, `unique (recipe_id, position)`, `unique (id, recipe_id)`.
   - `recipe_ingredients`: `component_id … references public.recipe_components on delete cascade`, `product_id … references public.products on delete restrict`, `unique (component_id, position)`.
   - `recipe_steps`: `recipe_id … references public.recipes on delete cascade`, `foreign key (component_id, recipe_id) references public.recipe_components (id, recipe_id) on delete set null (component_id)`, `unique (recipe_id, position)`.
   - Indexes: `recipe_ingredients (product_id)` and `recipe_steps (component_id, recipe_id)`. The other FK columns are covered by the leading column of a `(…, position)` unique.
   - `comment on table` for each: "Public library (F-04): shared by every user, not household-scoped; read-only for clients." Keep the existing domain wording (grams, base batch, and so on).
8. **Copy the templates, keeping ids**, in FK order: products → recipes → components → ingredients → steps (`insert … select id, … from private.seed_*`).
9. `drop table private.seed_recipe_steps, private.seed_recipe_ingredients, private.seed_recipe_components, private.seed_recipes, private.seed_products;`
10. **RLS and grants, per table.** Do not add write policies, and do not add placeholder policies (the `household_id` catch-all will not see these tables).

```sql
alter table public.<t> enable row level security;
revoke all on public.<t> from anon;
revoke insert, update, delete, truncate, references, trigger on public.<t> from authenticated;
create policy "<t>_select_authenticated" on public.<t> for select to authenticated using (true);
```

   Add a comment above the block. The revoke is what blocks writes today; the absence of write policies is what still blocks them if a future migration grants `insert` alone. These are independent levers, and both are kept.

#### 2. Isolation test

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Replace the household-scoped library assertions with public-library assertions, add the classification catch-all, and drop KD006. Leave every invite, macro-target and redemption assertion intact.

**Contract**:

- **Header**: mention F-04 and that the library is the third ownership class.
- **Before the A/B `auth.users` insert** (as postgres): snapshot `count(*)` of the five library tables into a GUC such as `rls_test.library_counts`, as an ordered `t=n;` string like the existing `c_counts`. **Replace `:57-85`**: after the insert, recount and assert the counts are unchanged ("sign-up creates no library rows").
- **Replace the per-household fixtures `:87-119`** with **one** non-seed library chain inserted as postgres, ids `00000000-0000-4000-b000-00000000c00{1..5}` (product, recipe, component, ingredient, step), and re-snapshot `rls_test.library_counts` after it. Keep the invite fixtures (`…a006`/`…b006`) and the macro-target fixtures exactly as they are.
- **Postgres-only FK probe**: deleting fixture product `…c001` raises `restrict_violation`/`foreign_key_violation`. This moves out of the A write block.
- **Replace the read loop `:256-288`** with a `household_invites`-only check that uses explicit fixture ids `…a006` (visible) and `…b006` (invisible). Drop the index-built ids. Keep the loop's third check alongside them: `select count(*) from public.household_invites where household_id <> a_household` = 0.
- **Add a library visibility check** for A (in A's section) and for B (in B's section): each sees exactly `rls_test.library_counts`, including fixture `…c001`/`…c002`. This proves two *unlinked* users see one library.
- **Replace the write block `:290-349`** with library write denial as A, for each of the five tables:
  - `insert` must raise exactly `insufficient_privilege`, with no other handler (macro_targets style, `:388-402`). Use valid column values so that a missing revoke would *succeed* rather than fail on a constraint.
  - `update … where id = <seed or fixture id>` and `delete … where id = …` must raise `insufficient_privilege` or affect 0 rows.
  - `truncate` must raise `insufficient_privilege`.
- **Replace `:413-432`** with "seed mechanism gone" (any role): `to_regprocedure('private.seed_household(uuid)') is null`, and `to_regclass('private.seed_<t>') is null` for all five.
- **Keep the anon list `:538-554`** unchanged. The library tables stay in it.
- **Grants block** (as postgres): `has_table_privilege('authenticated', 'public.<t>', p)` is false for every `p in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`, and `has_table_privilege('anon', 'public.<t>', p)` is false for every `p in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`.
- **Classification catch-all** (as postgres, after the existing catch-all):
  - Every `relkind in ('r','p')` table in `public` has a `household_id` column, is `households`, or is in a literal `library_tables` array of the five names. Otherwise raise "public.% is neither household-scoped nor a declared library table".
  - Raise if any `pg_class` row in `public` with `relkind in ('v','m')` lacks `security_invoker=true` in `reloptions` (materialized views cannot have it, so they fail outright).
  - For each library table: RLS is enabled, there is no policy with role `anon` or `public`, every policy has `cmd = 'SELECT'`, and the table has **no** `household_id` column.
  - Put a comment above the library section: the `5eed000N-` id namespace is reserved for migrations and no library write path may accept a client-supplied `id`; S-07 must replace the SELECT-only assertion with one requiring each write policy to reference `created_by` and a definer helper, never delete it.
- **`:841-862`**: drop the seeded-count loop and the `prosrc like '%seed_household%'` check (vacuous once the function no longer exists; covered by "seed mechanism gone"). Remove the now-unused `t`, `copied` and `templates` declarations.
- **`:874-945`**: C and D each assert they see exactly `rls_test.library_counts`, replacing the C-captures/D-compares pair.
- **`:1140-1166`**: remove the KD006 case. Reword the comments that cite A's non-seed rows and "checked before KD006". Reword the ordering paragraph at `:986-988`: every remaining case raises before any write, and the rejection block still stays after every block that reads `rls_test.a_household`/`b_household`.
- **Summary notices `:1196`, `:1200`**: "eight rejection SQLSTATEs" becomes "seven". Replace "seed copy", "products/recipes isolation and cross-household FKs" and "template/seed-function denial" with "public library visibility, library write denial and grants, seed mechanism removed, classification catch-all".

#### 3. Seed integrity test

**File**: `supabase/tests/seed_integrity.sql`

**Intent**: Keep every content guarantee about the repo-maintained seed set, now read from the public tables and scoped to seed ids, so that user-added rows (S-07) can never fail CI.

**Contract**:

- At the top, after `begin;`, create five **temp views** named `seed_products`, `seed_recipes`, `seed_recipe_components`, `seed_recipe_ingredients` and `seed_recipe_steps`. Each selects from its `public` table `where id::text like '5eed000N-%'`, where N = 1..5 matches the id scheme in `20261007120100_seed_products_and_recipes.sql:13-14`. Every existing check (`:14-285`) then changes only `private.seed_x` → `pg_temp.seed_x`.
- The count message becomes "% seed recipes, expected 5-10".
- **Replace "copy fidelity" `:287-340`** with a "library shape" block. It asserts:
  - (a) no library table has a `household_id` or `seed_id` column;
  - (b) each seed view is non-empty;
  - (c) every seed ingredient references a seed product, and every seed component/step references a seed recipe, so seed recipes never depend on user rows.
- Update the header and the final notice ("… macro diversity, library shape").

### Success Criteria:

#### Automated Verification:

- Only the new migration is pending: `npx supabase db push --dry-run`
- Migration applies cleanly to the hosted project: `npx supabase db push`
- Isolation test passes: `npm run test:rls`
- Seed integrity test passes: `npm run test:seed`
- Live check: `npx supabase db query --linked "select count(*) from public.products"` returns 46 and `… from public.recipes` returns 8

#### Manual Verification:

- Deliberate-break spot check, run against a scratch copy of the test file and never committed: drop `products` from the `library_tables` array and confirm that the classification catch-all fails and names `public.products`. Separately, flip one insert probe's expected outcome and confirm that it fails with a descriptive message.
- Supabase dashboard → Database → Policies shows exactly one `SELECT` policy per library table
- Guard fail-closed check, **before** `db push`: in one `begin; update public.products set grams_per_piece = null where seed_id = '5eed0001-…-000000000001' and household_id = (select id from public.households limit 1); <paste the guard do block>; rollback;` session via `npx supabase db query --linked`, confirm that the guard raises. Pick a product whose `grams_per_piece` is non-null in the template.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase. Commit and push the migration and both test files together, right after the tests pass.

---

## Phase 2: App code and smoke test

### Overview

Remove the dead KD006 message, fix the misleading RLS comment, and add the over-HTTP proof that unlinked accounts share one library.

### Changes Required:

#### 1. Invite error mapping

**File**: `src/lib/services/invites.ts`

**Intent**: KD006 can no longer be raised, so its message is dead code that suggests a reachable state.

**Contract**: Remove the `KD006` entry from `INVITE_ERRORS`. Add a one-line comment that KD006 is retired (F-04) and deliberately absent.

#### 2. Library service comment

**File**: `src/lib/services/recipes.ts`

**Intent**: The comment at `:4` says RLS scopes the library to the household, which is now false.

**Contract**: Replace it with a comment saying the library is public to every signed-in user (F-04), so the counts are global. No code change.

#### 3. Smoke test

**File**: `scripts/smoke.mjs`

**Intent**: Prove the core F-04 outcome end to end: a second, **unlinked** account sees the same library line as A before redeeming.

**Contract**:

- Insert a step after "B signin with a pending invite lands on /join" (`:221-226`) and before "B redeems the invite". `b.request("/dashboard")` must return 200 with a body matching `testIdBody("library", libraryLineA)` (or equivalent: the escaped captured line inside the `library` test id), using the thunk form because `libraryLineA` is captured at run time.
- Name the step "B dashboard shows the same public library before linking".
- Reword the obsolete comment at `:257` ("no-re-seed / no-duplicate-seed-set proof") to say the unchanged library line shows that redemption leaves the shared library untouched.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Type/Astro check passes: `npx astro check`
- Build passes: `npm run build`
- Smoke test passes against a running dev server or preview: `npm run smoke`

#### Manual Verification:

- Sign up two fresh accounts in the browser. Both dashboards show the same `Library: 8 recipes · 46 products` line before linking.
- Link them via an invite. The redemption succeeds, and both dashboards still show the same library line.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Documentation and roadmap

### Overview

Make CLAUDE.md, README and the roadmap describe the implemented library, so the next slices (S-03, S-05, S-06, S-07) build on the right rules.

### Changes Required:

#### 1. CLAUDE.md

**File**: `CLAUDE.md`

**Intent**: Replace the household-copy description and the "not yet implemented" F-04 bullet with the implemented rules, and make the public-library class a first-class convention.

**Contract**:

- **Hard rule "Household-scoped tables"**: the exception now points at the library bullet. Library tables are listed in the `library_tables` array of the isolation test's classification catch-all, and any new `public` table must be household-scoped or added there.
- **Hard rule "Client-callable Postgres functions"**: remove `private.seed_household()` from the list of `private` internals.
- **New hard-rule bullet "Public library tables"**:
  - The five tables have no `household_id`. They carry one `select … to authenticated using (true)` policy, no write policies, write grants revoked from `authenticated` and `all` from `anon`. Both levers are load-bearing and asserted by the isolation test.
  - The future write rule: seed rows (`created_by is null`) stay immutable to clients; user-added rows are editable by their author and the author's current household partner via a definer helper (never `household_members` in a policy); S-07 adds `created_by`.
  - A household-owned or per-person row may reference a library row with a plain FK, never the reverse.
  - The `5eed000N-…` id namespace is reserved for migrations. No library write path may accept a client-supplied `id`: use a definer RPC or a column-level `grant insert (<cols without id>)`. S-07 adds `created_by` together with `check (created_by is null or id::text not like '5eed%')`.
  - S-07 must **replace** the isolation test's "every library policy is SELECT-only" catch-all assertion with one that requires each write policy to reference `created_by` and a definer helper. It must not simply delete the assertion.
- **"Products and recipes" bullet** (`:37`): rewrite to describe the public library. Seed rows keep stable `5eed000N-…` ids, and seed content changes are plain `insert`/`update` statements in a data-only migration (no per-household fan-out, no `seed_household()`).
- **F-04 "Decided … not yet implemented" bullet** (`:38`): replace with the implemented state. Keep "households own only what is theirs (plans, shopping lists); people own their targets and ratings", and remove "until F-04 lands, do not build…".
- **Households bullet**: KD006 is retired; redemption no longer inspects household content.
- **Commands `test:seed`**: "seed rows of the public library cover every solver rule", no longer "copies into a household".

#### 2. README.md

**File**: `README.md`

**Intent**: Remove the per-household seed claims.

**Contract**:

- Update the `test:seed` description (`:62`) and the CI smoke bullet ("the new account's dashboard shows the seeded recipe library" → "the shared library").
- In "Cleaning up after smoke runs", state that households no longer carry library rows (no "~170 seeded rows", no "~340 rows per run"); a preserved pre-redemption household now holds nothing but its history. The two cleanup queries and the "spare redemption origins" warning stay unchanged.
- Add one sentence to the smoke-test description: an unlinked second account sees the same library.

#### 3. Roadmap

**File**: `context/foundation/roadmap.md`

**Intent**: Record the resolved Unknown.

**Contract**: In the F-04 section, set **Unknowns** to resolved (2026-10-08): library read-only for clients in F-04; seed rows immutable; user rows editable by author + current partner; `created_by` lands with S-07. Leave the status at its current value (the archive step sets `done`). Update the "Next steps" table row for F-04 so it no longer says "decide who may edit public recipes first".

#### 4. Change identity

**File**: `context/changes/shared-recipe-library/change.md`

**Intent**: Already set to `status: planned` by this planning step. No change during implementation phases.

### Success Criteria:

#### Automated Verification:

- Formatting holds for the edited markdown: `npx prettier --check CLAUDE.md README.md context/foundation/roadmap.md`
- No stale references remain: `rg -n "seed_household|private\.seed_|KD006" --glob '!context/**' --glob '!dist/**' --glob '!supabase/migrations/20261006*' --glob '!supabase/migrations/20261007*'` returns only the new migration's retirement notes and the `invites.ts` retirement comment

#### Manual Verification:

- Read the CLAUDE.md library and households bullets once end to end. They must not contradict each other or the isolation test.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful.

---

## Testing Strategy

### Unit Tests:

- None. The project has no unit-test runner, and the logic lives in SQL. Database behaviour is covered by the two SQL suites.

### Integration Tests:

- `household_isolation.sql`:
  - sign-up creates no library rows;
  - unlinked A and B, and linked C and D, each see the full library;
  - A cannot insert, update, delete or truncate any library table;
  - grant assertions;
  - `anon` sees nothing;
  - the seed function and templates are gone;
  - classification catch-all;
  - all invite, redemption and macro-target assertions unchanged except KD006.
- `seed_integrity.sql`: every content and coverage rule over the seed id namespace in the public tables, plus library shape.
- `smoke.mjs`: the existing flow, plus unlinked B seeing A's library line.

### Manual Testing Steps:

1. Run `npx supabase db push --dry-run`, then `npx supabase db push`, `npm run test:rls` and `npm run test:seed`.
2. With `npm run dev`, sign up two accounts in separate browsers, compare the dashboard `Library:` lines, link them, and compare again.
3. With a signed-in session, try a PostgREST write from the browser console (for example, a `fetch` PATCH to `/rest/v1/products?id=eq.5eed0001-…` with the anon key and session JWT). Expect HTTP 401/403 (permission denied).

## Performance Considerations

The library becomes 1/34th of its current row count, and `select … using (true)` is cheaper than the `user_household_ids()` sub-select. Nothing else is affected.

## Migration Notes

- **Destructive by design, guarded.** All 34 household copies are deleted. The guard aborts the push if any non-seed or modified row exists by then.
- **Forward-fix only.** Re-running F-02's migrations is not a rollback. If something is wrong after the push, write a new migration.
- **Ordering keeps a partial failure recoverable**: the templates are dropped only after the copy succeeds.
- **CI window.** Between `db push` and the git push of the Phase 1 commit, CI on the previous `main` commit would fail against the new schema. Push the commit immediately after the tests pass.
- **Existing households** keep their memberships, invites and macro targets. Memberless pre-redemption households become empty shells, and the README cleanup logic still handles them.

## Assumptions

1. **Access rule (the roadmap Unknown):** read-only for clients in F-04. Later, seed rows stay immutable and user rows are editable by author + current partner. Source: research §7.3.
2. **"Public" = every authenticated user, not `anon`** (`prd.md:154`).
3. **`created_by` is deferred to S-07**, because no F-04 path writes it and a nullable column can be added later without blocking anything.
4. **Stable `5eed000N-…` ids become the primary keys.** `seed_id` is dropped. Seed rows are identified by id prefix in tests.
5. **`unique (name)` on `products` is kept.**
6. **`supabase db push` applies each file transactionally.** This is believed, not verified. It is mitigated by the dry run, the guard and the step ordering.
7. **KD006 is retired, not repurposed.** S-03 picks a new code if plans should ever block a redemption.
8. **Downstream FK guidance (non-binding):** S-03 plan slots → `public.recipes on delete restrict`; S-06 ratings → `on delete cascade`.

## References

- Research: `context/changes/shared-recipe-library/research.md`
- Current library DDL and RLS: `supabase/migrations/20261007120000_products_and_recipes.sql:33-394`
- Seed ids and backfill: `supabase/migrations/20261007120100_seed_products_and_recipes.sql:13-14`
- F-01 trigger body: `supabase/migrations/20261006120000_household_data_scope.sql:88-107`
- KD006 guard: `supabase/migrations/20261007120200_household_invites.sql:261-282`
- Isolation test blocks: `supabase/tests/household_isolation.sql:57-136, 256-349, 413-432, 538-601, 841-945, 986-988, 1140-1200`
- Seed test: `supabase/tests/seed_integrity.sql:14-340`
- Smoke: `scripts/smoke.mjs:96-107, 135-139, 182-190, 221-261`
- Prior ownership analysis: `context/archive/2026-10-07-seed-products-and-recipes/research.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Public library schema, redemption cleanup and DB tests

#### Automated

- [x] 1.1 Only the new migration is pending: `npx supabase db push --dry-run`
- [x] 1.2 Migration applies cleanly to the hosted project: `npx supabase db push`
- [x] 1.3 Isolation test passes: `npm run test:rls`
- [x] 1.4 Seed integrity test passes: `npm run test:seed`
- [x] 1.5 Live check: products = 46, recipes = 8

#### Manual

- [x] 1.6 Deliberate-break spot check of the new isolation assertions
- [x] 1.7 Dashboard shows exactly one SELECT policy per library table
- [x] 1.8 Guard raises on a nulled nullable column in a rolled-back session

> Implementation notes (Phase 1, non-interactive run, 2026-10-08):
> - 1.6 run by the implementer on scratch copies (never committed): dropping `products` from `library_tables` failed with "classification: public.products is neither household-scoped nor a declared library table"; switching the products insert probe's handler to `unique_violation` failed with `42501 permission denied for table products`; additionally, a `grant insert on public.products to authenticated` prepended to the file failed with "grants: authenticated holds INSERT on library table public.products; the revoke is missing" (and the RLS-only insert probe still passed — both levers are independent).
> - 1.7 verified via `pg_policies` on the linked project (the source the dashboard Policies page renders): exactly `<table>:SELECT:authenticated` for each of the five tables. The dashboard UI itself was not opened.
> - 1.8 run before `db push`: the guard passed on live data, and raised "F-04 guard: 1 distinct products copies differ from their template" with one household's egg `grams_per_piece` nulled (template value 50), rolled back.
> - Choice: the guard also checks (c) that no household holds a *partial* copy (a deleted seed row is a modification too); households with zero copies are allowed.
> - Choice: the "seed mechanism gone" assertions run as postgres (next to the grants block) rather than as user A, so `to_regclass`/`to_regprocedure` can never be vacuously null for lack of schema privileges.
> - Choice: the `restrict_violation` FK probe runs as postgres right after the fixture chain; the library write-denial update/delete probes target every seed id (`5eed%`) and the fixture chain, not one id.

### Phase 2: App code and smoke test

#### Automated

- [ ] 2.1 Linting passes: `npm run lint`
- [ ] 2.2 Type/Astro check passes: `npx astro check`
- [ ] 2.3 Build passes: `npm run build`
- [ ] 2.4 Smoke test passes: `npm run smoke`

#### Manual

- [ ] 2.5 Two fresh accounts show the same library line before linking
- [ ] 2.6 After linking, both still show the same library line

### Phase 3: Documentation and roadmap

#### Automated

- [ ] 3.1 Prettier check passes on edited markdown
- [ ] 3.2 No stale `seed_household` / `private.seed_` / `KD006` references outside history and retirement notes

#### Manual

- [ ] 3.3 CLAUDE.md library and households bullets read consistently with the isolation test
