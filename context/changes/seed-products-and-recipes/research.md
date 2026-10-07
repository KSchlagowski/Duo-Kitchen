---
date: 2026-10-07T15:48:48+02:00
researcher: Claude (Opus 5.5) for Kamil Schlagowski
git_commit: bdc36624b01008125a4710d907491b577eb72da8
branch: main
repository: KSchlagowski/Duo-Kitchen
topic: "Ground F-02 seed-products-and-recipes: product database + 5–10 seed recipes with solver-relevant attributes"
tags: [research, codebase, supabase, rls, migrations, seed-data, products, recipes, solver-inputs]
status: complete
last_updated: 2026-10-07
last_updated_by: Claude (Opus 5.5)
---

# Research: Seed products and recipes (roadmap F-02)

**Date**: 2026-10-07T15:48:48+02:00
**Researcher**: Claude (Opus 5.5) for Kamil Schlagowski
**Git Commit**: `bdc36624b01008125a4710d907491b577eb72da8`
**Branch**: main (pushed; `origin/main` contains HEAD)
**Repository**: KSchlagowski/Duo-Kitchen

Permalink base used below: `https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/`

## Research Question

Ground the work in `context/changes/seed-products-and-recipes/change.md`.

`change.md` has only the title "Seed products and recipes" and an empty Notes section. It states no intent, constraints or scoping caveat of its own. The intent therefore comes from the roadmap entry with the same change ID, **F-02** (`context/foundation/roadmap.md`, "F-02: Seed product database and test recipes"):

> **Outcome:** (foundation) a product database with nutrition values and store aisles, plus 5–10 generated seed recipes carrying the attributes the solver needs (rounding step, minimum sensible amount, whole/half-piece rule, raw vs. cooked weight, per-component vs. whole-dish division, make-ahead vs. fresh steps).
> **PRD refs:** FR-010, FR-012, Business Logic (solver inputs) · **Unlocks:** S-03, S-04, S-05, S-07 · **Prerequisites:** F-01 (done)
> **Risk / scoping caveat:** "Scope stays to seed data and the minimum shape — no recipe UI."
> **Unknown (owner: user, non-blocking):** "Is the product database a repo-maintained seed shared by all households, a per-household table, or both (seed + household extensions)?"

## Summary

