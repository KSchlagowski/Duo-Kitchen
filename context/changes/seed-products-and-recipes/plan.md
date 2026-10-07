# Seed Products and Recipes Implementation Plan

## Overview

Roadmap F-02. Add the minimum data shape for products (with nutrition and store aisle) and recipes (components, ingredients, steps), and seed every household with a repo-maintained set of ~40 products and 8 test recipes. The recipes carry every attribute the solver and scheduler need: rounding step, minimum sensible amount, whole/half-piece rule, raw vs. cooked weight, per-component vs. whole-dish division, and make-ahead vs. fresh steps. There is no recipe UI. The only app-layer change is a thin read service and a dashboard line that confirms the seed reached the household.

## Current State Analysis

- The only schema is F-01's migration `supabase/migrations/20261006120000_household_data_scope.sql`. It contains:
  - the `private` schema;
  - `households` and `household_members`;
  - `private.user_household_ids()`;
  - the sign-up trigger `private.handle_new_user()`;
  - an idempotent backfill.
- Nothing exists yet for products or recipes: no tables, no `seed.sql`, no types, no service.
- Hard rules (CLAUDE.md) apply to any household-owned table:
  - `household_id uuid not null`, with an index;
  - per-operation `to authenticated` policies through `private.user_household_ids()`;
  - no `anon` policies;
  - the isolation test must be extended for each new table;
  - before merging, run `db push` and then `test:rls`.
- The isolation test's catch-all (`supabase/tests/household_isolation.sql:249-287`) automatically polices every `public` table that has a `household_id` column.
- The project is cloud-only. Seeding must go through `npx supabase db push`, so `db reset` and `seed.sql` are not options.
- No JS test runner exists. The verification tools are SQL tests run in a rolled-back transaction (`supabase db query --linked -f …`), `npm run smoke`, lint, `astro check` and build.
- This checkout is not linked and has no `node_modules`. The implementer must run `npm ci` and `npx supabase link --project-ref <ref>` first.

## Desired End State

- Five household-scoped tables exist in `public`, all inside the hard rule and covered by the catch-all: `products`, `recipes`, `recipe_components`, `recipe_ingredients`, `recipe_steps`.
- Repo-maintained template tables in `private` hold the seed set (8 recipes, ~40 products) under stable hard-coded UUIDs. They are not reachable through the API and not readable by `authenticated`/`anon`.
- `private.seed_household(household_id)` copies the templates into a household. It is idempotent: re-running it adds nothing to an unmodified household. It is meant for new or empty households only (see Migration Notes).
- The sign-up trigger calls it, so every new account starts with the seed set. A backfill seeds every existing household.
- `npm run test:rls` proves cross-household isolation for the new tables, including cross-household FK references being impossible.
- `npm run test:seed` proves the seed content covers every solver rule and is internally consistent. CI runs both tests.
- `/dashboard` shows "Library: 8 recipes · N products" for a fresh account, and `npm run smoke` asserts it.

Verify with `npx supabase db push`, `npm run test:rls`, `npm run test:seed`, `npm run smoke`, `npm run lint`, `npx astro check` and `npm run build`.

### Key Discoveries:

- `supabase/migrations/20261006120000_household_data_scope.sql:88-111`: the sign-up trigger is the hook for per-household seeding. A later migration can `create or replace` it.
- `supabase/migrations/20261006120000_household_data_scope.sql:116-135`: the idempotent backfill is the precedent to follow.
- `supabase/migrations/20261006120000_household_data_scope.sql:13-14`: `usage` on `private` is granted to `authenticated`. Template tables therefore need an explicit `revoke all … from public, anon, authenticated`.
- `supabase/tests/household_isolation.sql:23-26`: test users are inserted into `auth.users`, which fires the trigger. After this change, both test households are auto-seeded.
- `supabase/tests/household_isolation.sql:249-287`: the catch-all only sees tables that have `household_id`. That is why every child table carries `household_id` too.
- `src/lib/services/household.ts:5-26`: service pattern (RLS-scoped, no explicit household filter, snake→camel mapping, throw on error).
- `src/pages/dashboard.astro:9-24`: visible confirmation with a logged fallback, which is the pattern to copy.
- `scripts/smoke.mjs:56`: sign-up → dashboard 200. This guards the heavier trigger.

## What We're NOT Doing

- Any recipe or product UI: library, detail, add-product form (S-05, S-07).
- Ratings (S-06), plans (S-03), photos/storage (S-05/S-12), "system" attribution columns (S-12/S-13), spice blends and broth (v2).
- Macro computation in TypeScript or a SQL view. FR-010 macros are computed by S-04/S-05 consumers. Here they are computed only inside the SQL integrity test.
- Display units other than grams (ml, pieces as a display unit). Liquids are stored as grams, density ≈ 1.
- A recipe-level "minimum sensible calories" value. S-06 derives it from per-ingredient minimums.
- Propagating future seed-content *edits* into existing household copies. Later migrations may add new templates and copy only those new rows (see Migration Notes). Rewriting existing copies is a future decision that `seed_id` makes possible.
- S-01 dedupe of two seed sets when a partner joins. `seed_id` makes it possible, but S-01 owns it.
- `supabase gen types`. Hand-written types stay consistent with F-01.
- `supabase/seed.sql` and `config.toml` `[db.seed]` stay untouched.

