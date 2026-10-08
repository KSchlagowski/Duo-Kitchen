# Browse the Recipe Library (S-05) Implementation Plan

## Overview

S-05 lets a signed-in user browse the F-04 public recipe library as a grid of cards and open any recipe's full detail: ingredients with quantities, computed macros and rounding step; make-ahead vs. fresh steps; divisible components or a whole-dish flag; raw/cooked weights; meal types; cuisine; prep time (PRD FR-005, FR-009, FR-010, FR-012). It is a **read-only, zero-migration slice**: two SSR `.astro` pages over the existing library tables, a service, pure macro helpers, and smoke assertions that pin computed output against seed data.

S-03 (`plan-three-day-grid`) is being built in parallel and merges first. Every shared-file edit is kept in its own S-05 block, and the final phase is a rebase-and-reverify gate that only runs after S-03 is on `main`.

> Non-interactive planning session: no questions were asked. Every decision a question would have settled is stated as an **Assumption** (A1–A10, under "Assumptions & Decisions").

## Current State Analysis

- The library schema (`supabase/migrations/20261008150000_shared_recipe_library.sql:294-373`) already holds everything S-05 shows, **except a photo**. Each table has one `select … to authenticated using (true)` policy, and writes are revoked. SSR reads use the user's cookie session (`src/lib/supabase.ts`), so no definer function or RLS change is needed.
- Seed content: 8 recipes, 14 components, 69 ingredients, 33 steps, 46 products (`supabase/tests/seed_integrity.sql:328-331`). The UI must handle these shapes:
  - `whole_dish` recipes with one component, and `per_component` recipes with 2–3 components;
  - a recipe with 0 meal types (`Zapiekanka makaronowa`);
  - piece products with and without halves;
  - ingredient-level rounding overrides;
  - steps with no component, and steps with no duration.
- `src/lib/services/recipes.ts` has only `getRecipeLibrarySummary()`. S-03 will add `listRecipes()` to the same file.
- `src/types.ts:21-30` has the enum unions (`MealType`, `DivisionMode`, `StepTiming`) and `RecipeLibrarySummary`. No label map exists yet.
- `src/middleware.ts:4`: `PROTECTED_ROUTES = ["/dashboard", "/targets"]`, matched with `startsWith`.
- No unit-test runner exists. The verification seam is `scripts/smoke.mjs`, which pins exact formatter strings, as S-02 does with `formatMacroTargets()` (`src/lib/services/macro-targets.ts:72-75`).
- This worktree is **not linked** to Supabase (`LegacyProjectNotLinkedError`), so it must be linked before running `test:rls` or `test:seed`.
- This worktree also has **no `node_modules`, `.env` or `.dev.vars`** (they exist only in the main checkout `D:/Duo-Kitchen`). Without them `npm run lint` fails immediately, and the dev server / preview render every page "unavailable" (both env fields are `optional: true` in `astro.config.mjs:19-20`, so the build still succeeds). See "Worktree setup (before Phase 1)" in Critical Implementation Details.

## Desired End State

- `/recipes` (protected) lists every library recipe as a card, sorted by name in Polish collation. Each card shows:
  - a photo slot with a deterministic placeholder;
  - name, cuisine, prep time and meal types;
  - an empty named `ratings` slot;
  - a link to `/recipes/<id>`.
- `/recipes/<id>` (protected) shows the full detail of any library recipe, seed or not:
  - division mode ("Divisible components" or "Whole dish only");
  - each component with its ingredients: grams, piece count where relevant, effective rounding step, min amount, per-ingredient macros, component subtotal, and raw → ≈ cooked weight where `cooked_yield_ratio` is set;
  - a whole-batch macro total;
  - steps split into Make ahead and Fresh, each with duration and component when present;
  - meal types, or "No suggested meal type".
- A malformed or unknown id returns **404**. On `/recipes/<id>`, a failed read renders "Recipe library is unavailable right now" with status 500, never "not found" or "empty". `/recipes` shows the same text with status 200, like the dashboard and targets pages.
- The dashboard has a "Browse recipes" link.
- The smoke test proves:
  - anon visitors are redirected;
  - the card count is ≥ 8;
  - the exact computed totals and cooked line of `Kurczak curry z ryżem` match values taken from an independent SQL oracle;
  - the whole-dish and zero-meal-type renderings work;
  - both kinds of bad id return 404.
- `npm run lint`, `npx astro check`, `npm run build`, `npm run test:rls`, `npm run test:seed` and `npm run smoke` all pass after rebasing onto a `main` that already contains S-03.

### Key Discoveries:

