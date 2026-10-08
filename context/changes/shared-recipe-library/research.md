---
date: 2026-10-08T15:30:00+02:00
researcher: Claude (Opus 5.5) for Kamil Schlagowski
git_commit: 0b215a9c72cabf45cd3ea0138c5f401f43f81c30
branch: main
repository: KSchlagowski/Duo-Kitchen
topic: "F-04 shared-recipe-library — turn the household-copied recipes and products into one public library"
tags: [research, codebase, supabase, rls, recipes, products, seed, household-isolation, redemption]
status: complete
last_updated: 2026-10-08
last_updated_by: Claude (Opus 5.5)
---

# Research: F-04 shared-recipe-library

**Date**: 2026-10-08T15:30:00+02:00
**Researcher**: Claude (Opus 5.5) for Kamil Schlagowski
**Git Commit**: 0b215a9c72cabf45cd3ea0138c5f401f43f81c30
**Branch**: main
**Repository**: KSchlagowski/Duo-Kitchen

## Research Question

Roadmap F-04 (`context/foundation/roadmap.md:116-128`): make recipes and products one public library shared by every user, so that no recipe or product belongs to a household. This replaces F-02's per-household copies. The roadmap scope is to convert the five seed-copied tables to public tables, stop the sign-up trigger copying seeds through `seed_household()`, collapse the existing household copies, and update the isolation, seed-integrity and smoke tests. The roadmap Unknown, "who may edit or delete a public recipe or product", has to be settled before `/10x-plan`.