## Implementation Approach

The plan stays inside the existing household rule rather than inventing a second access model.

- **Products and recipes are both per-household copies** of a template kept in `private`, filled by a migration. This resolves roadmap Unknown and research Option B.
- **Child tables denormalise `household_id`.** Composite foreign keys (`(parent_id, household_id) → parent (id, household_id)`) make it impossible for a row to reference another household's row. This also means policies stay identical one-liners that the catch-all can check.
- **Every copied row keeps a `seed_id`** pointing at its template row. This gives idempotent copies (`on conflict (household_id, seed_id) do nothing`), deterministic addressing for tests and future update migrations, and a handle for S-01 to discard duplicate seed rows.
- **Schema and content are separate migrations.** Content updates later become new data-only migrations.
- **Phase order:**
  1. Schema + seeding hook + isolation test. The test uses its own fixture rows, so it works even with empty templates.
  2. Seed content + backfill + integrity test.
  3. Read service, dashboard line, smoke assertion and docs.

### Assumptions (non-interactive session — decisions taken without user input)

1. **Product ownership: per-household copy (Option B).** It stays within the "`household_id not null`" hard rule and the catch-all, needs no CLAUDE.md amendment, gives one FK target for S-07/S-12, and reuses the mechanism recipes need anyway. Cost: ~170 rows duplicated per household (trivial), and future seed fixes need an explicit update migration.
2. **Recipes are household-owned** (FR-003/024/025, privacy NFR) and seeded the same way.
3. **Seed data ships in migrations** applied by `npx supabase db push`. `seed.sql` / `--include-seed` is not used.
4. **Minimum sensible amount lives on the recipe ingredient** (`min_amount_g`, nullable). Concept: "fried eggs require at least 1 egg". S-06 derives minimum calories from it.
5. **Raw/cooked is a ratio on the component** (`cooked_yield_ratio` = cooked weight ÷ raw weight, nullable = not weighed after cooking). Yield depends on cooking method, so it sits on the component, not the product.
6. **Grams are the only stored unit.** Piece products carry `grams_per_piece`. Base amounts of piece products are stored in grams and must be a whole (or, if allowed, half) multiple of `grams_per_piece`.
7. **Rounding step**: a default on the product, with an optional override on the recipe ingredient.
8. **Whole vs. half pieces** is a recipe-ingredient flag (`allow_half_pieces`), because the concept says "if the recipe allows it".
9. **Base quantities** are stored as one base batch per recipe. The solver (S-04) picks the scale factor per component, or per recipe for whole-dish recipes.
10. **Seed integrity** is enforced by DB `check` constraints for single-row invariants, plus a rolled-back SQL test (`npm run test:seed`) for cross-row and coverage invariants. CI runs the test.
11. **A thin read service and a dashboard line are in scope.** They give a visible confirmation (F-01 precedent) and let smoke verify the seed reaches new accounts end-to-end. There is no recipe UI.

## Critical Implementation Details

- **Composite FK with a nullable column.** `recipe_steps.component_id` is optional. Its FK `(component_id, recipe_id, household_id) → recipe_components (id, recipe_id, household_id)` must use `on delete set null (component_id)` (column-list form, Postgres 15+). A plain `set null` would also null `recipe_id`/`household_id` and violate `not null`. With `MATCH SIMPLE` (the default), a null `component_id` skips the check, which is the desired behaviour.
- **Definer discipline for the new function and the replaced trigger function:**
  - `security definer`;
  - `set search_path = ''`;
  - fully qualified names;
  - `revoke execute … from public, anon, authenticated`.
  
  `create or replace function private.handle_new_user()` keeps its existing body (household + membership) and adds `perform private.seed_household(new_household_id);` before `return new`. Re-issue the `revoke` after the replace.
- **Copy order and ID mapping inside `seed_household`.** Copy in this order: products → recipes → components → ingredients → steps. Each copy gets a fresh `gen_random_uuid()`. Children resolve their parent's copied id by joining the template row's parent template id to `public.<parent>.seed_id` within the same household. Every insert uses `on conflict (household_id, seed_id) do nothing`, so the function is safely re-runnable.
- **The sign-up transaction is now heavier** (~170 inserts). A failing seed blocks sign-up. `npm run smoke` is the guard and must pass after Phase 1 and Phase 2 pushes.
- **Verification runs against the hosted DB, not the branch.** CI runs `test:rls`/`test:seed` against the already-deployed schema. Each phase's `npx supabase db push` must happen *before* its tests are run or the branch is merged.

## Phase 1: Schema, Seeding Hook & Isolation Test

### Overview

One migration creates the enums, the five household tables with RLS, the empty `private` template tables, `private.seed_household()` and the extended sign-up trigger. The isolation test is extended to cover the new tables.

### Changes Required:

#### 1. Schema migration

**File**: `supabase/migrations/20261007120000_products_and_recipes.sql`