- **Nothing exists yet for products or recipes.** The only schema is F-01's single migration (`households`, `household_members`, the `private` schema, `private.user_household_ids()` and the sign-up trigger). There is no `seed.sql`, no domain table, no recipe or product type, and no service. F-02 is greenfield on top of a well-defined household RLS pattern.
- **Hard rules shape the design.** CLAUDE.md requires every household-owned table to have `household_id uuid not null`, an index, per-operation `to authenticated` policies through `private.user_household_ids()`, no `anon` policies, and an extended isolation test. The isolation test has an automated **catch-all** ([household_isolation.sql:242-287](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/tests/household_isolation.sql#L242-L287)). It fails CI for any `public` table with a `household_id` column that lacks RLS, lacks a policy for any of SELECT/INSERT/UPDATE/DELETE, or has a policy that doesn't mention `user_household_ids`. Tables **without** a `household_id` column are invisible to the catch-all.
- **Seeding is constrained by the cloud-only rule.** `supabase/seed.sql` is referenced in `config.toml` ([L60-65](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/config.toml#L60-L65)) but does not exist. Seed files are applied by `db reset` (forbidden) or `db push --include-seed` (the flag exists in CLI 2.120.0, verified via `--help`). That makes **seed data inside a migration** the path that matches the mandated workflow (`npx supabase db push`). Migrations are tracked and applied exactly once.
- **The central design decision is data ownership, and it is still open.** PRD FR-003 says linked persons share recipes, FR-024/025 say the agent writes recipes into a household, and the NFR requires household privacy. Together these make **recipes household-owned**, so seed recipes must reach each household somehow. Products are genuinely ambiguous (roadmap Unknown). The concept doc says "kept in the repository", while FR-011 says households and the agent extend it. The FR-025 precedence note ("user-entered products → the app's product database → …") implies two tiers. Three viable options are laid out below with their trade-offs. Working assumption: per-household copies of a repo-maintained template, seeded through the existing sign-up trigger plus a backfill (see [Assumptions](#assumptions-stated-because-this-session-is-non-interactive)).
- **The solver attributes split across four levels** (product, recipe component, recipe ingredient, recipe/step), as tabulated below. The shape must let S-04 treat a component, or a whole-dish recipe, as one scalable unit with fixed internal proportions, and convert raw↔cooked weights for after-cooking splits.
- **Seed content should be a coverage matrix, not just plausible food.** The 5–10 recipes must exercise every solver rule (1 g steps, whole vs. half pieces, raw/cooked, per-component vs. whole-dish, make-ahead vs. fresh), all 5 meal types, all 3 prep-time buckets, all 8 store aisles, and enough macro diversity that a 5-meal day has independent "levers" for S-04 to hit ±10%.

## Detailed Findings

### 1. What F-02 plugs into: the F-01 schema and household pattern

- **Single migration** `supabase/migrations/20261006120000_household_data_scope.sql`:
  - `private` schema, not exposed via the API; `usage` is granted to `authenticated` ([L11-14](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/migrations/20261006120000_household_data_scope.sql#L11-L14)). The API exposes only `public` and `graphql_public` ([config.toml:13](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/config.toml#L13)), so objects in `private` are not reachable through PostgREST.
  - `public.households` / `public.household_members` (`user_id` unique, so one household per person) ([L19-32](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/migrations/20261006120000_household_data_scope.sql#L19-L32)).
  - `private.user_household_ids()`: security definer, `set search_path = ''`, execute only for `authenticated`. It is the one choke point, and S-12 extends it for the agent ([L41-54](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/migrations/20261006120000_household_data_scope.sql#L41-L54)).
  - RLS: select-only policies; client writes revoked; no anon ([L63-83](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/migrations/20261006120000_household_data_scope.sql#L63-L83)).
  - **Sign-up trigger** `private.handle_new_user()` creates a household plus a membership in the sign-up transaction ([L88-111](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/migrations/20261006120000_household_data_scope.sql#L88-L111)). This is the natural hook if seed data is copied per household. A later migration can `create or replace` the function to call a seeding helper.
  - **Idempotent backfill** `do $$ … $$` for pre-existing accounts ([L116-135](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/migrations/20261006120000_household_data_scope.sql#L116-L135)). This is the precedent for backfilling seed data into existing households, including the live couple's and the accumulated `smoke-<ts>@example.com` accounts.
- **CLAUDE.md hard rules** apply directly. These cover RLS on every new table, the `household_id` column and policy form, never querying `household_members` in a policy, extending the isolation test, and `db push` then `npm run test:rls` before merging. The migration filename format is `YYYYMMDDHHmmss_short_description.sql`.

### 2. Solver-relevant attributes: what the shape must carry and where

Sources: PRD FR-009/FR-010/FR-012 and Business Logic; concept doc §5, §6, §10, §11 (`docs/app-concept-eng.md:59-111, 156-191`); roadmap S-03…S-11 outcomes.

| Attribute (PRD/concept wording) | Natural level | Consumer slice | Notes |
|---|---|---|---|
| Nutrition: kcal, protein, fat, carbs | product (per 100 g) | S-04, S-05, S-07 | FR-010: recipe macros are **computed** from products, not stored per recipe. |
| Store aisle (fixed list: produce, dairy, meat & fish, bakery, dry goods, spices, frozen, other) | product | S-09, S-07 | FR-021. Store a **key** (enum/check), not a label: S-14 translates PL/EN. |
| Rounding step (10 g bulk; exactly 1 g salt/baking powder/spices/yeast) | product default, optional override on recipe ingredient | S-04, S-05 (FR-009 shows it) | Concept: "Each ingredient has its own rounding step". A product default covers most cases; an override handles exceptions. |
| Counted in pieces + grams per piece | product | S-04, S-09 | Needed to compute macros of "2 eggs" from per-100 g values. |
| Whole vs. half pieces allowed | recipe ingredient | S-04, S-11 ("podziel na pół") | Concept §6: "split into whole pieces (or halves, **if the recipe allows it**)". This is a recipe-level rule, not a product-level one. |
| Minimum sensible amount ("fried eggs require at least 1 egg") | recipe ingredient and/or recipe (min portion) | S-04, S-06 (FR-007 "minimum sensible calories") | Concept: "of an ingredient **or dish**". S-06's derivation is an open Unknown; storing per-ingredient minimums lets min-calories be derived. |
| Raw vs. cooked weight (rice, pasta, meat) | recipe component (base batch) | S-04 (split after cooking), S-11 | Concept: "weighing can happen before and/or after cooking; the recipe must know the raw weight and the cooked weight". The yield depends on the cooking method, so it is better on the component than on the product. |
| Per-component vs. whole-dish division | recipe (+ component table) | S-04, S-05 | Concept: "A gets 60% of the rice and 70% of the sauce" vs. whole dish. A whole-dish recipe can be modelled as exactly one component. |
| Base quantities (proportions) | recipe ingredient (within component) | S-04, S-09 (unsolved list uses base quantities, see S-09 Unknown) | The solver scales a component (or whole dish) as a unit, so ingredient ratios inside it stay fixed. **Assumption**: the base batch amount is stored, and S-04 picks the scale factor. |
| Steps: make-ahead vs. fresh | recipe step | S-10, S-11 | Concept §8: the evening holds everything possible; the morning holds only what must be fresh. Optional `component_id` / duration help S-10 (whose ordering rule is an open Unknown). |
| 0–2 suggested meal types (breakfast, second breakfast, lunch, afternoon snack, dinner) | recipe | S-03 (hint), S-06 (filter) | Enforce `cardinality ≤ 2`. |
| Cuisine | recipe | S-05, S-06 | Free text vs. enum. Agent imports (S-12) bring arbitrary cuisines, which favours text. |
| Prep time (minutes) | recipe | S-06 (buckets ≤20 / 20–45 / 45+) | Store minutes and derive the bucket. |
| Photo | recipe (nullable URL) | S-05 | Storage bucket and upload belong to S-05/S-12. Seed recipes can ship without photos. |
| Attribution "system" | recipe/product (nullable) | S-12/S-13 | PRD Access Control. Out of F-02 scope unless cheap (see Open Questions). |
| Ratings | separate table | S-06 | Out of scope for F-02. |
| Spice blends, broth option | — | v2 | PRD Deferred. Not modelled. |

### 3. Seeding mechanism under the cloud-only constraint

- **Rule**: no local stack; no `db reset`; migrations are applied with `npx supabase db push`; SQL runs with `npx supabase db query --linked` (CLAUDE.md "Supabase is cloud-only").
- `config.toml` `[db.seed] sql_paths = ["./seed.sql"]` ([L60-65](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/config.toml#L60-L65)), but the file does not exist. Its own comment says it applies "during a db reset".
- `npx supabase db push --help` (CLI 2.120.0) lists `--include-seed` ("Include seed data from your config"). **Unverified:** whether the CLI tracks and skips already-applied seed files on a remote push, or re-runs them, which matters for idempotency.
- **Options:**
  1. **Data in a migration** (`insert … values` or `insert … on conflict do nothing`). This uses the same `db push` workflow already mandated. It is applied exactly once, recorded in migration history, and reviewable in a PR. Content updates go in a new migration.
  2. `seed.sql` + `db push --include-seed`. This keeps data separate from schema but adds a second, less-understood apply path and an idempotency question.
  3. A standalone SQL file run with `db query --linked -f`. This is ad hoc, with no history. The narrowed allowlist (`.claude/settings.json`) would prompt for it every time.
- **Implication for per-household seeding:** if seed rows are copied into each household, the template data must live somewhere a definer function can read. The clean place is **template tables in the `private` schema**, filled by the migration and not reachable via the API. A `private.seed_household(household_id)` function would copy them into `public` household tables. Alternatively, the inserts can sit inline in the function body, which is harder to diff and update. Template tables should explicitly `revoke all … from anon, authenticated`, because `usage` on `private` is granted to `authenticated` ([L14](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/migrations/20261006120000_household_data_scope.sql#L14)).
- **CI gap still applies.** CI runs `test:rls` against the already-deployed schema ([ci.yml:36-43](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/.github/workflows/ci.yml#L36-L43)) and never pushes migrations. Seed data reaches production only through a manual `db push` before merge (F-01 impl-review F2, Fix A).
- **This checkout is not linked.** `npx supabase migration list --linked` returned `ProjectRefNotLinkedError`, and `node_modules` is not installed (no `node_modules/.bin/supabase`). The implementer must run `npm ci` and `npx supabase link --project-ref <ref>` before `db push` / `test:rls`.

### 4. Data ownership of products and recipes: the decision the plan must make

**Recipes are household-owned** under FR-003 (shared by linked persons), FR-024/025 (the agent writes into a household), the NFR on household privacy, and S-06 ratings per household member. So the seed recipes must be either (a) copied into each household, or (b) a global read-only catalog that the app unions with household recipes. Option (b) forces S-05/S-03/S-06/S-13 to deal with two recipe sources, so ratings, plan slots and agent edits would each need two FK targets or a polymorphic reference. That is a poor fit for a one-week MVP.

**Products have three options:**

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A. Global catalog** | `public.products` with no `household_id`; RLS select `to authenticated` only; no client writes; seed via migration | Simplest seed (plain inserts); matches "kept in the repository"; no sign-up-path work | S-07/S-12 must add a second tier later (a household table, or a nullable `household_id` that **conflicts with the "not null" hard rule**); the catch-all test ignores it, so it needs a hand-written test; household recipes would FK to a global product, which is fine |
| **B. Per-household copy** | `public.products` with `household_id not null`; private template copied on household creation (trigger) + backfill | Fully within existing hard rules and catch-all; one FK target; S-07/S-12 insert into the same table; household privacy holds | Seed copies duplicated per household (≈50 rows, trivial at this scale); fixing seed nutrition later needs a migration that also updates existing copies; heavier sign-up transaction (a failure blocks sign-up, which smoke catches); S-01 merge must dedupe two seed sets |
| **C. Hybrid in one table** | `household_id uuid null` (null = catalog); policies `household_id is null or household_id in (select private.user_household_ids())` for select; writes only on own household rows | One table and one FK; seed is a single copy; two tiers as FR-025 implies | Requires **amending the CLAUDE.md hard rule** ("not null") and the catch-all's assumptions; nullable scoping is the classic place for RLS mistakes |

Recipe seeding under B applies equally to recipes. Under A or C, recipes still need per-household copying (or option (b) above), so the sign-up-trigger hook is needed for recipes either way. That tips the balance toward **B for both** (one mechanism, no rule change). See Assumptions.

**Child tables** (recipe components, ingredients, steps): the hard rule says "every household-owned table has `household_id`". The catch-all only checks tables that **have** the column, so a child table without `household_id` would escape it silently. Policies that join through the parent (`exists (select 1 from recipes …)`) would also fail the catch-all's text check only if the column were present. The consistent option is to **denormalise `household_id` onto every child table** and keep it consistent with a composite FK, `(recipe_id, household_id) references recipes (id, household_id)`, which needs a `unique (id, household_id)` on the parent. Policies then stay identical one-liners.

### 5. Isolation test and verification

- The test template is described in the header comment ([household_isolation.sql:10-16](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/tests/household_isolation.sql#L10-L16)): seed a row per household as postgres, impersonate user A, assert A sees only its own rows and can't read or write B's. Everything is rolled back ([L18](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/tests/household_isolation.sql#L18), [L300](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/tests/household_isolation.sql#L300)).
- The test inserts two users into `auth.users` ([L23-26](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/tests/household_isolation.sql#L23-L26)), which **fires the sign-up trigger**. Under option B, both test households are therefore auto-seeded. The test can assert "A has N seed recipes / M products, sees only its own N/M, cannot update or delete B's", with no extra setup.
- Catch-all ([L249-287](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/supabase/tests/household_isolation.sql#L249-L287)) covers any new `household_id` table automatically. Global tables (option A, or private templates) need explicit assertions: anon denied; authenticated read-only (A); not readable at all for templates in `private`.
- **Seed-integrity checks** don't exist yet, and no JS test runner exists (F-01 plan: "None — no JS test runner exists"). These checks would cover: every ingredient's product has nutrition; Atwater sanity per product (`|kcal − (4P + 4C + 9F)|` within ~10–15%); piece products have grams-per-piece; `meal_types` ≤ 2; per-component recipes have ≥ 2 components; every recipe has ≥ 1 step; and the seed count is 5–10. They fit as either another rolled-back SQL file (`supabase/tests/…sql` + an npm script + a CI step, mirroring `test:rls` at [package.json:14](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/package.json#L14)) or extra blocks in the existing file. Many invariants can instead be DB `check` constraints, which is cheaper and permanent.
- `npm run smoke` asserts only that `/dashboard` returns 200 after sign-up ([scripts/smoke.mjs:56](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/scripts/smoke.mjs#L56)). It is the guard that a heavier sign-up trigger (option B) still lets accounts be created.

### 6. App layer and type conventions

- `src/types.ts` holds hand-written `Household` / `HouseholdMember` ([types.ts:1-10](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/src/types.ts#L1-L10)) in camelCase, mapped from snake_case in the service ([services/household.ts:5-26](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/src/lib/services/household.ts#L5-L26)). F-01 explicitly deferred `supabase gen types`. With ~6 tables plus enums, generated types become more attractive. This is the planner's call.
- Services take a `SupabaseClient` and rely on RLS for scoping, with no explicit household filter ([services/household.ts:4](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/src/lib/services/household.ts#L4)). Pages must not call `supabase.from` directly (CLAUDE.md).
- The roadmap caveat says **"no recipe UI"** in F-02. A minimal visible confirmation in the F-01 style is optional (F-01 added a dashboard line, [dashboard.astro:13](https://github.com/KSchlagowski/Duo-Kitchen/blob/bdc36624b01008125a4710d907491b577eb72da8/src/pages/dashboard.astro#L13)), for example "N recipes · M products". A read service (`src/lib/services/recipes.ts`) and types would be the first thing S-03/S-05 need. Including them is a scope choice.
- **Computed macros (FR-010):** compute either in TypeScript (the solver in S-04 is pure JS/WASM on the edge anyway, per `tech-stack.md`) or in a SQL view. **Gotcha:** a plain Postgres view runs with the owner's rights and **bypasses RLS**. Any view over household tables must be `create view … with (security_invoker = true)`, and a view is not covered by the catch-all.

### 7. Seed content: suggested coverage matrix

Recipe content is Polish only (FR-026), and FR-012 asks for "plausible products and nutrition values". The concept's examples (protein cookie, shrimp, fried eggs, rice + sauce + meat) are natural anchors. This is an illustrative set the plan can adopt or replace:

| # | Recipe (PL) | Meal types | Prep bucket | Division | Exercises |
|---|---|---|---|---|---|
| 1 | Jajecznica na maśle z pieczywem | breakfast | ≤20 | per component (eggs / bread) | eggs whole pieces + min 1–2; bread slices (halves allowed); salt 1 g; **fresh (morning)** step |
| 2 | Owsianka proteinowa (overnight) | breakfast, second breakfast | ≤20 | per component (base / fruit topping) | oats 10 g step; whey 5 g step; banana halves; **make-ahead** |
| 3 | Ciastka proteinowe | second breakfast, afternoon snack | 20–45 | whole dish | baking powder/cocoa 1 g; piece output; make-ahead |
| 4 | Kurczak curry z ryżem | lunch, dinner | 20–45 | per component (rice / chicken / sauce) | rice raw→cooked; chicken raw→cooked; spices 1 g; split after cooking |
| 5 | Makaron z krewetkami | lunch, dinner | ≤20 | per component (pasta / shrimp sauce) | pasta raw→cooked; frozen aisle; olive oil small step |
| 6 | Leczo z kiełbasą | dinner | 45+ | whole dish | whole-dish only; make-ahead; produce-heavy |
| 7 | Twarożek ze szczypiorkiem | second breakfast, afternoon snack | ≤20 | per component | no cooking; dairy; high-protein lever |
| 8 | Zapiekanka makaronowa | (none, 0 meal types) | 45+ | whole dish | 0 meal types edge case; bakery/dairy |

Coverage targets the plan should keep, whatever the recipes are:
- all 5 meal types
- all 3 prep buckets
- every one of the 8 aisles referenced by at least one product
- both division modes
- at least 2 raw/cooked components
- both whole-only and half-allowed pieces
- at least 3 ingredients with a 1 g step
- both make-ahead and fresh steps
- at least one recipe with 0 meal types
- **macro diversity**: lean-protein, carb-dense and fat-dense components, so a 5-meal day has independent levers. A day built only from whole-dish recipes gives S-04 one degree of freedom per meal, which may be infeasible at ±10%.

Products: roughly 35–50 rows. Nutrition per 100 g, with values within Atwater tolerance. Canonical unit grams (liquids treated as g, or a display unit `ml` with density ≈ 1; a decision for the plan). Piece products carry grams per piece, for example egg M ≈ 50–55 g edible. Use **stable hard-coded UUIDs** or unique names for seed rows, so tests, fixtures and future update migrations can address them deterministically. Deterministic IDs also help the NFR "same input → same output".

## Code References

- `supabase/migrations/20261006120000_household_data_scope.sql:11-14` – `private` schema + grants
- `supabase/migrations/20261006120000_household_data_scope.sql:41-54` – `private.user_household_ids()` (the RLS choke point; S-12 extends it)
- `supabase/migrations/20261006120000_household_data_scope.sql:88-111` – sign-up trigger `private.handle_new_user()` (hook for per-household seeding)
- `supabase/migrations/20261006120000_household_data_scope.sql:116-135` – idempotent backfill precedent
- `supabase/tests/household_isolation.sql:10-16` – template for testing new household tables
- `supabase/tests/household_isolation.sql:23-26` – test users inserted into `auth.users` (fires the trigger)
- `supabase/tests/household_isolation.sql:249-287` – catch-all for `household_id` tables (RLS, 4 ops, helper text, no anon)
- `supabase/config.toml:13` – API exposes `public`, `graphql_public` only
- `supabase/config.toml:60-65` – `[db.seed]` → `./seed.sql` (absent; reset-only)
- `package.json:14` – `test:rls` script (pattern for any new SQL test script)
- `.github/workflows/ci.yml:36-43` – CI links and runs `test:rls` against the deployed schema (no `db push`)
- `.claude/settings.json` – allowlist narrowed to `npm run test:rls` + the exact isolation-test command
- `src/types.ts:1-10` – hand-written shared types
- `src/lib/services/household.ts:4-26` – service pattern (RLS-scoped, snake→camel mapping)
- `src/pages/dashboard.astro:13-19` – F-01's visible confirmation + logged fallback
- `scripts/smoke.mjs:56` – sign-up → dashboard 200 (guards the trigger path)
- `docs/app-concept-eng.md:75-111` – solver constraints and rounding rules
- `docs/app-concept-eng.md:156-191` – recipe contents, seed data, product database "kept in the repository"

## Architecture Insights

- **One choke point, one rule.** All household access goes through `private.user_household_ids()`. A new table that follows the hard rule is automatically policed by the catch-all. A table that deviates (global, nullable `household_id`, no `household_id` on child tables) silently leaves the automated net, which is a strong reason to stay inside the rule.
- **The `private` schema is the established place for non-API objects** (definer functions now; template/seed tables would fit there too).
- **Definer-function discipline** (from F-01 plan): `security definer`, `set search_path = ''`, fully qualified names, revoke `execute` from `public`/`anon`. A seed function invoked only by the trigger needs no grants.
- **Enumerations**: the fixed aisle list and meal types are closed sets. A Postgres enum (or a `check (… in (…))`) stores language-neutral keys, and S-14 maps them to PL/EN labels. Cuisine is open-ended, so text fits it better.
- **Fixed proportions inside a scalable unit** (component, or a whole dish as one component) is the shape that keeps S-04's LP small: one variable per component per person rather than per ingredient. That is significant for the edge CPU budget (S-04 Unknown).
- **Determinism**: stable seed IDs and an explicit `position` ordering on components, ingredients and steps make solver and scheduler inputs reproducible (PRD NFR).

## Historical Context (from prior changes)

- `context/archive/2026-10-06-household-data-scope/plan.md`: established the RLS pattern, the `private` schema, the definer discipline, and the rolled-back SQL test. It explicitly put "any domain table (products, recipes, plans)" out of scope for F-02 and later work, and deferred generated types.
- `context/archive/2026-10-06-household-data-scope/plan-brief.md`, Open Risks: "A broken trigger blocks sign-up (caught by smoke)". This applies directly if F-02 extends the trigger.
- `context/archive/2026-10-06-household-data-scope/reviews/impl-review.md`:
  - F1 narrowed the Claude allowlist, so ad-hoc `db query --linked` now prompts.
  - F2 (Fix A): CI tests the deployed schema, so run `db push` and then `test:rls` before merging. The catch-all was added then.
  - F3: the Supabase access token is scoped to individual steps.
- `context/foundation/shape-notes.md:189` (Open Q 4, resolved in the PRD 2026-10-06): "Seed recipes: generated or taken from the internet, and how many? … Must be resolved before the solver can be tested". This resolved to "~5–10 generated test recipes with plausible products and nutrition values" (PRD FR-012).
- `context/foundation/shape-notes.md:202`: "The product nutrition database is kept in the repository."
- `context/foundation/tech-stack.md`: the solver and scheduler must be pure JS/WASM on Cloudflare's edge, which is relevant to where macros are computed.

## Related Research

- None. This is the first `research.md` in `context/changes/**` or `context/archive/**`. F-01 went straight to plan.

## Assumptions (stated because this session is non-interactive)

1. **Intent = roadmap F-02.** `change.md` carries no notes, so the outcome, PRD refs and the caveat "seed data and the minimum shape — no recipe UI" are taken from `roadmap.md` F-02.
2. **Recipes are household-owned** (FR-003/024/025 and the privacy NFR), and seed recipes are copied into every household, including existing ones via a backfill.
3. **Working assumption for products: option B (per-household copy from a `private` template)**, because it stays inside the CLAUDE.md hard rules and the isolation catch-all and reuses the mechanism recipes need anyway. Option A or C is equally viable if the user prefers a single shared catalog. C requires amending the "not null" hard rule. **This is the user-owned roadmap Unknown and should be confirmed during planning.**
4. **Seed data ships inside migration(s)** applied with `npx supabase db push`, not `seed.sql`. `config.toml`'s `[db.seed]` is left untouched.
5. **The scope includes only the minimum shape the listed attributes need**: products, recipes, components, ingredients and steps. Ratings, plans, photos/storage, the "system" identity, spice blends and broth are out of scope.
6. **A thin read service and types are optional.** They are reasonable if the plan wants a visible check, but they are not required by the roadmap outcome.

## Open Questions

1. **Product ownership** (A global / B per-household copy / C hybrid nullable): the roadmap Unknown, owned by the user. It drives S-07 and S-12.
2. **Seed propagation when seed data changes later**: should an update migration also rewrite existing household copies (under B), and how would user edits to a seed row survive that? A `source`/`seed_id` column linking a copy to its template would make this tractable.
3. **S-01 interaction**: under per-household seeding, a partner joining a household brings a duplicate seed set. S-01's "merge vs. discard" Unknown should account for it, for example by discarding seed-origin rows.
4. **Where minimum sensible amount lives**: per ingredient, per recipe (min portion), or both. This also determines how S-06 derives "minimum sensible calories".
5. **Raw/cooked representation**: a ratio on the component, or a stored cooked weight for the base batch, plus an optional product-level default yield.
6. **Units**: grams only, or grams + ml (density) + pieces as display units.
7. **Macro computation location**: TypeScript in the service/solver, or a `security_invoker` SQL view (needed if S-06 filters by calories in SQL).
8. **Attribution columns** (`created_by` / "system"): add now as nullable, or leave entirely to S-07/S-12.
9. **Seed-integrity verification**: DB `check` constraints only, or also a rolled-back SQL integrity test with its own npm script and CI step.
10. **Unverified tooling detail**: the semantics of `supabase db push --include-seed` against a remote project (tracking and re-run). This only matters if option 2 in §3 is chosen.