- `recipe_steps` has FKs to both `recipes` and `recipe_components` (`…shared_recipe_library.sql:358-371`). A nested `recipes → recipe_components` embed may therefore raise PGRST201 (ambiguous relationship). **Decision: flat parallel queries**, so the question never comes up (A4).
- A non-UUID path segment makes PostgREST raise `22P02`. Validate with zod `z.uuid()` (zod `^4.6.5`) before querying. Seed ids `5eed000N-0000-4000-8000-…` are RFC-valid.
- `maybeSingle()` returning `null` means not found, and a thrown error means unavailable (`src/lib/services/household.ts:6-16`).
- The Row→DTO idiom (snake_case `…Row` interface, explicit `.select(...)`, `if (error) throw error`, camelCase DTO) is in `src/lib/services/macro-targets.ts:8-34`.
- Effective rounding step = `ingredient.rounding_step_g ?? product.rounding_step_g`, the same `coalesce` as `seed_integrity.sql:125-131`. The seed test guarantees piece divisibility (`seed_integrity.sql:136-146`).
- `seed_integrity.sql:268-290` computes macro-derived kcal shares in SQL, not `kcal_per_100g` totals, so it is **not** the oracle for the smoke pins. The literal oracle queries are in Critical Implementation Details.
- The F-02 plan expected "S-05 adds `photo_url` with the storage work" (`context/archive/2026-10-07-seed-products-and-recipes/plan.md:154`). This plan deliberately revises that (A1).

## What We're NOT Doing