**Intent**: Create the minimum product/recipe shape that carries every solver attribute, scoped by household under the F-01 pattern. Also create the template-plus-copy mechanism that seeds households.

**Contract**:

Enums (in `public`, language-neutral keys; S-14 maps labels):
- `store_aisle`: `produce, dairy, meat_fish, bakery, dry_goods, spices, frozen, other`
- `meal_type`: `breakfast, second_breakfast, lunch, afternoon_snack, dinner`
- `division_mode`: `per_component, whole_dish`
- `step_timing`: `make_ahead, fresh`

Columns common to all five tables:
- `id uuid pk default gen_random_uuid()`
- `household_id uuid not null references public.households on delete cascade` (indexed)
- `seed_id uuid null`, with `unique (household_id, seed_id)`
- `created_at timestamptz not null default now()`

Per table:
- **`public.products`**
  - Columns:
    - `name text not null`
    - `kcal_per_100g`, `protein_per_100g`, `fat_per_100g`, `carbs_per_100g` as `numeric(5,1) not null`
    - `aisle store_aisle not null`
    - `rounding_step_g numeric(5,1) not null default 10`
    - `grams_per_piece numeric(6,1) null` (non-null means the product is counted in pieces)
  - Checks:
    - macros ≥ 0
    - `protein + fat + carbs ≤ 100`
    - `kcal ≤ 900`
    - `rounding_step_g > 0`
    - `grams_per_piece > 0`
  - No `unique (household_id, name)`: a name collision with a user-created product would abort seed copies, and the `(household_id, seed_id)` key already makes copies idempotent. The product-dedupe policy is left to S-07. (`private.seed_products` keeps `unique (name)` to guard seed content.)
  - `unique (id, household_id)` (composite-FK target)
- **`public.recipes`**
  - Columns:
    - `name text not null`
    - `cuisine text not null` (open-ended; agent imports bring arbitrary cuisines)
    - `prep_minutes int not null check (> 0)` (S-06 derives the bucket)
    - `meal_types meal_type[] not null default '{}' check (cardinality(meal_types) <= 2)`
    - `division_mode division_mode not null`
    - (no `photo_url`: S-05 adds it with the storage work)
  - `unique (id, household_id)`
- **`public.recipe_components`**
  - Columns:
    - `recipe_id`
    - `position int not null`
    - `name text not null`
    - `cooked_yield_ratio numeric(4,2) null check (> 0)`
  - FK `(recipe_id, household_id) → recipes (id, household_id) on delete cascade`
  - `unique (recipe_id, position)`
  - `unique (id, household_id)`
  - `unique (id, recipe_id, household_id)`
  - A whole-dish recipe has exactly one component, which is the scalable unit.
- **`public.recipe_ingredients`**
  - Columns:
    - `component_id`, `product_id`
    - `position int not null`
    - `base_amount_g numeric(7,1) not null check (> 0)`
    - `rounding_step_g numeric(5,1) null check (> 0)` (override)
    - `min_amount_g numeric(7,1) null check (> 0 and ≤ base_amount_g)`
    - `allow_half_pieces boolean not null default false`
  - FK `(component_id, household_id) → recipe_components (id, household_id) on delete cascade`
  - FK `(product_id, household_id) → products (id, household_id) on delete restrict`
  - `unique (component_id, position)`
- **`public.recipe_steps`**
  - Columns:
    - `recipe_id`, `position int not null`
    - `instruction text not null`
    - `timing step_timing not null`
    - `component_id uuid null`
    - `duration_minutes int null check (> 0)`
  - FK `(recipe_id, household_id) → recipes (id, household_id) on delete cascade`
  - FK `(component_id, recipe_id, household_id) → recipe_components (id, recipe_id, household_id) on delete set null (component_id)`
  - `unique (recipe_id, position)`

Index every FK column not already leading a unique index: `product_id` and `component_id` on ingredients, and `component_id` on steps.

RLS on all five tables:
- `enable row level security`;
- `revoke all … from anon`;
- `revoke truncate, references, trigger on public.<table> from authenticated` (F-01 precedent, `20261006120000_household_data_scope.sql:68-69`; TRUNCATE bypasses RLS);
- four policies `"<table>_{select,insert,update,delete}_authenticated"` `to authenticated`, each `using` / `with check (household_id in (select private.user_household_ids()))` as applicable (insert: with check only; update: both; select/delete: using).

Templates in `private`:
- `private.seed_products`, `seed_recipes`, `seed_recipe_components`, `seed_recipe_ingredients`, `seed_recipe_steps` mirror the public columns minus `household_id`/`seed_id`/`created_at`.
- Their `id` is the stable seed UUID. Template FKs point to template parents.
- The same `check` constraints apply, so bad content fails at insert time. `private.seed_products` also has `unique (name)`.
- `revoke all on … from public, anon, authenticated`.
- RLS is not needed in `private` (not exposed, no grants). Add a comment saying so.