The session is non-interactive and the user said to "pick the best recommended options". Each decision below is therefore stated as a **Recommendation** with its reasoning, and the assumptions are listed in [Assumptions](#assumptions-non-interactive-session).

## Summary

- **The live data makes the collapse trivial and safe.** I ran read-only queries against the hosted project (`tvmfkhnxxsnmvogplknz`, PostgreSQL 17.11) on 2026-10-08. It has 34 households, 34 memberships (12 linked couples and 12 memberless pre-redemption households), and 1,564 product copies, which is 34 × 46. **No household has a single non-seed row** in any of the five tables, and **no seed copy differs from its template**. Every household is fully seeded (no partial copies), and no view or foreign key outside the five tables references them. The only functions whose bodies mention them are `private.seed_household` and `public.redeem_household_invite`. So "collapse" means *delete every copy and keep one canonical set*. There is nothing to merge or dedupe and no user intent to preserve.
- **Recommended shape:** drop and recreate the five tables in their final form, with no `household_id`, no `seed_id`, and no composite household FKs. Fill them from `private.seed_*` **keeping the stable `5eed…` ids**, then drop the `private.seed_*` templates and `private.seed_household()`. Restore `private.handle_new_user()` to its F-01 body (household and membership only). From then on the public tables are the single source of truth, and seed-content changes become plain `insert`s into them.
- **Recommended access rule (the Unknown):** F-04 makes the library **read-only for every client role**. Authenticated users get one `select … using (true)` policy, there are no write policies, `insert/update/delete/truncate/references/trigger` is revoked from `authenticated`, and `all` is revoked from `anon`. "Public" means *shared across households*, not anonymous: the PRD lets unauthenticated users reach only sign-in, sign-up and invite redemption (`prd.md:154`). Writes arrive later with the slices that need them:
  - Seed rows stay immutable to clients.
  - User-added rows (S-07) become editable by their author **and the author's current household partner**, through a nullable `created_by` column that S-07 adds.
  - "system" (agent) edits go through S-12/S-13's own path.
- **`redeem_household_invite()` must be rewritten.** Its KD006 guard counts `seed_id is null` rows *by `household_id`* in the five tables (`20261007120200_household_invites.sql:261-282`), and both columns disappear. Recommendation: remove the guard, retire KD006 (keep it reserved and never reuse it), and drop its UI message. S-03 (plans) decides whether household-owned plans should block a redemption.
- **The tests change in three ways:**
  - The isolation test loses its five-table household loops. These are index-coupled to the invite fixture id `…a006` (`household_isolation.sql:256-288`), so the loops need restructuring, not just shortening.
  - The isolation test gains a **library block**: every authenticated user sees the same full library, nobody can write it, anon sees nothing. It also gains a **classification catch-all**: every `public` table either has `household_id` or is on a declared library list. This catch-all closes the "a table without `household_id` silently escapes" gap that F-02 identified.
  - The seed-integrity test retargets from `private.seed_*` to the public tables, scoped to the seed id namespace, and drops "copy fidelity".
  - The smoke test needs almost no changes, because the dashboard `Library:` line keeps working. One added assertion is worth it: an unlinked second account already sees the same library line before redeeming.
- **Docs to update:** the CLAUDE.md "Products and recipes" bullet and the F-04 "not yet implemented" bullet, the `private` example list in the client-callable-functions rule, the `test:seed` description, the README cleanup section (households no longer carry ~170 rows), and the comment in `src/lib/services/recipes.ts` that says RLS scopes the library to the household.

## Detailed Findings

### 1. Current schema: five household-scoped tables plus private templates

- All five tables carry `household_id uuid not null … on delete cascade` and `seed_id uuid`, plus `unique (household_id, seed_id)` and `unique (id, household_id)`. The second unique constraint exists only as the target of the composite FKs ([20261007120000_products_and_recipes.sql:33-134](https://github.com/KSchlagowski/Duo-Kitchen/blob/0b215a9c72cabf45cd3ea0138c5f401f43f81c30/supabase/migrations/20261007120000_products_and_recipes.sql#L33-L134)).
- Child tables reference their parents through composite FKs that include `household_id`:
  - `recipe_components (recipe_id, household_id) → recipes`, `on delete cascade` (`:82`)
  - `recipe_ingredients (component_id, household_id) → recipe_components`, `on delete cascade`, and `(product_id, household_id) → products`, `on delete restrict` (`:107-108`)
  - `recipe_steps (recipe_id, household_id) → recipes`, `on delete cascade`, and `(component_id, recipe_id, household_id) → recipe_components`, `on delete set null (component_id)`, which is the PG15+ column-list form (`:126-129`)

  With `household_id` gone, all of these become plain FKs:
  - `recipe_id → recipes`
  - `component_id → recipe_components`
  - `product_id → products`, still `on delete restrict`
  - `(component_id, recipe_id) → recipe_components (id, recipe_id)`, still `on delete set null (component_id)`, which needs `unique (id, recipe_id)` on components

  The `private.seed_*` tables already have exactly this shape (`:268-301`), so the final public DDL can mirror them almost line for line.
- Composite-FK indexes are at `:136-142`. The household index is implicit in the leading column of `unique (household_id, seed_id)`.
- The RLS layer consists of four household policies per table plus revokes (`:148-239`). A client can **already** insert, update and delete library rows in its own household. The KD006 comment in the invites migration points this out (`20261007120200_household_invites.sql:261-269`). Under a public library, carrying those write policies over would let any user vandalise every couple's library. F-04 **must** close them; it cannot leave them as they are.
- The templates `private.seed_products` … `private.seed_recipe_steps` (`:246-310`) have revokes from `public, anon, authenticated`. `private.seed_products` carries `unique (name)` (`:248`).
- `private.seed_household(uuid)` (`:317-368`) copies templates into a household. `private.handle_new_user()` was redefined to call it (`:373-394`). The F-01 body without the seed call is at [20261006120000_household_data_scope.sql:88-111](https://github.com/KSchlagowski/Duo-Kitchen/blob/0b215a9c72cabf45cd3ea0138c5f401f43f81c30/supabase/migrations/20261006120000_household_data_scope.sql#L88-L111).
- The content migration fills the templates with stable ids (`5eed0001-…` products, `5eed0002-…` recipes, `5eed0003-…` components, `5eed0004-…` ingredients, `5eed0005-…` steps) and backfills every household ([20261007120100_seed_products_and_recipes.sql:13-14, 294-306](https://github.com/KSchlagowski/Duo-Kitchen/blob/0b215a9c72cabf45cd3ea0138c5f401f43f81c30/supabase/migrations/20261007120100_seed_products_and_recipes.sql#L13-L14)). Live counts: 46 products, 8 recipes.
- Enums (`store_aisle`, `meal_type`, `division_mode`, `step_timing`) live in `public` (`:15-28`) and do not depend on the tables, so dropping and recreating the tables leaves them intact.

### 2. Live data on the hosted project (read-only queries, 2026-10-08)

| Metric | Value |
| --- | --- |
| households / household_members | 34 / 34 |
| linked (2-member) households / memberless households | 12 / 12 |
| `public.products` rows | 1564 (= 34 × 46) |
| non-seed rows (`seed_id is null`) in any of the five tables | **0** |
| seed copies whose columns differ from their template (products, recipes, ingredients, steps) | **0** |
| households without a full product copy / with no copy at all | 0 / 0 |
| FKs from other tables into products/recipes/components | none |
| views in `public`/`private` | none |
| functions whose body mentions `public.products`/`public.recipes` | `seed_household`, `redeem_household_invite` |
| macro_targets rows / household_invites rows | 20 / 12 |

All rows come from smoke runs (`smoke-*@example.com`) and the developer's own accounts. Nothing has to be preserved.

### 3. Who reads or writes the library today

- **App code reads, and only counts.** `getRecipeLibrarySummary()` makes two `head: true` count queries ([src/lib/services/recipes.ts:4-22](https://github.com/KSchlagowski/Duo-Kitchen/blob/0b215a9c72cabf45cd3ea0138c5f401f43f81c30/src/lib/services/recipes.ts#L4-L22)). Its comment, "RLS scopes `recipes` and `products` to the caller's household", becomes wrong under F-04. The dashboard renders `Library: N recipes · M products` ([src/pages/dashboard.astro:27-31, 52-54](https://github.com/KSchlagowski/Duo-Kitchen/blob/0b215a9c72cabf45cd3ea0138c5f401f43f81c30/src/pages/dashboard.astro#L52-L54)). No app code writes, references `seed_id`, or touches the child tables. `src/types.ts` has only enum types and `RecipeLibrarySummary`, which need no change.
- **`public.redeem_household_invite()`** reads the five tables in the KD006 guard (`20261007120200_household_invites.sql:261-282`). Its header comment says it never calls `seed_household()` (`:175-177`). The function comment lists KD006 (`:314-315`), and so does the SQLSTATE table (`:94`). `src/lib/services/invites.ts:16` maps KD006 to "Your kitchen has data that would be left behind…".
- **No other function, view or FK** depends on these tables (live check above).

### 4. Isolation test (`supabase/tests/household_isolation.sql`): what F-04 touches

[File permalink](https://github.com/KSchlagowski/Duo-Kitchen/blob/0b215a9c72cabf45cd3ea0138c5f401f43f81c30/supabase/tests/household_isolation.sql)

| Lines | Current assertion | F-04 action |
| --- | --- | --- |
| 57-85 | the trigger copied the seed set into both households | replace: sign-up creates **no** library rows (library counts before and after the two `auth.users` inserts are equal) |
| 87-119 | per-household fixture chain ids `…b000-00000000{a,b}00{1..5}` | remove the household fixtures. Optionally add **one** non-seed fixture chain inserted as postgres, used to prove both users see it |
| 124-136 | invite fixtures `…a006/…b006`, targets | keep as they are |
| 256-288 | read loop over 6 tables; fixture id built from the loop index `i` (`:276`, `:282`), so `household_invites` **must stay element 6** | restructure: a household loop with `household_invites` only and an explicit fixture id. Deleting the five names silently turns invites into `…a001` |
| 290-349 | household write isolation, cross-household composite FK probe, `on delete restrict`, truncate | replace with library write denial (see §7). Keep the `restrict_violation` probe as postgres if desired |
| 413-432 | templates and `seed_household()` unreachable | replace: assert `private.seed_household` and `private.seed_*` **no longer exist** (`to_regclass`/`to_regprocedure` is null) |
| 538-554 | anon sees 0 rows in 7 tables | keep the five library tables in this list. Anon must still see nothing |
| 556-601 | catch-all over tables **with** `household_id` | keep. Add the classification catch-all (§7) |
| 841-862 | after redemption the target's seeded counts equal the templates; `redeem` must not mention `seed_household` | drop the count loop. The `prosrc like '%seed_household%'` check can stay, since it holds trivially, or be replaced by the "function does not exist" assertion |
| 874-945 | C and D see identical counts over the five tables | still valid, but no longer meaningful as household proof. Keep it as "linked users see the same library", or fold it into the library block |
| 1160-1163 | KD006 rejection case (A holds non-seed fixture rows) | **remove**. The block comment at `:986-988` explains why KD006 is ordered last, and it needs rewording |
| 1196, 1200 | summary notice | update wording ("eight rejection SQLSTATEs" becomes seven) |

### 5. Seed-integrity test (`supabase/tests/seed_integrity.sql`)

- Every content check (counts 5–10 recipes, Atwater, structure, rounding/piece amounts, rule coverage, macro diversity) reads `private.seed_*` ([:14-285](https://github.com/KSchlagowski/Duo-Kitchen/blob/0b215a9c72cabf45cd3ea0138c5f401f43f81c30/supabase/tests/seed_integrity.sql#L14-L285)). "Copy fidelity" (`:287-340`) exercises `seed_household()` and the household cascade.
- After F-04 the checks must read `public.*`. **Scoping issue:** once S-07 lets users add products, row-level quality checks (Atwater, rounding multiples) run against `public.products` would also judge *user* data, and a user's odd label would fail CI. **Recommendation:** scope the row-level checks to the seed id namespace with one shared predicate such as `id::text like '5eed000_-%'`, or a temp-table list of seed ids built at the top of the file. Coverage checks ("at least one row exercises rule X") can also stay scoped, so the guarantee remains about the seed. The 5–10 recipe count becomes "5–10 seed recipes".
- Replace "copy fidelity" with "library presence": every seed id is present exactly once, and steps' `component_id` belongs to the same recipe. The second part is also enforced by the `(component_id, recipe_id)` FK.

### 6. Smoke test (`scripts/smoke.mjs`)

- "Dashboard renders … with seeded library" matches `Library: [1-9]\d* recipes` ([:135-139](https://github.com/KSchlagowski/Duo-Kitchen/blob/0b215a9c72cabf45cd3ea0138c5f401f43f81c30/scripts/smoke.mjs#L135-L139)), which still passes.
- `linkedHouseholdBody()` requires both linked users to show A's captured library line (`:100-107`, `:250-261`). This still passes. The comment at `:257` ("no-re-seed / no-duplicate-seed-set proof") is obsolete.
- **Recommended addition:** before B redeems (after B signs in at `:223-226`), assert that B's dashboard library line equals `libraryLineA`. This is the over-HTTP proof that two **unlinked** accounts see one shared library, which is the core outcome of F-04, and it costs one step.

### 7. Recommended design

#### 7.1 Table shape

These are the five tables recreated in the same migration, mirroring `private.seed_*` plus the bookkeeping the public tables already had:

- `public.products`: `id uuid primary key default gen_random_uuid()`, the nutrition columns, `aisle`, `rounding_step_g`, `grams_per_piece`, `created_at`, the same checks, and `unique (name)`. The template had `unique (name)`, and a single shared library benefits from it: the agent's "use the app's product database" precedence (FR-025) needs one row per product, not near-duplicates. S-07 may revisit it (case-folding, brand variants).
- `public.recipes`: as before, minus `household_id`/`seed_id`.
- `public.recipe_components`: `recipe_id uuid not null references public.recipes on delete cascade`, `unique (recipe_id, position)`, `unique (id, recipe_id)`.
- `public.recipe_ingredients`: `component_id … references public.recipe_components on delete cascade`, `product_id … references public.products on delete restrict`, `unique (component_id, position)`, the `min_amount_g <= base_amount_g` check.
- `public.recipe_steps`: `recipe_id … references public.recipes on delete cascade`, `foreign key (component_id, recipe_id) references public.recipe_components (id, recipe_id) on delete set null (component_id)`, `unique (recipe_id, position)`.
- Indexes on the FK columns not covered by a leading unique column: `recipe_ingredients (product_id)` and `recipe_steps (component_id, recipe_id)`. `recipe_components (recipe_id)`, `recipe_ingredients (component_id)` and `recipe_steps (recipe_id)` are already covered by the `(…, position)` uniques.
- No `created_by` yet (see §7.3). No `seed_id`: the stable `5eed…` ids **are** the seed identity.

**Alternatives considered:**

- *In-place `alter table … drop column household_id, seed_id`:* this works, but it means dropping five composite FKs, ten unique constraints and five indexes by their generated names, and then adding the plain FKs. The result is harder to review than a `create table` that reads as the final shape. Recreate is safe only because the live data contains nothing but seed copies. The migration should **assert that before dropping** (see §7.4).
- *Keep `private.seed_*` as the canonical source and expose views:* this keeps two stores in sync for no benefit. Seed edits become one `insert` into public tables either way. Rejected.
- *Keep a nullable `household_id` for "household-private extensions":* the PRD rules this out explicitly ("no recipe or product belongs to a household", `prd.md:151`), and it would collide with the "not null" hard rule and the catch-all. Rejected.

#### 7.2 RLS and grants

```sql
alter table public.<t> enable row level security;
revoke all on public.<t> from anon;
revoke insert, update, delete, truncate, references, trigger on public.<t> from authenticated;
create policy "<t>_select_authenticated" on public.<t> for select to authenticated using (true);
```

- **Both levers, again.** The revoke is what makes writes impossible today. The absence of write policies means that a future `grant insert` alone would still be denied by RLS. This follows the CLAUDE.md "policies and grants are independent levers" philosophy.
- The "granular per-operation, per-role policies" hard rule is met by an explicit select policy and **no** write policies. Unlike `household_invites`, no placeholder write policies are needed, because those exist only to satisfy the `household_id` catch-all, which will not see these tables.
- Supabase's default privileges grant everything on new `public` tables to `anon` and `authenticated`, so the revokes are load-bearing because the tables are recreated. Tests must assert them with `has_table_privilege`.

#### 7.3 Decision on the roadmap Unknown: who may edit or delete

| Option | Verdict |
| --- | --- |
| Anyone signed in edits or deletes anything | **Rejected.** With one library, one user's mistake or a stray PostgREST call damages every couple's recipes and silently changes solver inputs for plans already made. |
| Only "system" (migrations and the agent) writes | Too strict. FR-011 says *a person* can extend the product database. |
| **Seed rows read-only to clients; user rows editable by their author and the author's current household partner; agent edits via its own path** | **Recommended.** |

- F-04 itself ships **no** client write path (§7.2).
- S-07 adds `created_by uuid null references auth.users on delete set null` to `products` (and S-12 adds it to `recipes`), plus insert/update/delete policies or a definer RPC whose rule is `created_by = auth.uid()` *or* `created_by` is a member of the caller's household. The second branch needs a new definer helper, for example `private.user_household_member_ids()`, which keeps the "never query `household_members` in a policy" rule.
- `created_by is null` marks seed/system rows and stays immutable to people.
- Because authorship is keyed on the **person**, not the household, it needs no redemption cascade: after a redemption the author's new partner gains edit rights and the old household loses them. This is consistent with CLAUDE.md's per-person model.
- Deleting a product still used by an ingredient is blocked by `on delete restrict`. Deleting a recipe that a plan or rating references is a question for S-03/S-06 FKs. Recommendation for them: `on delete restrict` from plans, `on delete cascade` from ratings.

Why not add `created_by` now: no F-04 code path writes it, every existing row would be `null`, and adding a nullable column later is a non-blocking `alter`. Deferring keeps F-04 a pure ownership refactor. If the planner would rather settle the schema once, adding it now is harmless. Either way, flag it.

#### 7.4 Migration outline (one file, e.g. `20261009120000_shared_recipe_library.sql`)

1. **Guard:** a `do` block that raises if any of the five tables holds a row with `seed_id is null`, or a seed copy that differs from its template. This uses the same comparisons as §2. If someone created data between this research and the push, the migration aborts instead of destroying it. The guard is cheap and turns a destructive step into a checked one.
2. `create or replace function private.handle_new_user()` with the F-01 body (household and membership only). Re-issue `revoke execute … from public, anon, authenticated`.
3. `create or replace function public.redeem_household_invite(text)` without the KD006 block. Keep every other check, lock and comment, update the header and function comments, and re-issue the revoke/grant pair. Keep the comment that membership moves must stay a single `update`.
4. `drop function private.seed_household(uuid);`
5. `drop table public.recipe_steps, public.recipe_ingredients, public.recipe_components, public.recipes, public.products;` This removes all 34 household copies, along with their policies and indexes.
6. Recreate the five tables (§7.1) with comments that state "public library (F-04); not household-scoped; read-only for clients".
7. Copy from the templates, **keeping ids**: products → recipes → components → ingredients → steps, `insert … select id, … from private.seed_*`.
8. `drop table private.seed_recipe_steps, …, private.seed_products;`
9. RLS, revokes and select policies (§7.2).
10. A rollback note in the header, in the style of the invites migration: re-running F-02 is not a rollback, so forward-fix only.

**Ordering note:** step 3 must precede step 5 only for readability. PL/pgSQL bodies are not bound at creation time, so dropping columns would not error, but the function would break at runtime.

**Assumption:** `supabase db push` applies each migration file inside a transaction, so a failure in steps 1–9 leaves the schema untouched. The planner should verify this against the CLI docs or behaviour before relying on it. The guard is useful whether or not it holds.

#### 7.5 Redemption and KD006

- After F-04, households own only `household_invites` and the per-person `macro_targets`, which travel with the person. Nothing is "left behind", so the KD006 guard has nothing to count.
- Retire KD006: remove the guard, remove `KD006` from `INVITE_ERRORS` in `src/lib/services/invites.ts:16`, and keep a "KD006 retired (F-04), do not reuse" line in the migration's SQLSTATE comment so codes stay unambiguous in logs.
- The old comment's warning that every new household table with `seed_id` must be added to the literal list (`:271-272`) goes away with the guard. S-03 must re-decide whether a redeemer's saved plans block the move. That is a different question (plans are household data), and it is recorded in Open Questions.

#### 7.6 New test blocks (`household_isolation.sql`)

- **Library visibility:** as postgres, record `count(*)` of each library table. As A, as B (unlinked, different households), and later as D post-redemption, each sees exactly that count.
- **Library write denial (as A):**
  - `insert` into each table raises `insufficient_privilege`, strictly, with no other handler, in the macro_targets style (`:351-411`).
  - `update`/`delete` of a seed id either raise `insufficient_privilege` or affect 0 rows.
  - `truncate` raises `insufficient_privilege`.
- **Grants:** `has_table_privilege('authenticated', 'public.<t>', 'INSERT'|'UPDATE'|'DELETE'|'TRUNCATE')` is false, and `has_table_privilege('anon', 'public.<t>', 'SELECT')` is false.
- **Classification catch-all:** every `relkind = 'r'` table in `public` either has a `household_id` column (and is checked by the existing catch-all), or is `households`, or is in a literal `library_tables` array. For each library table it also asserts RLS is enabled, there is no policy for `anon`/`public`, and every policy is `cmd = 'SELECT'`. This is the automated net F-02 said a global table would otherwise slip through (`context/archive/2026-10-07-seed-products-and-recipes/research.md:108,114,177`).
- **Seed mechanism gone:** `to_regprocedure('private.seed_household(uuid)') is null`, and `to_regclass('private.seed_products') is null` (and likewise for the other four).

### 8. Docs and CLAUDE.md changes

- `CLAUDE.md:37`: rewrite the "Products and recipes" bullet to describe the public library: no `household_id`, read-only for clients, stable `5eed…` seed ids, seed changes are plain inserts in a data-only migration, and the authorship rule for when writes arrive.
- `CLAUDE.md:38`: replace "Decided … not yet implemented" with the implemented state. Keep "households own only what is theirs".
- `CLAUDE.md:6`: the exception wording already exists. Point it at the library bullet and the new classification catch-all.
- `CLAUDE.md:9`: drop `private.seed_household()` from the list of `private` internals.
- `CLAUDE.md:19` and `README.md:62`: `test:seed` no longer "copies into a household".
- `README.md:188` onward: each smoke run no longer adds ~340 library rows. Households hold only invites and memberships. The cleanup query and the "spare redemption origins" logic stay unchanged and correct.
- `src/lib/services/recipes.ts:4`: update the RLS comment.
- `context/foundation/roadmap.md`: mark F-04 Unknown resolved (§7.3) at plan time. That is not part of research.

## Code References

- `supabase/migrations/20261007120000_products_and_recipes.sql:33-134`: five household-scoped tables with `seed_id` and composite FKs
- `supabase/migrations/20261007120000_products_and_recipes.sql:148-239`: household RLS that currently allows client writes
- `supabase/migrations/20261007120000_products_and_recipes.sql:246-310`: `private.seed_*` templates (the target shape for the public tables)
- `supabase/migrations/20261007120000_products_and_recipes.sql:317-394`: `seed_household()` and the seeding `handle_new_user()`
- `supabase/migrations/20261006120000_household_data_scope.sql:88-111`: the F-01 `handle_new_user()` body to restore
- `supabase/migrations/20261007120100_seed_products_and_recipes.sql:13-14, 294-306`: stable seed id scheme; household backfill
- `supabase/migrations/20261007120200_household_invites.sql:94, 175-177, 261-282, 314-315`: KD006 definition, guard and docs
- `supabase/migrations/20261008120000_macro_targets.sql:23-34`: per-person pattern that a future `recipe_ratings` plain FK to `public.recipes` builds on
- `supabase/tests/household_isolation.sql:57-136, 256-349, 413-432, 538-601, 841-945, 1160-1163, 1196-1200`: the blocks F-04 rewrites
- `supabase/tests/seed_integrity.sql:14-285, 287-340`: template-based checks and copy fidelity
- `scripts/smoke.mjs:98-107, 135-139, 182-190, 223-261`: library line capture and linked-household comparison
- `src/lib/services/recipes.ts:4-22`: library count service (comment only changes)
- `src/lib/services/invites.ts:16`: KD006 message
- `src/pages/dashboard.astro:27-31, 52-54`: `Library:` line
- `CLAUDE.md:6, 9, 19, 37, 38`, `README.md:62, 184-205`: docs to update

## Architecture Insights

- **One choke point per ownership class.**
  - Household data goes through `private.user_household_ids()` and is policed by the `household_id` catch-all.
  - Per-person data adds the owner predicate and the composite membership FK.
  - F-04 introduces a third class, *public library*, which needs its own automated guard. Without one, a future table that forgets `household_id` would look like a library table and escape every check. The classification catch-all makes the classes exhaustive.
- **Stable seed ids become first-class.** Tests, the future agent (S-12/S-13) and the solver fixtures (S-04) can address seed rows deterministically, the way they addressed templates before. Seed edits become `update public.products … where id = '5eed0001-…'` in a data migration, with no fan-out to N households.
- **Redemption gets simpler, not riskier.** Removing the library from household scope deletes the only reason redemption had to look at household content. The known gap in which edited or deleted seed rows were silently discarded on redemption (`20261007120200_household_invites.sql:261-269`) disappears with it.
- **Read-only first, writes per slice.** Each later slice (S-07 products, S-12/S-13 agent) introduces exactly one write path with its own test probes. This matches how S-01 introduced definer RPCs rather than broad write policies.

## Historical Context (from prior changes)

- `context/archive/2026-10-07-seed-products-and-recipes/research.md:96-106`: F-02 considered a **global catalog** (option A) and rejected it. Recipes had to be household-owned under the PRD as it then stood: FR-003 "linked persons share recipes", and household privacy. A global product table would also escape the catch-all. Both premises changed on 2026-10-08 (`prd.md:150-153`), and the catch-all gap is what §7.6 closes.
- `context/archive/2026-10-07-seed-products-and-recipes/plan.md:67-68, 77`: why child tables denormalised `household_id` (catch-all visibility, composite FKs) and why `seed_id` existed (idempotent copies, S-01 dedupe handle). With the household gone, both justifications go away.
- `context/archive/2026-10-07-link-partner-household/research.md:45`: "both see the same recipes" required zero schema work in S-01. After F-04 it holds across *all* users, not just linked ones.
- `context/archive/2026-10-07-link-partner-household/plan.md:35`: client-callable functions must be in `public`, the hosted project exposes `public` only, and there is no service-role key in the app. These are the constraints any future library write RPC (S-07) inherits.
- Commit `0b215a9` (2026-10-08) records the decision and why it was made: a per-person rating cannot reference a household copy, because the membership cascade would move it to a household the copy is not in.

## Related Research

- `context/archive/2026-10-07-seed-products-and-recipes/research.md`: the original ownership analysis
- `context/archive/2026-10-07-link-partner-household/research.md`: redemption design, KD codes, memberless-household preservation
- `context/archive/2026-10-08-set-daily-macro-targets/research.md`: the per-person table pattern that `recipe_ratings` will follow

## Assumptions (non-interactive session)

1. **Access rule (roadmap Unknown):** chosen as in §7.3. F-04 ships read-only, and the author-plus-partner rule is recorded for S-07/S-12. *Owner: user*. Confirm or override at `/10x-plan`.
2. **"Public" means all authenticated users, not anon.** This follows `prd.md:154`.
3. **Destructive collapse is acceptable** because the live data is 100% unmodified seed copies (§2). The migration guard (§7.4 step 1) re-checks this at push time.
4. **Stable `5eed…` ids are kept as primary keys** of the public seed rows, and `seed_id` is dropped.
5. **`unique (name)` on `public.products`** carries over from the template. S-07 may relax it.
6. **`supabase db push` wraps each migration file in a transaction.** This is believed but not verified in this session.
7. **KD006 is retired, not repurposed.**

## Open Questions

1. **Confirm the edit/delete rule** (Assumption 1), and whether `created_by` lands in F-04 or S-07. Recommendation: S-07.
2. **S-03:** should a redeemer's own saved plans block redemption, migrate, or be left in the memberless origin household, as all household data is today? KD006 is retired here, so S-03 needs its own decision and, if it blocks, a new code.
3. **S-06/S-03 FK actions toward `public.recipes`:** `on delete restrict` from plan slots and `cascade` from ratings is recommended, to be decided in those slices.
4. **Deploy sequencing:** CI runs `test:rls` and `test:seed` against the *deployed* schema (CLAUDE.md:6). After `db push`, `main`'s current tests will fail until the F-04 branch merges, and before the push the F-04 branch's new tests fail. The plan should push and merge back to back. It should also prepare the rewritten test files in the same commit and run them with `npm run test:rls` / `npm run test:seed` right after the push.
5. **Verify** that the transaction-per-file behaviour of `supabase db push` holds (Assumption 6).