- No migration, no photo column, no Storage bucket (A1). The photo column and its access policy arrive with the first slice that can supply a photo (S-12, or S-07's write path).
- No ratings table, no rating fields in DTOs, and no placeholder thumbs or "no ratings yet" text. Only the empty named slot (S-06).
- No filters, sorting controls or search (S-06), and no React islands.
- No write path of any kind (S-07), and no `/api/*` route.
- No plan tables, plan pages or plan files (S-03). S-03's roadmap rows are never edited.
- No per-serving or per-person split of macros. Totals are for one whole base batch (S-04's job).
- No changes to `supabase/tests/*.sql`. Both tests are only **run**.
- No unit-test runner (vitest etc.).
- No PL/EN localisation switch (S-14). Labels live in one map so S-14 can swap them.

## Assumptions & Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                        | Rationale                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **No photo column in S-05.** The card has a fixed-aspect photo slot with a deterministic placeholder: a gradient picked by hashing `cuisine`, plus the recipe's initial. `RecipeCard.photoUrl` is typed `string \| null` and is always `null` for now.                                                                                                          | A column that is null on 100% of rows adds no value. No write path exists to fill it. Zero migrations remove the S-03 timestamp race. Storage access ("never anon" vs. a public bucket) is a separate security decision for the slice that uploads. This revises the F-02 note. Record it in CLAUDE.md. |
| A2  | Cards show name, cuisine, prep time and meal types. **No computed kcal on cards.**                                                                                                                                                                                                                                                                              | FR-005 does not ask for it, and it would need the full ingredient join for every recipe.                                                                                                                                                                                                                |
| A3  | Macros are for **one whole base batch**, labelled "Whole batch". Every displayed value is rounded with `Math.round`: kcal and grams become integers, matching `formatMacroTargets()`.                                                                                                                                                                           | The schema has no servings concept, and the split belongs to S-04. Integers keep the smoke pin free of float noise.                                                                                                                                                                                     |
| A4  | `getRecipeDetail` runs **three flat parallel queries** (`Promise.all`) and assembles the result in TS:<br>1. recipe `.eq("id").maybeSingle()`;<br>2. `recipe_components` with nested `recipe_ingredients(…, products(…))`, filtered by `recipe_id`;<br>3. `recipe_steps` filtered by `recipe_id`.<br>Ordering by `position` happens in TS for all three levels. | This avoids the PGRST201 junction ambiguity without relying on Postgres-default FK names. `recipe_components → recipe_ingredients → products` is unambiguous. Three round-trips are fine at this scale.                                                                                                 |
| A5  | Card order: `localeCompare(b, "pl")` in TS, with no `.order()` dependency on DB collation.                                                                                                                                                                                                                                                                      | The collation of the hosted DB is unverified. A sort in TS is deterministic.                                                                                                                                                                                                                            |
| A6  | **English chrome**: "step 10 g", "4 pcs (200 g)", "3½ pcs (105 g)", "min. 50 g", "Make ahead" / "Fresh", "Whole dish only" / "Divisible components". Recipe content (names, cuisines, step text) renders as stored, in Polish.                                                                                                                                  | This matches the existing English dashboard and targets pages. S-14 localises later.                                                                                                                                                                                                                    |
| A7  | A bad id (malformed, or valid but absent) returns status 404 with a small "Recipe not found" body via `Astro.response.status = 404`. A read error returns 500 with the "unavailable" body.                                                                                                                                                                      | Both states stay distinct and testable. There is no custom 404 page.                                                                                                                                                                                                                                    |
| A8  | The ratings seam is a named Astro slot, `<slot name="ratings" />`, on `RecipeCard.astro`. It sits in a wrapper `<div data-slot="ratings">` that renders only when `Astro.slots.has("ratings")`.                                                                                                                                                                 | S-06 passes `<… slot="ratings" />` from the page without restructuring the card. Nothing about ratings is displayed today.                                                                                                                                                                              |
| A9  | Pure macro and formatting functions live in a new `src/lib/services/recipe-macros.ts`, with no Supabase import.                                                                                                                                                                                                                                                 | CLAUDE.md puts domain logic shared by more than one consumer in `src/lib/services/`. S-04's solver needs the same arithmetic.                                                                                                                                                                           |
| A10 | **Dedupe rule with S-03** (applied in Phase 4). If S-03's `listRecipes()` selects every field `getRecipeCards()` needs, `getRecipeCards()` becomes a thin mapper over it. Otherwise both stay, with a one-line comment on `getRecipeCards()` explaining what it adds. Never rename or change S-03's function or type.                                           | S-03 merges first and owns `listRecipes()`. S-05 adapts to it.                                                                                                                                                                                                                                          |

## Implementation Approach

The work runs bottom-up: data access and pure helpers first, then the pages, then the smoke test and docs, then a gated rebase. Phases 1–3 can complete and be pushed on the S-05 branch while S-03 is still in flight. Phase 4 waits for S-03 to land on `main`.

## Critical Implementation Details

- **Smoke pins must come from SQL, not from the page.** Copying the rendered output into the test would make the test tautological. Before pinning the `Kurczak curry` totals and cooked line, run the literal oracle queries below with `npx supabase db query --linked`; the pins are **exactly** their output. Do not adapt `seed_integrity.sql:268-290` instead: that block sums macro-derived kcal shares (`protein × 4`, `carbs × 4`, `fat × 9`) over `pg_temp.seed_*` views, never reads `kcal_per_100g` and has no cooked-weight term, so it computes a different quantity from `formatMacroTotals()`. Put the queries in a comment above the fixture so the next person can re-derive them.
  ```sql
  -- recipe-total (whole batch)
  select round(sum(i.base_amount_g * p.kcal_per_100g    / 100)) as kcal,
         round(sum(i.base_amount_g * p.protein_per_100g / 100)) as protein_g,
         round(sum(i.base_amount_g * p.fat_per_100g     / 100)) as fat_g,
         round(sum(i.base_amount_g * p.carbs_per_100g   / 100)) as carbs_g
  from public.recipe_ingredients i
  join public.recipe_components c on c.id = i.component_id
  join public.products p on p.id = i.product_id
  where c.recipe_id = '5eed0002-0000-4000-8000-000000000004';
  -- component-cooked lines
  select c.position, c.name, sum(i.base_amount_g) as raw_g,
         round(sum(i.base_amount_g) * c.cooked_yield_ratio) as cooked_g, c.cooked_yield_ratio
  from public.recipe_components c
  join public.recipe_ingredients i on i.component_id = c.id
  where c.recipe_id = '5eed0002-0000-4000-8000-000000000004' and c.cooked_yield_ratio is not null
  group by c.id order by c.position;
  ```
  Expected cooked lines: Ryż `Raw 161 g → cooked ≈ 403 g (×2.50)` (an exact `.5` case, 402.5 → 403 — `research.md` §6's "~402" is wrong and must not be copied) and Kurczak `Raw 416 g → cooked ≈ 312 g (×0.75)`. JS `Math.round` and Postgres `round(numeric)` both round half up; if JS and SQL still disagree at an exact `.5`, normalise in the helper first (for example `Math.round(Number(x.toFixed(6)))`) rather than editing the pin.
- **Worktree setup (before Phase 1)**: run `npm ci`; copy `.env` and `.dev.vars` from `D:/Duo-Kitchen` (both are gitignored — never commit them); run `npx supabase link --project-ref tvmfkhnxxsnmvogplknz`. The link moves this early because Phase 1's manual check already reads the hosted DB; the oracle query, `test:rls` and `test:seed` also fail without it.
- **Middleware `startsWith` covers `/recipes/<id>`**, so one `"/recipes"` entry protects both routes. Append it at the end of the array, so the S-03 conflict resolves as a plain union.

## Phase 1: Types, Label Map, Macro Helpers and Service Readers

### Overview

Add the S-05 DTOs, the single label map, the pure macro and format helpers, and the two Supabase readers. No UI yet.

### Changes Required:

#### 1. S-05 DTOs

**File**: `src/types.ts`

**Intent**: Add the S-05 entity types in one commented block after `RecipeLibrarySummary`. The names are chosen so they do not collide with S-03's likely list type, with `RecipeLibrarySummary`, or with S-02's `MacroTargets*`.

**Contract**:

- `MacroTotals { kcal; proteinG; fatG; carbsG }`. Keep it separate from `MacroTargetsInput`: the shape is the same, but the meaning differs (computed amount vs. target).
- `RecipeCard { id; name; cuisine; prepMinutes; mealTypes: MealType[]; divisionMode: DivisionMode; photoUrl: string | null }`. No rating fields.
- `RecipeDetailIngredient { id; position; productName; amountG; effectiveRoundingStepG; minAmountG: number | null; gramsPerPiece: number | null; allowHalfPieces; macros: MacroTotals }`.
- `RecipeDetailComponent { id; position; name; cookedYieldRatio: number | null; ingredients; totals: MacroTotals; rawWeightG; cookedWeightG: number | null }`.
- `RecipeDetailStep { id; position; instruction; timing: StepTiming; componentName: string | null; durationMinutes: number | null }`.
- `RecipeDetail extends RecipeCard { components; steps; totals: MacroTotals }`.

#### 2. Enum label map

**File**: `src/lib/recipe-labels.ts` (new)

**Intent**: Map each enum to its English label in one place, so S-14 can swap it later.

**Contract**:

- `Record<MealType, string>`: `breakfast` "Breakfast", `second_breakfast` "Second breakfast", `lunch` "Lunch", `afternoon_snack` "Afternoon snack", `dinner` "Dinner".
- `Record<DivisionMode, string>`: "Divisible components" / "Whole dish only".
- `Record<StepTiming, string>`: "Make ahead" / "Fresh".
- `formatMealTypes(types)`: labels joined with `·`, or `"No suggested meal type"` when the list is empty.

#### 3. Pure macro and formatting helpers

**File**: `src/lib/services/recipe-macros.ts` (new)

**Intent**: Hold the FR-010 arithmetic and the deterministic display strings the smoke test pins. There is no I/O in this module.

**Contract**:

- `ingredientMacros(amountG, product per-100g values): MacroTotals`, computed as `amount × per100 / 100`, unrounded.
- `sumMacros(list): MacroTotals`.
- `cookedWeight(rawG, ratio | null): number | null`.
- `formatMacroTotals(t)` → `"<kcal> kcal · P <p> g · F <f> g · C <c> g"`, all `Math.round`ed. This is the same shape as `formatMacroTargets()`, and the smoke test matches it exactly.
- `formatCookedLine(rawG, cookedG, ratio)` → `"Raw <raw> g → cooked ≈ <cooked> g (×<ratio.toFixed(2)>)"`, with integer grams. The smoke test matches it exactly.
- `formatIngredientAmount(amountG, gramsPerPiece, allowHalfPieces)`:
  - `"<n> g"` when there is no piece weight;
  - `"<count> pcs (<g> g)"` when the count is whole;
  - `"<int>½ pcs (<g> g)"` (or `"½ pc"`) when the count is a half and halves are allowed;
  - plain grams for any other non-whole count. That is a defensive case for non-seed rows.
- `formatRoundingStep(g)` → `"step <g> g"`.

#### 4. Service readers

**File**: `src/lib/services/recipes.ts`

**Intent**: Add `getRecipeCards()` and `getRecipeDetail(id)` below `getRecipeLibrarySummary()`, in a separately commented S-05 block. Follow the Row→DTO idiom.

**Contract**:

- `getRecipeCards(supabase): Promise<RecipeCard[]>`:
  - selects `id, name, cuisine, prep_minutes, meal_types, division_mode`;
  - throws on error;
  - sorts by `name.localeCompare(…, "pl")`;
  - sets `photoUrl: null`.
- `getRecipeDetail(supabase, id): Promise<RecipeDetail | null>`:
  - runs the three parallel queries from A4;
  - throws if any query errors;
  - returns `null` when the recipe row is absent;
  - sorts components, ingredients and steps by `position`;
  - resolves `effectiveRoundingStepG = ingredient.rounding_step_g ?? product.rounding_step_g`;
  - maps step `component_id` to the component name;
  - computes per-ingredient, per-component and recipe totals with the helpers, plus `rawWeightG` (the sum of the component's `base_amount_g`) and `cookedWeightG`.
- The id is assumed valid. Validation is the page's job.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`

#### Manual Verification:

- A temporary `console.log` of `getRecipeDetail` for `5eed0002-0000-4000-8000-000000000004`, run from the dev server, shows 3 components in position order, nested ingredients with product names, and steps of both timings with no PGRST201 error. Remove the log afterwards.

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 2.

---

## Phase 2: Pages, Card Component, Route Protection and Dashboard Link

### Overview

Render the card grid and the detail view as SSR `.astro` pages with no islands. Protect them, and link to them from the dashboard.

### Changes Required:

#### 1. Recipe card component

**File**: `src/components/recipes/RecipeCard.astro` (new)

**Intent**: A glass card in the existing visual language (`rounded-2xl border border-white/10 bg-white/10 backdrop-blur-xl`) with five parts:

- a fixed-aspect photo slot: an `<img>` when `photoUrl` is set, otherwise the A1 placeholder;
- the name, linking to `/recipes/<id>`;
- the cuisine, prep time ("40 min") and meal types line;
- a small "Whole dish only" chip when relevant;
- the A8 ratings slot.

Conditional classes go through `cn()`.

**Contract**: Props are `{ recipe: RecipeCard }`. The root element has `data-testid="recipe-card"`, and the link's `href` is `/recipes/${id}`. The named slot `ratings` renders only when it is filled.

#### 2. Library page

**File**: `src/pages/recipes/index.astro` (new)

**Intent**: Fetch `getRecipeCards()` in a `try/catch` that `console.error`s (with the existing eslint-disable comment) and leaves the result `null`, following the `targets.astro` pattern. Render a responsive grid of `RecipeCard`s, plus a "Back to dashboard" link.

**Contract**:

- A heading `<p data-testid="recipe-count">` reads `"<n> recipes"`.
- Three states stay distinct: `null` → `"Recipe library is unavailable right now"`; `[]` → `"No recipes yet"`; otherwise the grid.
- `/recipes` keeps status 200 with the unavailable text, matching `dashboard.astro` / `targets.astro`. Only the detail page sets 500.
- Import the DTO under an alias, `import type { RecipeCard as RecipeCardData } from "@/types"`, next to `import RecipeCard from "@/components/recipes/RecipeCard.astro"`. Without it the two `RecipeCard` names are a duplicate identifier and `astro check` fails. Keep the DTO name itself: `RecipeDetail extends RecipeCard` and the CLAUDE.md bullet use it.

#### 3. Detail page

**File**: `src/pages/recipes/[id].astro` (new)

**Intent**: Validate `Astro.params.id` with `z.uuid()`. If it is invalid, set status 404 and render "Recipe not found" without querying. Otherwise call `getRecipeDetail`: an error gives status 500 and the "unavailable" body; `null` gives status 404. On success, render:

- a header with name, cuisine, prep time, meal types (`formatMealTypes`) and division label;
- a whole-batch total;
- the component sections, each listing its ingredients (amount, step, optional "min. N g", per-ingredient macros), its subtotal and the cooked line when the ratio is set. For `whole_dish`, list the single component's ingredients without a component heading;
- two step sections, Make ahead and Fresh, ordered by position, each step showing "(N min)" and "— <component>" when present. An empty section shows "—";
- a "Back to recipes" link.

The page title is the recipe name.

**Contract**: These are stable `<p data-testid>`s that hold exactly the formatter output:

- `recipe-name`;
- `recipe-division` (division label);
- `recipe-meal-types` (`formatMealTypes` output);
- `recipe-total` (`formatMacroTotals` of the whole batch);
- `component-cooked`, one per component with a ratio (`formatCookedLine`);
- `steps-make-ahead` and `steps-fresh`, as `<h2 data-testid="steps-make-ahead">` and `<h2 data-testid="steps-fresh">` section headings, in that order in the DOM, each followed by its own steps (not `<p>`s, so the smoke test matches them with its own regex rather than `testIdBody()`);
- `recipe-not-found` on the 404 body.

#### 4. Route protection

**File**: `src/middleware.ts`

**Intent**: Append `"/recipes"` to `PROTECTED_ROUTES`.

**Contract**: `PROTECTED_ROUTES = ["/dashboard", "/targets", "/recipes"]`.

#### 5. Dashboard link

**File**: `src/pages/dashboard.astro`

**Intent**: Add a separate `<a href="/recipes">Browse recipes</a>` block after the targets link, in the same link style. Keep it as its own element so S-03's navigation addition merges as a union.

**Contract**: The new link is `href="/recipes"` with the text "Browse recipes".

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`

#### Manual Verification:

- Signed out, `/recipes` and `/recipes/<seed id>` redirect to `/auth/signin`.
- Signed in, `/recipes` shows 8 cards sorted by Polish collation, each with a placeholder photo and no rating UI. The dashboard's `Library: 8 recipes` line agrees.
- `Kurczak curry z ryżem` shows 3 divisible components, cooked lines for Ryż (×2.50) and Kurczak (×0.75), both step sections, and "Lunch · Dinner".
- `Leczo` shows "Whole dish only" with no component heading. `Zapiekanka makaronowa` shows "No suggested meal type".
- Eggs render as "N pcs (… g)" with "min. 50 g". Cocoa shows "step 1 g". The preheat step has no component, and the overnight step has no duration.
- `/recipes/not-a-uuid` and `/recipes/00000000-0000-4000-8000-000000000000` both return 404 "Recipe not found".
- The layout works at phone width.

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 3.

---

## Phase 3: Smoke Test, Documentation and Roadmap

### Overview

Prove S-05 end to end against the hosted DB, and record the slice in the docs. Only S-05 blocks are added to shared files.

### Changes Required:

#### 1. Smoke steps

**File**: `scripts/smoke.mjs`

**Intent**: Add a contiguous, commented `// S-05` group in two places.

- **Anon checks**: place them next to the existing anon redirect checks, before `"signup creates account"` (line ~119): `/recipes` and `/recipes/5eed0002-0000-4000-8000-000000000004` → `302 /auth/signin`.
- **Signed-in A checks**: place them immediately before the final `"signout clears session"` step (line ~300):
  - `/recipes` → 200, with `data-testid="recipe-card"` occurring ≥ 8 times and a link to `/recipes/5eed0002-0000-4000-8000-000000000004`. Use ≥, not an exact count, so the check survives S-07 and S-12 rows;
  - Kurczak curry detail → 200, with `recipe-name`, `recipe-division` ("Divisible components"), `recipe-meal-types` ("Lunch · Dinner"), the pinned `recipe-total`, a pinned `component-cooked` line, and the make-ahead/fresh **split** itself: one regex requiring `data-testid="steps-make-ahead"`, then the make-ahead step `Ugotuj ryż w osolonej wodzie`, then `data-testid="steps-fresh"`, and the fresh step `Odważ porcje każdego składnika, odgrzej i podaj.` (timing `fresh`, no component; `seed_products_and_recipes.sql:246,253-254`) appearing only after `steps-fresh`;
  - Leczo (`…0006`) → "Whole dish only";
  - Zapiekanka (`…0008`) → "No suggested meal type";
  - `not-a-uuid` and the all-zero valid uuid → 404.

Verify the 0006 and 0008 ids against `supabase/migrations/20261007120100_seed_products_and_recipes.sql` before pinning them.

**Contract**:

- Put the fixture constants (ids and pinned strings) in an `// S-05 fixtures` block next to the S-02 fixtures. Their comment says the strings mirror `formatMacroTotals()` / `formatCookedLine()` and gives the oracle SQL used to derive them (see Critical Implementation Details).
- Add the new test ids (`recipe-count`, `recipe-name`, `recipe-division`, `recipe-meal-types`, `recipe-total`, `component-cooked`, `recipe-not-found`) to the failure-dump id list (line ~330).

#### 2. Documentation

**Files**: `README.md`, `CLAUDE.md`

**Intent**:

- **README**: add `/recipes` and `/recipes/[id]` rows to the Auth routes table, and one sentence to the Smoke test section about the S-05 coverage.
- **CLAUDE.md**: add one S-05 bullet under Architecture → Auth flow, after the Macro targets bullet. It names:
  - the pages, `getRecipeCards()` / `getRecipeDetail()`, `recipe-macros.ts` (shared with S-04) and `recipe-labels.ts` (the single label map, for S-14);
  - the flat-query decision and why;
  - the **no-photo decision** (A1), revising the F-02 note: the photo column and Storage policy land with the first slice that supplies a photo;
  - the ratings slot seam for S-06.

**Contract**: Each file gets new rows or bullets in their own blocks. Existing lines are not edited.

#### 3. Roadmap

**File**: `context/foundation/roadmap.md`

**Intent**: Set S-05's status to `done` in the table row (line 40) and in its section and backlog entries. Do not touch any S-03 line.

**Contract**: Only S-05's status cells change.

#### 4. Change identity

**File**: `context/changes/browse-recipe-library/change.md`

**Intent**: Keep `status` in line with progress (`planned` → `implementing` → `implemented`) and update `updated`.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Build passes: `npm run build`
- Worktree is linked: `npx supabase link --project-ref tvmfkhnxxsnmvogplknz`
- Isolation test passes unchanged: `npm run test:rls`
- Seed test passes unchanged: `npm run test:seed`
- Smoke passes against the production preview: `npm run build && npm run preview`, then `npm run smoke`

#### Manual Verification:

- The pinned total and cooked line in `smoke.mjs` match the oracle SQL output, which was run independently and not copied from the page.
- A deliberate break (for example, temporarily computing `cookedWeight` without the ratio) makes the smoke step fail with a readable dump of `recipe-total` / `component-cooked`. Revert it afterwards.

**Implementation Note**: After automated verification passes, pause for manual confirmation. Phases 1–3 may be pushed on the S-05 branch, but they are **not merged** to `main` until Phase 4.

---

## Phase 4: Rebase onto S-03 and Re-verify (gated)

### Overview

This phase runs only after S-03 (`plan-three-day-grid`) is on `main`. Rebase, resolve the shared-file conflicts as unions, apply the A10 dedupe rule, re-verify everything, then merge.

### Changes Required:

#### 1. Rebase and conflict resolution

**Files**:

- `src/lib/services/recipes.ts`
- `src/types.ts`
- `src/middleware.ts`
- `src/pages/dashboard.astro`
- `scripts/smoke.mjs`
- `README.md`
- `CLAUDE.md`
- `context/foundation/roadmap.md`

**Intent**: Run `git fetch` and `git rebase origin/main`, then resolve conflicts by keeping both sides:

- `PROTECTED_ROUTES` becomes the union of both lists;
- the dashboard keeps both links;
- the smoke test keeps both step groups, with both sets of ids in the failure-dump list;
- the docs keep both sets of rows and bullets;
- the roadmap keeps S-03's status exactly as `main` has it.

Then apply A10 to `getRecipeCards()` vs. `listRecipes()`. If S-03 introduced a type that duplicates `MealType`/`DivisionMode` labels, or an equivalent label map, consolidate onto **one** map: adopt S-03's map (it landed first on `main`) as the single map, extend it with S-05's missing `DivisionMode` / `StepTiming` entries, and point S-05's code at it. If S-03's wording differs from S-05's, keep S-03's wording and re-pin the affected smoke label strings (`"Lunch · Dinner"`, `"Divisible components"`, `"Whole dish only"`, `"No suggested meal type"`) from the adopted labels. Labels are not computed values, so re-pinning them is mechanical; the SQL-derived `recipe-total` / `component-cooked` pins never change here.

After the rebase and the re-verification, publish the rewritten branch with `git push --force-with-lease origin claude/s-05-prompt-chain-183cb8` (never bare `--force`, and never merge instead of rebasing). A plain `git push` is rejected as non-fast-forward because Phases 1–3 were already pushed.

**Contract**: S-03's function names, types and roadmap rows are unchanged. No S-05 behaviour change except label wording, if consolidation changes it; smoke label pins are updated accordingly.

#### 2. Migration check

**Intent**: S-05 adds no migration, so there is no timestamp to reorder. Confirm with `git diff origin/main --stat -- supabase/migrations` (expect no S-05 entries).

### Success Criteria:

#### Automated Verification:

- S-03 is on main: `git log origin/main --oneline` shows the S-03 merge
- Branch contributes no migrations: `git diff origin/main --stat -- supabase/migrations` is empty
- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`
- Isolation test passes: `npm run test:rls`
- Seed test passes: `npm run test:seed`
- Smoke passes, S-03's and S-05's steps both: `npm run smoke` against `npm run preview`
- Rebased branch published: `git status -sb` shows no divergence from origin

#### Manual Verification:

- After the rebase, the dashboard shows both S-03's and S-05's navigation, and both features work.
- The dedupe outcome (wrapper or two functions) is noted in the commit message and reflected in the CLAUDE.md bullet.

---

## Testing Strategy

### Unit Tests:

- None. No runner exists, and adding one is out of scope. The pure helpers in `recipe-macros.ts` are covered end to end by the smoke pins.

### Integration Tests (smoke, hosted DB):

- Anon redirect for both routes.
- Card grid count ≥ 8, plus a link to a known recipe.
- Kurczak curry: division label, meal types, the exact batch total and cooked line (pinned from the SQL oracle), and a known make-ahead and a known fresh step each under its own section heading.
- Leczo: whole-dish label. Zapiekanka: zero-meal-type label.
- 404 for a malformed and for an absent uuid.
- `test:rls` and `test:seed` run unchanged, proving that S-05 touched no schema.

### Manual Testing Steps:

1. Sign out and open `/recipes`. Expect a redirect to sign-in.
2. Sign in, use the dashboard's "Browse recipes" link, and check the 8 cards and their order.
3. Open each of the 8 recipes and check for no rendering errors on the null-component, null-duration and zero-meal-type cases.
4. Check eggs (pieces, no halves, min 50 g), bread (halves allowed) and cocoa (1 g step).
5. Hit two bad ids and expect 404.

## Performance Considerations

- Cards use one query with no joins. Detail uses three parallel queries per request from the Worker, which is negligible for 8–100 recipes. There is no caching: SSR pages are per-user anyway, and the library changes only through migrations until S-07.

## Migration Notes

- None. S-05 is zero-migration (A1). The photo column, when it lands later, is a nullable `ADD COLUMN`, which keeps the F-04 revokes and the select-only policy intact (research §8).

## References

- Research: `context/changes/browse-recipe-library/research.md`
- Change identity and coordination rules: `context/changes/browse-recipe-library/change.md`
- Library schema: `supabase/migrations/20261008150000_shared_recipe_library.sql:294-373,421-449`
- Seed content: `supabase/migrations/20261007120100_seed_products_and_recipes.sql`
- SQL macro oracle: the literal queries in Critical Implementation Details (not `supabase/tests/seed_integrity.sql:268-290`, which computes a different quantity)
- Service idiom: `src/lib/services/macro-targets.ts:8-34,72-75`; not-found idiom: `src/lib/services/household.ts:6-16`
- Page pattern: `src/pages/targets.astro`, `src/pages/dashboard.astro:80-99`
- Smoke structure: `scripts/smoke.mjs:83-109,299-330`
- PRD: `context/foundation/prd.md:88-95,137-138,151`; roadmap S-05: `context/foundation/roadmap.md:40,182-192`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Types, Label Map, Macro Helpers and Service Readers

#### Automated

- [ ] 1.1 Lint passes: `npm run lint`
- [ ] 1.2 Type check passes: `npx astro check`
- [ ] 1.3 Build passes: `npm run build`

#### Manual

- [ ] 1.4 `getRecipeDetail` returns ordered components, ingredients and steps for Kurczak curry with no PGRST201

### Phase 2: Pages, Card Component, Route Protection and Dashboard Link

#### Automated

- [ ] 2.1 Lint passes: `npm run lint`
- [ ] 2.2 Type check passes: `npx astro check`
- [ ] 2.3 Build passes: `npm run build`

#### Manual

- [ ] 2.4 Signed-out `/recipes` and `/recipes/<id>` redirect to sign-in
- [ ] 2.5 `/recipes` shows 8 sorted cards with placeholder photos and no rating UI
- [ ] 2.6 Kurczak curry detail shows components, cooked lines, both step sections and meal types
- [ ] 2.7 Leczo shows "Whole dish only"; Zapiekanka shows "No suggested meal type"
- [ ] 2.8 Piece, min-amount, rounding-step and null-component/duration cases render correctly
- [ ] 2.9 Malformed and absent ids return 404 "Recipe not found"
- [ ] 2.10 Layout works at phone width

### Phase 3: Smoke Test, Documentation and Roadmap

#### Automated

- [ ] 3.1 Lint passes: `npm run lint`
- [ ] 3.2 Build passes: `npm run build`
- [ ] 3.3 Worktree is linked: `npx supabase link --project-ref tvmfkhnxxsnmvogplknz`
- [ ] 3.4 Isolation test passes unchanged: `npm run test:rls`
- [ ] 3.5 Seed test passes unchanged: `npm run test:seed`
- [ ] 3.6 Smoke passes against the production preview: `npm run smoke`

#### Manual

- [ ] 3.7 Pinned total and cooked line match independently run oracle SQL
- [ ] 3.8 Deliberate break makes the smoke step fail with a readable dump

### Phase 4: Rebase onto S-03 and Re-verify (gated)

#### Automated

- [ ] 4.1 S-03 is on main: `git log origin/main --oneline` shows the S-03 merge
- [ ] 4.2 Branch contributes no migrations: `git diff origin/main --stat -- supabase/migrations` is empty
- [ ] 4.3 Lint passes: `npm run lint`
- [ ] 4.4 Type check passes: `npx astro check`
- [ ] 4.5 Build passes: `npm run build`
- [ ] 4.6 Isolation test passes: `npm run test:rls`
- [ ] 4.7 Seed test passes: `npm run test:seed`
- [ ] 4.8 Smoke passes, S-03's and S-05's steps both: `npm run smoke`
- [ ] 4.9 Rebased branch published: `git status -sb` shows no divergence from origin

#### Manual

- [ ] 4.10 Dashboard shows both S-03's and S-05's navigation and both features work
- [ ] 4.11 Dedupe outcome recorded in the commit message and the CLAUDE.md bullet