Functions and trigger:
- `private.seed_household(p_household_id uuid) returns void language plpgsql security definer set search_path = ''`. It copies the templates in dependency order with `on conflict (household_id, seed_id) do nothing` and `revoke execute … from public, anon, authenticated`.
- `create or replace function private.handle_new_user()`: unchanged body plus `perform private.seed_household(new_household_id);`.
- No backfill in this migration, because the templates are still empty. Phase 2 backfills.

#### 2. Isolation test extension

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Prove the five new tables isolate households, accept writes only into the caller's own household, and cannot reference another household's rows. The assertions must work whether or not templates have content.

**Contract**: New blocks between the existing sections, following the file's style (`do $$ … raise exception …`, `set_config('rls_test.*')` to pass ids).

- **Setup (as postgres)**: insert one fixture chain per household (product → recipe → component → ingredient → step) with fixed test UUIDs. Name the fixture products `RLS test product A` / `RLS test product B` so they never reuse a seed product name. Store A's and B's fixture ids in `rls_test.*` settings.
- **Trigger seeding (as postgres)**: for each test household, row counts per table where `seed_id is not null` equal the corresponding `private.seed_*` template counts.
- **Reads as user A**:
  - every row visible in each of the five tables has `household_id = a_household`;
  - B's fixture ids are invisible;
  - A's fixture rows are visible.
- **Writes as user A**:
  - insert a product into A's household succeeds;
  - insert with `household_id = b_household` raises `insufficient_privilege` (RLS with-check);
  - `update`/`delete` on B's fixture rows affects 0 rows;
  - inserting an ingredient in A's household that points at B's product id fails with `foreign_key_violation` (composite FK);
  - deleting A's fixture product while an ingredient uses it fails with `foreign_key_violation` (restrict);
  - `truncate public.products` raises `insufficient_privilege`.
- **Templates and function as user A**:
  - `select` from each `private.seed_*` table raises `insufficient_privilege`;
  - `perform private.seed_household(a_household)` raises `insufficient_privilege`.
- **Anon**: 0 rows or `insufficient_privilege` on all five tables.
- **Final notice**: update the summary to mention products/recipes.

The catch-all covers RLS and policy shape automatically. Do not change it.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly to the hosted project: `npx supabase db push`
- Supabase advisors report no new issues for the new tables/functions: run `npx supabase db advisors --linked` if `npx supabase db --help` lists it; otherwise check Dashboard → Advisors (Security + Performance) and record the result. In both cases also run `npx supabase db lint --linked` for the plpgsql functions (it is not a substitute for the advisors).
- Extended isolation test passes, including the catch-all over the five new tables: `npm run test:rls`
- Isolation test fails when isolation is deliberately broken. Run a scratch copy that, inside the same rolled-back transaction and as postgres before impersonating A, runs `alter policy "products_select_authenticated" on public.products using (true);`. Confirm a non-zero exit with the "B's fixture ids are invisible" / "every row … has household_id = a_household" message (not an FK error), then delete the scratch copy.
- Smoke test still passes (sign-up goes through the replaced trigger): `npm run smoke`
- Lint passes: `npm run lint`

#### Manual Verification:

- In the Supabase dashboard, the five `public` tables show RLS enabled with four policies each, and the `private.seed_*` tables exist and are empty.
- A newly signed-up account still lands on `/dashboard` with its household line.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Seed Content, Backfill & Integrity Test

### Overview

A data-only migration fills the templates with 8 Polish recipes and the products they use, then seeds every existing household. A rolled-back SQL test proves the content covers every solver rule and is consistent.

### Changes Required:

#### 1. Seed content migration

**File**: `supabase/migrations/20261007120100_seed_products_and_recipes.sql`

**Intent**: Give every household plausible products with nutrition values and a set of test recipes that exercises each solver and scheduler rule. Without these, S-03/S-04/S-05 cannot be built or verified.

**Contract**:

- **Inserts into the `private.seed_*` tables only**, followed by the backfill: `perform private.seed_household(h.id)` for every `public.households` row (idempotent).
- **Stable UUIDs** with a readable prefix per table:
  - products `5eed0001-0000-4000-8000-0000000000NN`
  - recipes `5eed0002-…`
  - components `5eed0003-…`
  - ingredients `5eed0004-…`
  - steps `5eed0005-…`
- **Language**: names, instructions and cuisine are in Polish (FR-026).
- **Products** (~30–45 rows): the union of all recipe ingredients plus a few common extras.
  - Nutrition is per 100 g, plausible, and within the Atwater tolerance below. Values follow the Polish/EU label convention: `carbs_per_100g` excludes fibre. Spices-aisle products and the named `atwater_exempt` products (e.g. cocoa) are exempt from the tolerance check (see §2).
  - Liquids are stored as grams.
  - Piece products carry `grams_per_piece` (e.g. jajko M ≈ 50 g edible, kromka chleba ≈ 35 g, banan ≈ 120 g edible).
  - Default rounding steps:
    - 1 g for salt, pepper, spices, baking powder, yeast;
    - 5 g for whey protein and oils;
    - 10 g for bulk items.
  - Every one of the 8 aisles has at least one product.
- **Recipes**: adopt research §7's set (the implementer may adjust dishes, but must keep the coverage targets):

  | # | Recipe | Meal types | Prep (min) | Division | Rule-bearing rows |
  |---|---|---|---|---|---|
  | 1 | Jajecznica na maśle z pieczywem | breakfast | 15 | per_component (jajka / pieczywo) | jajka: piece, whole only, `min_amount_g` = 1 egg; pieczywo: piece, half allowed; sól 1 g; all steps `fresh` |
  | 2 | Owsianka proteinowa (overnight) | breakfast, second_breakfast | 10 | per_component (baza / owoce) | płatki 10 g; odżywka białkowa 5 g; banan half allowed; `make_ahead` |
  | 3 | Ciastka proteinowe | second_breakfast, afternoon_snack | 35 | whole_dish | proszek do pieczenia 1 g; kakao with ingredient-level override to 1 g; `make_ahead` |
  | 4 | Kurczak curry z ryżem | lunch, dinner | 40 | per_component (ryż / kurczak / sos) | ryż `cooked_yield_ratio` ≈ 2.5; kurczak ≈ 0.75; curry/sól 1 g |
  | 5 | Makaron z krewetkami | lunch, dinner | 20 | per_component (makaron / krewetki w sosie) | makaron ≈ 2.2 yield; krewetki (frozen aisle); oliwa 5 g |
  | 6 | Leczo z kiełbasą | dinner | 60 | whole_dish | single component; `make_ahead`; produce-heavy, fat-dense |
  | 7 | Twarożek ze szczypiorkiem | second_breakfast, afternoon_snack | 10 | per_component (twarożek / pieczywo) | no cooking; dairy; lean-protein lever |
  | 8 | Zapiekanka makaronowa | (none) | 50 | whole_dish | 0 meal types; bakery/dairy |

- **Steps** carry `timing`. Set `component_id` where a step belongs to one component, and `duration_minutes` where meaningful.
- **Base amounts**: one sensible batch for two people. Every base amount is a multiple of the ingredient's effective rounding step. Piece products' base amounts are a whole multiple of `grams_per_piece`, or a half multiple if `allow_half_pieces`.

#### 2. Seed integrity test

**File**: `supabase/tests/seed_integrity.sql` (new)

**Intent**: Fail loudly if the seed content stops covering a solver rule or becomes internally inconsistent, now and for every future content migration.

**Contract**: `begin; … rollback;`, as postgres, `do $$ … raise exception '<descriptive>' …`, ending with a `raise notice` plus a `select '…passed' as result`. The test reads the `private.seed_*` tables.

- **Counts**: 5 ≤ recipes ≤ 10.
- **Atwater**: every product has `abs(kcal − (4·protein + 4·carbs + 9·fat)) ≤ greatest(0.15·kcal, 15)`, except products in the `spices` aisle and products whose seed UUID is in a short `atwater_exempt uuid[]` list declared in the test (e.g. cocoa). Each exempt entry carries a comment citing its label values (high fibre makes the formula diverge). Exempt items are used at 1–10 g per recipe, so their effect on recipe macros is negligible. Once the content is drafted, run the test and add any other borderline product (e.g. high-fibre bread) to the list with a justification.
- **Structure**:
  - `whole_dish` recipes have exactly 1 component, and `per_component` recipes have ≥ 2;
  - every component has ≥ 1 ingredient;
  - every recipe has ≥ 1 step;
  - `meal_types` has no duplicates;
  - a step's `component_id` (if set) belongs to the same recipe.
- **Amounts**:
  - each base amount is a multiple of the effective rounding step (`coalesce(ingredient.rounding_step_g, product.rounding_step_g)`) for non-piece products;
  - for piece products, base amounts are a multiple of `grams_per_piece`, or of `grams_per_piece / 2` when `allow_half_pieces`;
  - `allow_half_pieces` is only set on piece products;
  - `min_amount_g` on a piece product is a whole multiple of `grams_per_piece`.
- **Coverage**:
  - all 5 meal types appear;
  - all 3 prep buckets (≤ 20, 21–45, > 45) appear;
  - all 8 aisles are used by products;
  - both division modes;
  - ≥ 2 components with `cooked_yield_ratio`;
  - piece ingredients with both `allow_half_pieces` true and false;
  - ≥ 3 ingredients with an effective step of 1 g;
  - ≥ 1 ingredient-level rounding override;
  - ≥ 1 `min_amount_g`;
  - both step timings;
  - ≥ 1 recipe with 0 meal types.
- **Macro diversity** (computed per component from base amounts × per-100 g values): at least one component where protein provides ≥ 50 % of kcal, one where carbs provide ≥ 60 %, and one where fat provides ≥ 50 %.
- **Copy fidelity**:
  - insert a fresh `public.households` row and call `private.seed_household` on it;
  - per-table copy counts equal template counts;
  - every copied ingredient's `product_id` resolves to a product in the same household;
  - calling it a second time leaves the counts unchanged (idempotency);
  - finally, as postgres, `delete from public.households where id = <fresh household>` succeeds, and all five tables have 0 rows for that household (cascade through the composite FKs and the `restrict` product FK).

#### 3. npm script, CI step, allowlist

**File**: `package.json`, `.github/workflows/ci.yml`, `.claude/settings.json`

**Intent**: Run the integrity test with one command, in CI, and without a permission prompt locally.

**Contract**:
- `"test:seed": "supabase db query --linked -f supabase/tests/seed_integrity.sql"`.
- A CI `smoke` job step "Run seed integrity test" right after "Run household isolation test", with the same step-scoped `SUPABASE_ACCESS_TOKEN` env.
- An allowlist entry for `npm run test:seed`, mirroring the existing `test:rls` entries.

### Success Criteria:

#### Automated Verification:

- Content migration applies cleanly: `npx supabase db push`
- Seed integrity test passes: `npm run test:seed`
- Integrity test fails when content is broken. Run a scratch copy that, inside the transaction, sets one whole-dish recipe's `division_mode` to `per_component` (or deletes all `fresh` steps). Confirm a non-zero exit with a descriptive message, then delete the scratch copy.
- Isolation test still passes, now with non-zero seed counts: `npm run test:rls`
- Backfill reached existing households. `npx supabase db query --linked "select count(*) from public.households h where not exists (select 1 from public.recipes r where r.household_id = h.id and r.seed_id is not null)"` returns 0.
- Smoke test passes: `npm run smoke`
- Lint passes: `npm run lint`

#### Manual Verification:

- In the Supabase Table Editor, a household's recipes and ingredients read as plausible Polish dishes with sensible quantities and nutrition.
- The live couple's existing households (and the backfilled smoke accounts) each have the 8 recipes.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: App Layer, Smoke Assertion & Docs

### Overview

Shared types and a thin read service that later slices (S-03, S-05, S-07) build on, a dashboard line confirming the seed, a smoke assertion that guards seeding end-to-end, and documentation of the pattern.

### Changes Required:

#### 1. Shared types

**File**: `src/types.ts`

**Intent**: Add only the types this change uses, consistent with `Household`.

**Contract**:
- `StoreAisle`, `MealType`, `DivisionMode` and `StepTiming` as string-literal unions matching the enum keys.
- `RecipeLibrarySummary { recipeCount: number; productCount: number }`.
- No entity interfaces (`Product`, `Recipe`, …). The first reading slice (S-03/S-05) adds them alongside its queries, so they cannot drift from the schema before anything uses them.

#### 2. Recipe library service

**File**: `src/lib/services/recipes.ts` (new)

**Intent**: The single place that reads recipe/product data, following the household service pattern. RLS scopes the result, so there is no explicit household filter.

**Contract**: `getRecipeLibrarySummary(supabase: SupabaseClient): Promise<RecipeLibrarySummary>` uses head-only counts (`select('*', { count: 'exact', head: true })`) on `recipes` and `products`, and throws on query error. List and detail readers are deliberately left to S-03/S-05.

#### 3. Dashboard line

**File**: `src/pages/dashboard.astro`

**Intent**: Visible proof that a signed-in account got the seed.

**Contract**:
- Call `getRecipeLibrarySummary` next to `getCurrentHousehold`, under the same try/catch-and-log pattern (log label `getRecipeLibrarySummary failed`).
- Render `<p data-testid="library">Library: {n} recipes · {m} products</p>`.
- On failure, render the neutral fallback "Recipe library is unavailable right now.". The page must still return 200.

#### 4. Smoke assertion

**File**: `scripts/smoke.mjs`

**Intent**: Make CI catch a sign-up path that creates accounts but no longer seeds them.

**Contract**: `request()` currently returns only `{ status, location }`, and the step loop (`smoke.mjs:67-70`) compares only those fields. So:
- `request()` also returns `body: await response.text()`;
- `expected` gains an optional `body` RegExp, and the loop also checks `expected.body === undefined || expected.body.test(actual.body)`;
- the existing "dashboard renders for signed-in user" step gets `body: /data-testid="library"[^>]*>\s*Library: [1-9]\d* recipes/`;
- on failure, print the matched `<p data-testid="library">` text, or "library line missing".

#### 5. Docs

**File**: `CLAUDE.md`, `README.md`

**Intent**: Make the seeding mechanism and the new test discoverable for later slices.

**Contract**:
- **CLAUDE.md `## Architecture`**: one bullet. Products/recipes (components, ingredients, steps) are household-scoped copies of `private.seed_*` templates, made by `private.seed_household()` from the sign-up trigger. `seed_household()` seeds only new or empty households: once households can edit or delete seed rows (S-05+), do not re-run it on existing households, because it re-inserts deleted seed rows. Seed content changes go in a new data-only migration that inserts the new templates and copies only those new template rows into existing households with targeted `insert … select` keyed on the new seed ids. Child tables carry `household_id` with composite FKs.
- **CLAUDE.md `## Commands`**: one bullet for `npm run test:seed`.
- **README**: Available Scripts gets `test:seed`. The CI section mentions the integrity step and notes that each smoke run leaves one seeded household (~170 rows) behind, with the cleanup query from Performance Considerations.

### Success Criteria:

#### Automated Verification:

- Type check passes: `npx astro check`
- Lint passes: `npm run lint`
- Build passes: `npm run build`
- Smoke test passes, including the new library assertion: `npm run smoke`

#### Manual Verification:

- Sign up a new account and open `/dashboard`. It shows "Library: 8 recipes · N products".
- A second account in another browser shows the same counts. The rows are its own copies, since the isolation test already proves the separation.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- None. There is no JS test runner, and the only TS added is a count query. Adding a framework is out of scope. Content logic is tested in SQL.

### Integration Tests:

- `supabase/tests/household_isolation.sql` covers:
  - cross-household read isolation;
  - own-household writes only;
  - composite-FK cross-household references rejected;
  - templates and the seed function unreachable for clients;
  - anon denied;
  - trigger-seeded counts;
  - the catch-all over the five tables.
- `supabase/tests/seed_integrity.sql` covers coverage matrix, Atwater, structural/amount rules, macro diversity, copy fidelity and idempotency.
- `npm run smoke` covers sign-up through the seeding trigger and the dashboard showing a non-zero recipe count.

### Manual Testing Steps:

1. `npx supabase db push` (Phase 1), then `npm run test:rls` and `npm run smoke`.
2. `npx supabase db push` (Phase 2), then `npm run test:seed` and `npm run test:rls`, and check the backfill query returns 0.
3. `npm run dev`, sign up two accounts, and confirm each dashboard shows "Library: 8 recipes · N products".
4. Browse one household's recipe rows in the Table Editor for plausibility.

## Performance Considerations

- Each household copy is ~170 rows: ~40 products, 8 recipes, ~20 components, ~60 ingredients, ~40 steps. This adds a few milliseconds to the sign-up transaction and is negligible at MVP scale.
- The Phase 2 backfill scales with the number of existing households (the couple plus accumulated smoke accounts). Even hundreds of households is well under a second's worth of inserts.
- Each CI smoke run leaves one seeded household (~170 rows) behind, on top of its `smoke-<ts>@example.com` account. Cleanup query: `delete from auth.users where email like 'smoke-%@example.com'`; this leaves the households orphaned, since account deletion removes only memberships. Automated cleanup is out of scope.
- Policies use the `in (select …)` initPlan form, as in F-01.
- The component-as-scalable-unit shape keeps S-04's problem to one variable per component per person.

## Migration Notes

- **Order**: `20261007120000_products_and_recipes.sql` (schema + hook, no data), then `20261007120100_seed_products_and_recipes.sql` (template data + backfill).
- **Future content changes**: `private.seed_household()` seeds a *new or empty* household (sign-up trigger, the first backfill in Phase 2). `on conflict (household_id, seed_id) do nothing` prevents duplicates but not resurrection: a re-run re-inserts any seed row the household has deleted. Once households can edit or delete seed rows (S-05+), do not re-run it on existing households. A later content migration inserts its new templates (new stable UUIDs) and copies only those *new* template rows into existing households with targeted `insert … select` keyed on the new seed ids. If repeated backfills become common, add a `private.household_seed_log (household_id, seed_id)` record of past copies and skip ids that were ever copied.
- **Rollback**: restore `private.handle_new_user()` to its F-01 body, drop `private.seed_household`, the `private.seed_*` tables, the five public tables (children first) and the four enums. No other objects depend on them yet.

## References

- Related research: `context/changes/seed-products-and-recipes/research.md`
- Roadmap: `context/foundation/roadmap.md` (F-02; consumers S-03, S-04, S-05, S-06, S-07, S-09, S-10, S-11, S-12)
- PRD: `context/foundation/prd.md` (FR-010, FR-011, FR-012, FR-026, Business Logic)
- Concept: `docs/app-concept-eng.md:75-111`, `:156-191`
- F-01 plan (pattern to copy): `context/archive/2026-10-06-household-data-scope/plan.md`
- Trigger and backfill precedent: `supabase/migrations/20261006120000_household_data_scope.sql:88-135`
- Test template and catch-all: `supabase/tests/household_isolation.sql:10-16`, `:249-287`
- Service pattern: `src/lib/services/household.ts:5-26`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema, Seeding Hook & Isolation Test

#### Automated

- [ ] 1.1 Migration applies cleanly to the hosted project: `npx supabase db push`
- [ ] 1.2 Supabase advisors report no new issues for the new tables/functions
- [ ] 1.3 Extended isolation test passes, including the catch-all over the five new tables: `npm run test:rls`
- [x] 1.4 Isolation test fails when isolation is deliberately broken (scratch copy), then scratch removed — 7edd598
- [ ] 1.5 Smoke test still passes: `npm run smoke`
- [x] 1.6 Lint passes: `npm run lint` — 7edd598

#### Manual

- [ ] 1.7 Dashboard shows five public tables with RLS + four policies each, and empty `private.seed_*` tables
- [ ] 1.8 Newly signed-up account still lands on `/dashboard` with its household line

### Phase 2: Seed Content, Backfill & Integrity Test

#### Automated

- [ ] 2.1 Content migration applies cleanly: `npx supabase db push`
- [ ] 2.2 Seed integrity test passes: `npm run test:seed`
- [x] 2.3 Integrity test fails when content is deliberately broken (scratch copy), then scratch removed — 374ec05
- [ ] 2.4 Isolation test still passes with non-zero seed counts: `npm run test:rls`
- [ ] 2.5 Backfill reached every existing household (query returns 0)
- [ ] 2.6 Smoke test passes: `npm run smoke`
- [x] 2.7 Lint passes: `npm run lint` — 374ec05

#### Manual

- [ ] 2.8 Seeded recipes and ingredients read as plausible Polish dishes with sensible quantities and nutrition
- [ ] 2.9 Existing households (live couple, backfilled smoke accounts) each have the 8 recipes

### Phase 3: App Layer, Smoke Assertion & Docs

#### Automated

- [x] 3.1 Type check passes: `npx astro check` — 6e0504e
- [x] 3.2 Lint passes: `npm run lint` — 6e0504e
- [x] 3.3 Build passes: `npm run build` — 6e0504e
- [ ] 3.4 Smoke test passes, including the library assertion: `npm run smoke`

#### Manual

- [ ] 3.5 New account's dashboard shows "Library: 8 recipes · N products"
- [ ] 3.6 Second account's dashboard shows the same counts

### Implementation Notes (2026-10-07, non-interactive run)

- **Hosted Supabase unreachable from this session.** No `SUPABASE_ACCESS_TOKEN`, no `supabase login`, no `.env`/`.dev.vars`, and the checkout is not linked. Every hosted step stays `[ ]`: `db push` (1.1, 2.1), advisors/`db lint --linked` (1.2), `test:rls` (1.3, 2.4), `test:seed` (2.2), the backfill query (2.5), and `npm run smoke` (1.5, 2.6, 3.4; smoke needs a server backed by the hosted project). Run them in this order before merging: `npx supabase link --project-ref <ref>` → `npx supabase db push` → `npm run test:rls` → `npm run test:seed` → backfill query → `npm run build && npm run preview` + `npm run smoke`.
- **Local substitute verification.** Both migrations, `household_isolation.sql` and `seed_integrity.sql` were executed against PGlite (PostgreSQL 17 in WASM, scratchpad only; no Docker, no local Supabase stack). A minimal Supabase-like bootstrap provided: the roles `anon`/`authenticated`/`service_role`, Supabase's default `public` grants, and `auth.users`/`auth.uid()`. The deliberate-break runs (1.4, 2.3) were done the same way. This proves the SQL is valid and the assertions behave, but it does not replace the hosted runs.
- **Deviation: RESTRICT error code.** `on delete restrict` raises `restrict_violation` (23001), not `foreign_key_violation`. The isolation test's "delete a product still used by an ingredient" assertion catches both codes.
- **Deviation: composite-FK indexes.** Indexes are created on the full composite FK column lists: components `(recipe_id, household_id)`; ingredients `(component_id, household_id)` and `(product_id, household_id)`; steps `(recipe_id, household_id)` and `(component_id, recipe_id, household_id)`. This keeps the Supabase "unindexed foreign keys" advisor quiet. The plan's single-column wording would not have satisfied it. `household_id` alone is covered by the leading column of `unique (household_id, seed_id)`.
- **Phase 2 local results (PGlite).** Steps run: an existing account was inserted before the content migration, then the content migration, then the backfill query (returned 0; 8 recipes per household), then `seed_integrity.sql`, then `household_isolation.sql` (now with non-zero seed counts). All passed. Deliberate breaks each failed with a descriptive message:
  - whole-dish Leczo set to `per_component`;
  - all `fresh` steps deleted;
  - Ryż basmati set to 500 kcal (Atwater).
  
  The 15 % Atwater tolerance is intentionally loose: 400 kcal for rice still passed. The household-delete cascade through the `restrict` product FK works.
- **Seed content as built:**
  - 46 products: 41 used by the recipes, plus 5 extras;
  - 8 recipes (research §7 set, unchanged), 14 components, 68 ingredients, 33 steps.
  
  Only cocoa is in `atwater_exempt`. Spices are exempt by aisle. Ingredient product ids are resolved by name through a session-scoped `pg_temp.seed_product()` helper, which raises on a typo. This keeps the content readable instead of repeating 68 product UUIDs.
- **Phase 3 local results:**
  - `npx astro check` (after `npx astro sync`, as CI does): 0 errors.
  - `npm run lint` and `npm run build` pass.
  - The smoke script passes `node --check`, and the library regex was checked on sample markup: it matches "Library: 8 recipes", and rejects "0 recipes" and the fallback text.
  - The smoke step was renamed to "dashboard renders for signed-in user with seeded library".
  - `getRecipeLibrarySummary` runs the two head-only counts in parallel.
- **Status left at `implementing`.** Hosted verification (1.1–1.3, 1.5, 2.1, 2.2, 2.4–2.6, 3.4) and all manual rows are still pending. Flip `change.md` to `implemented` once they pass.
- **Not done: `.claude/settings.json` allowlist entry for `npm run test:seed`.** The session was not granted permission to edit that file. Add `"Bash(npm run test:seed)"` and `"Bash(npx supabase db query --linked -f supabase/tests/seed_integrity.sql)"` by hand.
