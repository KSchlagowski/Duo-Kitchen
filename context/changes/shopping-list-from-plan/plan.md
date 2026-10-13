# Shopping List from the Plan (S-09) Implementation Plan

## Overview

Roadmap S-09 (US-02, FR-021): a signed-in household member opens `/plan/shopping` and sees one shopping list for a 3-day meal plan. Each product appears once, with quantities combined for both people and grouped by store aisle in FR-021's fixed order. Either partner can check items off online, and the other sees the check on the next load. Solved days contribute the stored, rounded solve amounts. Every other day contributes one recipe base batch per dish, marked as an estimate. The list itself is derived on every read and never stored; the only new persisted state is the check-offs.

This plan was written in a non-interactive session. The research's open questions are decided below as **[Assumption]** items. Each one names the alternative, so a reviewer can overturn it before implementation.

## Current State Analysis

- Nothing shopping-related exists: no table, service, route, label or test (research §Summary).
- All the inputs already exist:
  - **Plan.** `getMealPlan(supabase, startDate?)` (`src/lib/services/meal-plans.ts:113`) returns meals with `mealId`, `dishId`, `dayIndex`, `recipeId` and `eaterUserId`. Without a date it returns the most recently saved plan.
  - **Solved amounts.** They live in `plan_day_solutions.result` and may be read only through the zod gate `parseStoredSolution()` (`src/lib/services/day-solutions.ts:192`). Every meal of a shared batch carries the **full batch** `amountG`, so a consumer must count each `batch.dishId` once (CLAUDE.md, S-08 bullet). `batch` is null exactly when the dish feeds one meal (`macro-solver.ts:990`).
  - **Currency rule.** The canonical "is this solve group current?" rule lives inside `getPlanSolveStatuses()` (`day-solutions.ts:307-367`). It already loads the stored rows and the shared inputs (members, targets, `getSolverRecipes()` for every plan recipe). It fingerprints each group, but it **discards the parsed solutions**.
  - **Base amounts.** `getSolverRecipes()` (`src/lib/services/recipes.ts:230`) returns `baseAmountG`, `productName`, `gramsPerPiece` and `allowHalfPieces` per ingredient. It returns **no `product_id` and no `aisle`**. The stored `DaySolutionIngredient.id` is the library `recipe_ingredients.id`, so a separate ingredient → product/aisle lookup serves both sources.
  - **Formatting and order.** `formatIngredientAmount()` (`src/lib/services/recipe-macros.ts:62`) formats pieces and grams. The `store_aisle` enum order is `produce, dairy, meat_fish, bakery, dry_goods, spices, frozen, other` (`StoreAisle`, `src/types.ts:22`). No aisle labels exist yet; they belong in `src/lib/recipe-labels.ts`.
- **Patterns to copy.**
  - Table: `plan_day_solutions` (`supabase/migrations/20261009120000_plan_day_solutions.sql`). It uses a composite plan FK, four helper policies, write revokes including `maintain`, and a definer RPC that resolves the household server-side.
  - API route: `/api/plan/solve` (`src/pages/api/plan/solve.ts`). It redirects anonymous callers, wraps `formData()` in try/catch, validates with zod and reports errors through redirect params.
- **SQLSTATEs.** KD001–KD017 are claimed and KD006 is retired, so this slice claims **KD018** and **KD019**.
- **Routing.** `/plan/shopping` is protected for free by the `/plan` prefix in `PROTECTED_ROUTES` (`src/middleware.ts:4-11`).
- **UI precedent.** Every domain page so far uses form POST → redirect with no island. The only React islands are the auth forms (`src/components/auth/*.tsx`).

## Desired End State

- `/plan/shopping?start=<YYYY-MM-DD>` (or `/plan/shopping` alone, which uses the most recently saved plan) shows:
  - a summary line, `Shopping list: <N> items · <M> checked`;
  - one plain-text note per data source, saying which days use exact amounts from the day solve and which use recipe base amounts, followed by one line per non-empty day linking to `/plan/day` with that day's `formatPlanDayStatus()` text;
  - aisle sections in enum order, each listing its products alphabetically (Polish collation) with a combined amount (`412 g`, or `3 pcs (150 g)` for piece products) and a checkbox.
- Ticking a box persists through `public.set_shopping_item_checked`. With JavaScript the tick toggles in place with no reload, and reverts with a message if the save fails. Without JavaScript the page reloads at the same item. The partner sees the same checks.
- Solving a day, editing the plan or changing targets changes the list on the next load. A check survives an amount change.
- `npm run test:rls`, `npm test`, lint, `astro check`, build and `npm run smoke` all pass. CLAUDE.md and README describe the slice.

### Key Discoveries:

- `getPlanSolveStatuses()` is the single currency rule. S-08's impl-review F4 was exactly a divergence between `/plan` and `/plan/day` (`context/changes/shared-dish-across-days/reviews/impl-review.md:89-97`). S-09 must reuse the rule, so it gets refactored into a function that also returns the current parsed solutions and the already-loaded recipes.
- `solveGroups()` (`macro-solver.ts:100-132`) never splits a dish across groups. A dish is therefore wholly exact or wholly an estimate, never half of each.
- In a current group, the stored `mealId`s equal the plan's `mealId`s, because the fingerprint covers them (`macro-solver.ts:1100`). A null-batch stored meal therefore maps back to its `PlanMealRecord.dishId`.
- Base amounts are already shoppable: every one is a step multiple or a whole/half piece multiple (F-02 `plan.md:82`). One base batch is "one sensible batch for two people" (F-02 `plan.md:305`).
- `formatIngredientAmount(total, gramsPerPiece, true)` prints whole or half pieces, and falls back to grams for any other count. That is safe for summed totals, because `allowHalfPieces` belongs to the ingredient, not the product.
- `testIdBody()` in `scripts/smoke.mjs:113` matches only `<p>` elements. New pinned strings must render in `<p data-testid=…>`, and list items need their own regex helper.

## What We're NOT Doing

- **No offline check-off, no Sync button and no live (realtime) updates.** These are deferred to v2 (PRD `prd.md:112,128,163`). The partner sees checks on reload.
- **No stored list.** No shopping-list table and no snapshot. Only checks are stored.
- **No list spanning several plans**, and no merging of overlapping plans. One list per plan, matching the PRD's 3-day cycle.
- **No `checked_by`, no per-recipe breakdown under an item, no spice-blend parent/child display** (v2, `prd.md:130`).
- **No eater-count scaling of base amounts** (see Assumption A1).
- **No changes to the solver**, the stored jsonb shape, `SOLVER_VERSION` or `getSolverRecipes()` / `SolverIngredient`.
- **No housekeeping outside S-09:**
  - the open `MAINTAIN` revoke gap on `macro_targets` / `household_invites`;
  - archiving the S-08 change folder;
  - S-08's roadmap status.
- **No shadcn checkbox install.** A native `<input type="checkbox">` styled with Tailwind is enough.
- **No manual "add an item" or free-text items.** FR-021 only asks for a list generated from the plan.

## Implementation Approach

The slice follows the S-04 split between a pure core and a thin I/O shell:

1. **Database first** (Phase 1). Add a household-scoped, write-revoked `shopping_list_checks` table with one definer RPC, and extend the isolation test. It ships alone so `db push` + `test:rls` can gate everything after it.
2. **Pure builder + state refactor** (Phase 2). Add `src/lib/services/shopping-list.ts`, a pure function from (plan, current solutions, base recipes, ingredient→product map, checked ids) to an aisle-grouped list, with a vitest suite. Refactor `getPlanSolveStatuses()` into `getPlanSolveState()` so the currency rule exists once.
3. **Page + API, no JavaScript** (Phase 3). Add the I/O wrapper, the `/plan/shopping` page with one form per item, `POST /api/plan/shopping`, and links from the dashboard and `/plan`. At this point the slice is complete and usable.
4. **Progressive enhancement** (Phase 4). Add a React island over the same API, with optimistic toggles and a JSON response mode. If time is short this phase can be dropped without losing any requirement.
5. **Smoke + docs** (Phase 5). Cover the slice end to end over HTTP and update CLAUDE.md and README.

### Decisions taken in place of questions

- **A1 — Unsolved quantities** (the roadmap Unknown).
  - A dish in a group that is not current (unsolved, stale, unsolvable, or a stored row that fails the zod gate) contributes **one recipe base batch per dish**, whatever its eaters.
  - The page says which days are estimates.
  - Rejected alternatives: halving for a single-eater meal (breaks rounding steps and piece rules), and hiding unsolved days (fails US-02's "solved (or unsolved)").
- **A2 — What counts as exact.** A **current** stored row of any status (`solved`, `needs_confirmation`, `no_fit`) supplies exact amounts. These are the rounded quantities the day page shows, and they predict the cook better than base amounts do. The exact note therefore never says "solved" (`Exact amounts from the day solve of …`); the per-day lines below the notes distinguish "solved" from "best fit not yet accepted" with `formatPlanDayStatus()` wording (e.g. "Needs ±20% — open to accept", "No fit within ±20%"). Rejected: exact only for `solved`.
- **A3 — Check semantics.**
  - A check is keyed on `(plan, product)` and survives amount changes.
  - A check whose product is no longer on the list is ignored on render, and reappears if the product returns.
  - Rejected: storing `checked_amount_g` and flagging "amount changed".
- **A4 — Write design.** Write-revoked table + `public.set_shopping_item_checked(p_start_date, p_product_id, p_checked)`. This is the `plan_day_solutions` pattern: one write path, household resolved server-side, KD-mapped messages. Rejected: direct RLS writes (the `macro_targets` pattern).
- **A5 — Interaction.** No-JS forms first (Phase 3), then a React island enhancing them (Phase 4). The API answers JSON when the request sends `Accept: application/json`, and redirects otherwise. The server-rendered list stays the source of truth on reload.
- **A6 — Which plan.** `?start=` if given, otherwise the most recently saved plan, as on the dashboard. A malformed `start` returns 404 (`/plan/day` precedent). A date with no plan shows "No plan for that date" with a link to `/plan`.
- **A7 — Checking a product not on the plan.** The RPC rejects a **check** (not an uncheck) of a product that no recipe of the plan uses, with KD019. Without this, any member could plant arbitrary rows. Unchecking is always allowed, so a stale check can be cleared.
- **A8 — Product deletion.** `product_id → public.products on delete cascade`. A check on a removed product is meaningless, and `recipe_ingredients` already blocks deleting a product that is in use, so the cascade only matters once S-07 lets users remove unused products.
- **A9 — Ordering.** Aisles follow enum order. Empty aisles are omitted. Within an aisle, items sort by `productName.localeCompare(…, "pl")`, then by `productId` as a tiebreak. Checked items **stay in place** rather than sinking, so positions do not jump while shopping. The output is deterministic (NFR).

## Critical Implementation Details

- **State sequencing (shared batches).** Key everything by the plan's `dishId`, never by stored meals:
  - Take a current dish's ingredients from **one** stored meal. Build a `Map<dishId, DaySolutionMeal>` from the current solutions, keeping the **first** stored meal seen for each `batch.dishId` (or, for a null-batch meal, for the plan `dishId` of its `mealId`). Never filter-and-sum the matches: a batch feeding lunch and dinner of the **same** day has two stored meals on that day, each carrying the full batch `amountG`.
  - Iterating stored meals instead would double-count every shared batch, because each day of a batch carries the full `amountG`.
  - If a current group's solution unexpectedly lacks the dish, fall back to the base batch and report the dish id in the builder's diagnostics. The I/O layer logs it with `console.error`.
- **Float noise.** Sum per product in grams, then round each total with `Number(total.toFixed(1))` before formatting. Sums of `numeric(7,1)` values pick up noise such as `0.30000000000000004`.
- **CPU budget.** Workers Free gives 10 ms of CPU (S-08 Phase 4 §3). The page must reuse `getPlanSolveState()`'s single load: one `plan_day_solutions` read, one shared-inputs load and one SHA-256 per group. It adds only two reads (the ingredient→product map and the checks). It never runs the LP.

---

## Phase 1: Check-off table and RPC

### Overview

Add the slice's only persisted state and its single write path, then prove both RLS levers in the isolation test. Apply the migration to the hosted project before any app code depends on it.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/20261013120000_shopping_list_checks.sql`

**Intent**: Create the household-scoped, write-revoked check-off table and its definer RPC. The header comment follows the style of `20261009120000_plan_day_solutions.sql`: ownership class, the no-membership-FK warning, write revocation, the SQLSTATEs claimed and the rollback.

**Contract**:

- **Table.**

  ```
  public.shopping_list_checks (
    household_id uuid not null references public.households on delete cascade,
    plan_id uuid not null,
    product_id uuid not null references public.products on delete cascade,
    checked_at timestamptz not null default now(),
    constraint shopping_list_checks_pkey primary key (plan_id, product_id),
    constraint shopping_list_checks_plan_fkey foreign key (plan_id, household_id)
      references public.meal_plans (id, household_id) on delete cascade)
  ```

  Add indexes on `household_id` and `product_id`, and a table comment.
- **Grants.** Enable RLS. `revoke all … from anon`; `revoke insert, update, delete, truncate, references, trigger, maintain … from authenticated`.
- **Policies.** Four per-operation policies `to authenticated`, all using `household_id in (select private.user_household_ids())`.
- **RPC.** `public.set_shopping_item_checked(p_start_date date, p_product_id uuid, p_checked boolean) returns void`, with `language plpgsql security definer set search_path = ''` and every name fully qualified. Steps:
  1. KD007: no `auth.uid()` or no household. Resolve the household as in `save_plan_day_solutions` (`20261011120000_shared_dishes.sql:340-344`).
  2. KD018: a plain `if p_start_date is null or p_product_id is null or p_checked is null then raise … using errcode = 'KD018'`, with no sub-block (three scalar null checks cannot raise anything unexpected).
  3. KD014 (reused): no `public.meal_plans` row for the household and date.
  4. If `p_checked`, KD019 when no `plan_dishes → recipe_components → recipe_ingredients` row of that plan uses `p_product_id`. This also covers an unknown product. Then `insert … on conflict (plan_id, product_id) do nothing`.
  5. Otherwise `delete … where plan_id = v_plan and product_id = p_product_id`. Deleting a missing row is not an error.
- **Function grants.** `revoke execute … from public, anon; grant execute … to authenticated;` plus a function comment listing the codes.
- **No `user_id` column** and no `(household_id, user_id) → household_members` FK: checks stay with their plan on redemption.

#### 2. Isolation test

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Prove that households are isolated, that writes are revoked and that the RPC behaves correctly. Copy the `plan_day_solutions` blocks (research §8 has the line map).

**Contract**: new blocks, each raising a descriptive error on failure:

- **Fixtures** (follow the `plan_day_solutions` precedent, `household_isolation.sql:979`, `:1202-1222`):
  1. Read-isolation rows go on the existing `…a007` / `…b007` fixture plans (`2030-01-01`, `:158-159`), one check row each, inserted as postgres.
  2. The RPC behaviour and KD blocks use an **A-only** plan created as A with `public.save_meal_plan('2030-06-01', …)`, holding one meal of seed recipe `5eed0002-0000-4000-8000-000000000001`. The "used product" is any `product_id` of that recipe's ingredients. The "unused product" is a seed product the recipe does not use, found with a `not exists` query rather than a hard-coded id.
  3. The redemption block inserts (as postgres) one check row on the redeemer's pre-redemption plan before redeeming.
- **Reads.** A sees only A's rows; B sees only B's.
- **Direct writes.** `insert`, `update` and `delete` as `authenticated` accept only `insufficient_privilege`.
- **RPC behaviour.**
  - Check, check again: still one row.
  - Uncheck, uncheck again: no error, zero rows.
  - Checking a product used by the plan succeeds.
- **KD table** (loop idiom that re-raises a bare `P0001`):
  - KD018: null start date, null product, null checked.
  - KD014: a date with no plan.
  - KD019: a real product not used by the plan's recipes, and a random uuid.
  - KD007: no caller.
- **Cross-household.** B calling the RPC with `2030-06-01` (A's RPC-saved plan; B has no plan there) gets KD014, and A's rows are untouched.
- **Anon.** The anon RPC probe is denied execute, and the table is added to the anon zero-row loop.
- **Privileges.** Assert `insert/update/delete/truncate/references/trigger/maintain` are not granted to `authenticated`, nothing is granted to `anon`, and execute on the function belongs to `authenticated` only.
- **Redemption.** In an existing redemption block, assert afterwards that the check row inserted on the redeemer's pre-redemption plan (fixture 3) still has its original `household_id`.
- **Summary.** Append to the summary notice.

#### 3. Apply

Run `npx supabase db push` against the linked project (`tvmfkhnxxsnmvogplknz`). CI tests the deployed schema, so this happens in this phase.

### Success Criteria:

#### Automated Verification:

- Migration applies to the hosted project: `npx supabase db push`
- Isolation test passes: `npm run test:rls`
- Seed integrity still passes: `npm run test:seed`
- Deploy gate sees no missing migration: `npm run check:migrations`

#### Manual Verification:

- In the Supabase dashboard (project `tvmfkhnxxsnmvogplknz`) → Table Editor → `shopping_list_checks`:
  - the table exists;
  - the "RLS enabled" badge shows;
  - Authentication → Policies lists exactly four policies for it (select / insert / update / delete, all `authenticated`).
- Run `npx supabase db query --linked "select has_table_privilege('authenticated','public.shopping_list_checks','INSERT'), has_function_privilege('anon','public.set_shopping_item_checked(date,uuid,boolean)','EXECUTE')"`. Expect `false | false`.
- Regression in the running app (`npm run dev`, http://localhost:4321): sign in, open `/plan`, save a plan change, open a day via its card and press Solve. Both still work with no errors in the terminal.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Pure list builder and shared solve state

### Overview

Add the list-building logic as a pure, unit-tested module. Expose the canonical currency rule's intermediate results so the shopping list and `/plan` cannot disagree about which days are solved.

### Changes Required:

#### 1. Types

**File**: `src/types.ts`

**Intent**: Add the DTOs the builder and page share.

**Contract**:

- `IngredientProduct { ingredientId; productId; productName; aisle: StoreAisle; gramsPerPiece: number | null }`.
- `ShoppingItem { productId; productName; aisle; amountG: number; gramsPerPiece: number | null; checked: boolean }`.
- `ShoppingAisle { aisle: StoreAisle; items: ShoppingItem[] }`.
- `ShoppingDaySource = "exact" | "estimate" | "empty"`.
- `ShoppingList`:
  - `planId`, `startDate`;
  - `aisles: ShoppingAisle[]`;
  - `daySources: Record<PlanDayIndex, ShoppingDaySource>`;
  - `itemCount`, `checkedCount`;
  - `diagnostics: { missingRecipeIds: string[]; unmatchedIngredientIds: string[]; dishesFellBack: string[] }`.

#### 2. Aisle labels

**File**: `src/lib/recipe-labels.ts`

**Intent**: Add the single label map S-14 will localise.

**Contract**: `AISLE_LABELS: Record<StoreAisle, string>`, in English to match the rest of the UI: Produce, Dairy, Meat & fish, Bakery, Dry goods, Spices, Frozen, Other.

#### 3. Pure builder

**File**: `src/lib/services/shopping-list.ts` (new; pure, no Supabase import)

**Intent**: Turn plan + current solutions + base recipes + ingredient→product map + checked product ids into the aisle-grouped list. This follows the algorithm in research §7 and the Critical Implementation Details above. The Phase 4 island imports this module in the browser, so it may import only `@/types`, `@/lib/services/recipe-macros`, `@/lib/recipe-labels` and `@/lib/utils` — never `day-solutions.ts` (which pulls in `macro-solver` / `yalps`, zod and Supabase) or any Supabase code.

**Contract**:

- **Move `joinList`.** Move `joinList()` from `day-solutions.ts:423` to `src/lib/utils.ts` (a generic helper). `day-solutions.ts` imports it from there; update its other importers, if any, the same way.
- **Exports.**
  - `STORE_AISLES: readonly StoreAisle[]`, in enum order.
  - Every display-string helper and message constant of the slice (defined in Phase 3 §2, but living here): `formatShoppingSummary`, `formatExactNote`, `formatEstimateNote`, `formatShoppingAmount`, `SHOPPING_ERRORS`, `SHOPPING_SAVE_FAILED`, `SHOPPING_UNAVAILABLE`, `SHOPPING_NO_PLAN`, `SHOPPING_NO_PLAN_FOR_DATE`.
  - `buildShoppingList(input: { plan: MealPlan; currentSolutions: Partial<Record<PlanDayIndex, DaySolution>>; recipes: Record<string, SolverRecipe>; ingredientProducts: Record<string, IngredientProduct>; checkedProductIds: ReadonlySet<string> }): ShoppingList`.
- **Rules.**
  - Iterate the plan's dishes (group `plan.meals` by `dishId`). A dish is exact when the day of its first meal is in `currentSolutions`. Groups never split a dish, so every day of the dish agrees.
  - Exact dishes: ingredients come from the one stored meal chosen as described above. Other dishes: the base recipe's ingredients come from `recipes[recipeId]`, once per dish. A missing recipe contributes nothing and lands in `missingRecipeIds`.
  - Map each ingredient through `ingredientProducts`. An unknown id is skipped and reported.
  - Sum per `productId` and round to 0.1 g. Group and sort per A9. Items whose id is in `checkedProductIds` get `checked: true`. Checked ids that are not on the list are ignored.
  - `daySources[day]`: `empty` when the day has no meals, otherwise `exact` or `estimate`.

#### 4. Shared solve state (refactor)

**File**: `src/lib/services/day-solutions.ts`

**Intent**: Extract the body of `getPlanSolveStatuses()` into `getPlanSolveState()`, which also returns the parsed solutions of current groups and the recipes it already loaded. `getPlanSolveStatuses()` then delegates to it unchanged, so there is one currency rule and one load.

**Contract**:

- `export async function getPlanSolveState(supabase, plan: MealPlan): Promise<{ statuses: Record<PlanDayIndex, PlanDaySolveStatus>; currentSolutions: Partial<Record<PlanDayIndex, DaySolution>>; recipes: Record<string, SolverRecipe> }>`.
- A group's days go into `currentSolutions` exactly when its status kind is `solved`, `needs_confirmation` or `no_fit`, that is, the existing "every day parsed and fingerprint-equal" branch.
- `getPlanSolveStatuses(supabase, plan)` keeps its signature and returns `(await getPlanSolveState(...)).statuses`.

#### 5. Unit tests

**File**: `src/lib/services/shopping-list.test.ts` (new)

**Intent**: Pin exact quantities and the dedup/ordering invariants, which smoke cannot pin for solved plans.

**Contract**: hand-built `MealPlan`, `SolverRecipe` and `DaySolution` fixtures. Reuse literals from `macro-solver.fixtures.ts` where convenient. Cases:

- **Unsolved plan.** Two recipes sharing salt sum to the base batches. A product used once keeps its base amount.
- **One dish eaten at two meals of one day** (one dish, unsolved). Counted once.
- **Shared batch across two current days.** `batch.dishId` appears on both days with the full `amountG`, and is counted **once**, at the stored amount.
- **One dish eaten at lunch and dinner of one current day.** Both stored meals carry the batch `amountG`; counted once, at the stored amount.
- **Mixed plan** (day 0 current, day 1 not). Exact amounts plus base amounts. `daySources` is `{0:"exact",1:"estimate",2:"empty"}`.
- **Pieces.** Two half-egg dishes total 1 piece. The total is rounded to 0.1 g, so float noise such as `0.1+0.2` disappears.
- **Ordering.** Aisles follow enum order with empty aisles omitted. Items sort with Polish collation (`Ł` after `L`). Repeated calls give deep-equal output.
- **Checks.** A checked id on the list sets `checked` and `checkedCount`. A checked id that is not on the list is ignored.
- **Missing data.** A missing recipe or unmatched ingredient is reported in `diagnostics` and does not throw.
- **Fallback.** A current solution lacking a dish falls back to base and lands in `dishesFellBack`.

### Success Criteria:

#### Automated Verification:

- Unit tests pass, including the existing solver and day-solutions suites: `npm test`
- Lint passes: `npm run lint`
- Types check: `npx astro check`
- Build succeeds: `npm run build`

#### Manual Verification:

- Run `npm test -- shopping-list` and confirm the reporter lists the shared-batch-counted-once, mixed-plan and Polish-ordering cases as passing.
- Regression of the refactor in the running app (`npm run dev`), signed in as an account with a plan where one day is solved, one is unsolved and one has a shared batch:
  - open `/plan`;
  - confirm every day card shows the same status text as before the change (`Solved within ±…%`, `Not solved`, `Out of date`, and the group sentence for shared days);
  - open a solved day's `/plan/day` page and confirm it still shows its stored result.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Shopping page, check-off API and navigation (no JavaScript)

### Overview

Wire the builder to Supabase, render the list server-side with one plain form per item, add the write route, and link the page from the dashboard and `/plan`. After this phase the feature is complete for a user without JavaScript.

### Changes Required:

#### 1. Ingredient → product read

**File**: `src/lib/services/recipes.ts`

**Intent**: Add one flat read that maps every ingredient id of the given recipes to its product and aisle. It serves both stored and base ingredients, without touching `SolverIngredient` or the solver fixtures.

**Contract**: `getIngredientProducts(supabase, recipeIds: string[]): Promise<Record<string, IngredientProduct>>`. It runs a single `recipe_components.select("recipe_id, recipe_ingredients(id, product_id, products(id, name, aisle, grams_per_piece))").in("recipe_id", ids)`, returns `{}` for no ids, throws on error and casts at the boundary as the other reads do.

#### 2. Shopping I/O service

**Files**: `src/lib/services/shopping.ts` (new, I/O only) and `src/lib/services/shopping-list.ts` (pure, from Phase 2)

**Intent**: `shopping.ts` is the single home for the page's reads, the RPC call and `shoppingErrorMessage()`. The KD → message map, the message constants and the strings smoke pins live in the pure `shopping-list.ts`, so the Phase 4 island can import them without pulling in the solver or Supabase.

**Contract** (`getShoppingList`, `setShoppingItemChecked` and `shoppingErrorMessage` in `shopping.ts`; everything else in `shopping-list.ts`):

- `getShoppingList(supabase, startDate?: string): Promise<{ plan: MealPlan; list: ShoppingList; statuses: Record<PlanDayIndex, PlanDaySolveStatus> } | null>`. It returns null when there is no plan. It calls `getMealPlan` → `Promise.all([getPlanSolveState, getIngredientProducts, checks read])` → `buildShoppingList`, and logs any non-empty `diagnostics` with `console.error`.
- `setShoppingItemChecked(supabase, startDate, productId, checked): Promise<void>`. It wraps the RPC with the `RpcResult` cast and throws on error.
- `SHOPPING_ERRORS`:
  - KD007: "You need to be signed in to check off items."
  - KD014: "Save the plan before shopping for it."
  - KD018: "That item could not be updated. Please try again."
  - KD019: "That product is not on this plan's shopping list."
- `SHOPPING_SAVE_FAILED` as the fallback message, and `shoppingErrorMessage(error)` using `errorCode()`.
- Display strings (smoke pins them):
  - `formatShoppingSummary(list)` → `Shopping list: 12 items · 3 checked` (or `Shopping list: no items yet` when the plan has no meals).
  - `formatExactNote(weekdays)` → `Exact amounts from the day solve of ${joinList(weekdays)}.`
  - `formatEstimateNote(weekdays)` → `${joinList(weekdays)}: recipe base amounts (estimate) — solve to get exact amounts.`
  - `formatShoppingAmount(item)` → `formatIngredientAmount(item.amountG, item.gramsPerPiece, true)`.
  - Constants `SHOPPING_UNAVAILABLE`, `SHOPPING_NO_PLAN` ("No plan yet — start one to get a shopping list.") and `SHOPPING_NO_PLAN_FOR_DATE`.

#### 3. Page

**File**: `src/pages/plan/shopping.astro` (new)

**Intent**: Render the list server-side, following `src/pages/plan/day.astro`'s read/try-catch/notice pattern and the existing glass-card styling.

**Contract**:

- **`start` param.** Validate an optional `start` with `isIsoDate`. A malformed value returns 404. A failed read returns 500 with `SHOPPING_UNAVAILABLE`, never "no plan".
- **No plan.** Show `SHOPPING_NO_PLAN` (or the for-date variant) and a link to `/plan`.
- **Header and notes.**
  - The header shows the plan start date. `<p data-testid="shopping-summary">` holds the summary.
  - `<p data-testid="shopping-exact">` and `<p data-testid="shopping-estimate">` render only when they have days, and hold **plain text only** (the `formatExactNote` / `formatEstimateNote` strings, no nested links or spans), so smoke's `testIdBody()` can match them.
  - Below them, a list with one `<li data-testid="shopping-day-<n>">` per non-empty day: the weekday linked to `/plan/day?start=…&day=<n>`, then `formatPlanDayStatus(statuses[n])` (e.g. "Not solved", "Out of date", "Needs ±20% — open to accept"). Smoke matches these lines with `testIdItem()`.
- **Aisle sections.** One `<section data-testid="aisle-<key>">` per non-empty aisle with an `AISLE_LABELS` heading. Each item is an `<li id="item-<productId>" data-testid="item-<productId>" data-checked="true|false">`.
- **Item forms.** Each item is a `<form method="POST" action="/api/plan/shopping">` with hidden `start_date`, `product_id` and `checked` (the **target** state) and a submit button. The button's label shows the checkbox state (☐/☑ glyph with an `aria-pressed` button) followed by the name and amount. Checked items are struck through and muted, using `cn()`.
- **Notices.** `?error=` shows a red notice, as on other pages.
- **Back links.** Links back to `/plan?start=…` and `/dashboard`.

#### 4. API route

**File**: `src/pages/api/plan/shopping.ts` (new)

**Intent**: The write endpoint, mirroring `/api/plan/solve.ts`.

**Contract**:

- `POST`. An anonymous caller is redirected to `/auth/signin`.
- `formData()` sits in try/catch. Zod validates `start_date` (`isIsoDate`), `product_id` (`z.guid()`, as recipe ids are) and `checked` (`z.enum(["0","1"])`, no coercion).
- Success redirects to `/plan/shopping?start=<d>#item-<productId>`. Failure redirects to `/plan/shopping?start=<d>&error=<msg>#item-<productId>`. An unparseable start redirects to `/plan/shopping?error=…`.
- Errors are mapped with `shoppingErrorMessage()` and logged with `console.error`.

#### 5. Navigation

**Files**: `src/pages/dashboard.astro`, `src/pages/plan.astro`

**Intent**: Make the list reachable.

**Contract**:

- **Dashboard.** Add a `Shopping list` link to `/plan/shopping` right after the plan link, only when a plan exists and the read did not fail.
- **`/plan`.** When the viewed plan exists, add a `Shopping list` link to `/plan/shopping?start=<startDate>` near `plan-summary`, outside the grid form.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Types check: `npx astro check`
- Build succeeds: `npm run build`
- Existing smoke still passes against the preview: `npm run build && npm run preview`, then `npm run smoke`

#### Manual Verification:

Run `npm run dev`, open http://localhost:4321 and sign in as account A, which is linked to partner B and has targets set.

- **Unsolved plan.**
  1. On `/plan`, choose start date `2031-02-03`.
  2. Fill Monday lunch with *Kurczak curry z ryżem* (both eat) and Monday dinner with a second seed recipe that also uses salt, then save.
  3. Click **Shopping list** next to the plan summary.
  4. Expect the URL `/plan/shopping?start=2031-02-03`.
  5. Expect the summary `Shopping list: <N> items · 0 checked`.
  6. Expect the estimate note `Monday: recipe base amounts (estimate) — solve to get exact amounts.`, and below it a Monday line linking to its day page and showing "Not solved".
  7. Expect aisle headings in the order Produce → Dairy → Meat & fish → … with no empty headings, and **Sól** listed once under Spices with the two recipes' base amounts summed. Check the sum against the two recipe detail pages under `/recipes`.
- **Check-off.**
  1. Click **Sól**.
  2. The page reloads at the same item, which is now struck through. The summary reads `… · 1 checked`.
  3. Click it again: it is unchecked and the count returns to 0.
- **Partner sees checks.**
  1. Check two items as A.
  2. In a private window, sign in as B and open `/dashboard` → **Shopping list**.
  3. B sees the most recent plan (this one) with the same two items checked.
  4. Uncheck one as B, reload as A: A sees it unchecked.
- **Solving updates amounts.**
  1. On `/plan`, fill Monday's remaining slots (all 5 meals) and save.
  2. Open Monday, press **Solve**, and accept a looser tier if offered.
  3. Back on `/plan/shopping?start=2031-02-03`, the note now reads `Exact amounts from the day solve of Monday.`, and Monday's day line shows its status (`Solved within ±…%`, or the "Needs ±…%" text if a looser tier was offered and not yet accepted).
  4. The amounts of Monday's products match the cook amounts on Monday's day page.
  5. Items checked before solving are still checked.
- **Shared batch counted once.**
  1. Build the share by hand (the smoke account's 2031-01-20 plan ends unshared and stale, so do not use it): on `/plan`, choose start date `2031-02-10`, fill Monday and Tuesday with all 5 meals, put *Kurczak curry z ryżem* at Monday lunch, and set Tuesday lunch to "shares batch with Monday lunch". Save.
  2. Open Monday, press **Solve**, and accept a looser tier if offered.
  3. Open `/plan/shopping?start=2031-02-10`. Pick a product used only by the curry (e.g. the rice).
  4. Its list amount equals the batch amount listed on Monday's day page. It is not doubled.
- **Stale estimate.**
  1. Change one eater on the solved Monday and save.
  2. On the list, Monday moves back to the estimate note, and its day line shows "Out of date".
- **Edge cases.**
  - `/plan/shopping?start=2031-13-40` returns a 404 page.
  - `/plan/shopping?start=2040-01-01` shows "No plan for that date" with a link to `/plan`.
  - Signed out, `/plan/shopping` redirects to `/auth/signin`.
- **Dashboard link.** It shows **Shopping list** when a plan exists. On a fresh account with no plan it is absent.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: In-place check-off island

### Overview

Make ticking items in a store fast: no reload and no lost scroll position. The island reuses the same API and the same server-rendered markup, and the forms still work without JavaScript.

### Changes Required:

#### 1. API JSON mode

**File**: `src/pages/api/plan/shopping.ts`

**Intent**: Let the island call the route without following redirects.

**Contract**:

- When the request's `Accept` header includes `application/json`, respond:
  - `200 {"ok":true,"checked":boolean}`;
  - `400 {"ok":false,"message"}` for validation or KD errors;
  - `401 {"ok":false,"message"}` when signed out;
  - `500 {"ok":false,"message"}` otherwise.
- The redirect behaviour is unchanged for plain form posts. Messages come from the same `SHOPPING_ERRORS` map.

#### 2. Island

**File**: `src/components/shopping/ShoppingList.tsx` (new), with a hook in `src/components/hooks/useShoppingChecks.ts`

**Intent**: Render the aisle sections, items, summary count and error notice from the server-built `ShoppingList` props, in the same markup and testids as Phase 3. Intercept each item form's submit and toggle optimistically.

**Contract**:

- **Props.** `{ startDate: string; aisles: ShoppingAisle[]; itemCount: number; initialCheckedCount: number; labels: { aisles: Record<StoreAisle, string> } }`. The page passes `AISLE_LABELS` as `labels.aisles`, so `recipe-labels.ts` stays the single label map.
- **Imports.** The island imports only from the pure `src/lib/services/shopping-list.ts` (`formatShoppingSummary`, `formatShoppingAmount`, `SHOPPING_SAVE_FAILED`), never from `shopping.ts` or `day-solutions.ts`, so no solver, zod or Supabase code ships to the client. Item amounts are formatted in the island with `formatShoppingAmount`.
- **Toggle.** On submit, `preventDefault`, flip local state, then `fetch("/api/plan/shopping", { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } })`.
- **Failure.** On a non-OK response or a network error, revert that item and show the returned message, or `SHOPPING_SAVE_FAILED`, in an `aria-live="polite"` notice.
- **Double taps.** While a request is in flight the item's button is disabled.
- **Hydration.** `client:idle`. Astro server-renders the island, so the HTML contains the forms before hydration.

#### 3. Page wiring

**File**: `src/pages/plan/shopping.astro`

**Intent**: Replace the inline list markup from Phase 3 with `<ShoppingList client:idle … />`. Keep the header, the source notes and the links in `.astro`.

**Contract**: The rendered HTML keeps every Phase 3 testid, `id` and form field. The summary `<p data-testid="shopping-summary">` moves inside the island so its count updates live, and is still server-rendered.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Types check: `npx astro check`
- Unit tests pass: `npm test`
- Build succeeds: `npm run build`
- Existing smoke still passes against the preview: `npm run preview`, then `npm run smoke`

#### Manual Verification:

Run `npm run dev` and open `/plan/shopping?start=2031-02-03` as account A in Chrome. Open DevTools and set device emulation to iPhone (390 px).

- **In-place toggle.**
  1. Scroll to the Spices aisle and tap **Sól**.
  2. It strikes through instantly and the page does not reload or scroll.
  3. The summary count increases by one.
  4. The Network tab shows one `POST /api/plan/shopping` returning `200` JSON.
- **Persistence.** Reload: **Sól** is still checked.
- **Failure revert.**
  1. In DevTools → Network, set throttling to **Offline** and tap an unchecked item.
  2. It ticks, then reverts within a moment, and a message appears ("…could not be updated…").
  3. Set the network back to Online and tap again: it sticks.
- **No-JS fallback.**
  1. In DevTools → Settings → Debugger, check "Disable JavaScript" and reload.
  2. Tapping an item reloads the page at that item, checked, as in Phase 3.
  3. Re-enable JavaScript.
- **Partner.** As B, in a private window, reload the list: A's in-place ticks are visible.
- **Layout at 390 px.** No horizontal scroll. Long product names wrap. Each tap target is at least ~44 px tall.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 5: Smoke coverage and documentation

### Overview

Prove the slice end to end over HTTP against the production preview, and record its rules where the next slices (S-10, S-11, S-14) will look.

### Changes Required:

#### 1. Smoke script

**File**: `scripts/smoke.mjs`

**Intent**: Add an S-09 section that runs after the accounts are linked and the S-08 section has finished, plus two shared-batch assertions placed inside the S-08 sequence (see the last bullet).

**Contract**:

- **Anonymous access.** `GET /plan/shopping` and `POST /api/plan/shopping` redirect a signed-out client to `/auth/signin`.
- **Fresh unsolved plan.**
  - A saves plan `2031-01-27` with two seed recipes that share at least one product, e.g. `seedRecipe1` and `seedRecipe2` if they share salt. If they do not, pick a pair that does.
  - `/plan/shopping?start=2031-01-27` shows the estimate note (pinned with `testIdBody("shopping-estimate")`) and a `shopping-day-0` line with `Not solved` (pinned with `testIdItem()`).
  - One product's line (`<li data-testid="item-<id>">` containing the formatted amount, matched by a new `testIdItem()` regex helper) is **pinned from an SQL oracle**. Run the query once at implementation time and pin its result as a constant, documenting the query in a comment above the fixture (as the S-05 fixtures do): `select p.id, p.name, sum(ri.base_amount_g) from recipe_ingredients ri join recipe_components rc on rc.id = ri.component_id join products p on p.id = ri.product_id where rc.recipe_id in (…) group by p.id, p.name`.
  - The pinned `shopping-summary` item count also comes from that query (distinct products).
  - Each `aisle-*` section appears in enum order (compare index positions in the HTML).
- **Check-off.**
  - A checks the pinned product with a form POST. Expect a redirect to `…#item-<id>` and `data-checked="true"` on reload.
  - B, signed in, sees it checked.
  - B unchecks it; A sees `data-checked="false"`.
  - Checking a product the plan does not use redirects with the KD019 message.
  - **JSON mode.** Add a `headers` option to `makeClient().request()` (`smoke.mjs:46-64`), merged after the defaults. After the cross-partner steps above (so the pinned product's final unchecked state, which manual 5.10 confirms, is unaffected), A checks a **second** product of the plan with `Accept: application/json`, then unchecks it the same way. Each returns `200`, and its `check:` parses `{"ok":true,"checked":…}` with the expected boolean.
- **Solved plan with a shared batch** — inserted **into the S-08 sequence**, not into the S-09 section, because later S-08 steps make 2031-01-20 stale (B's eater-only edit, `smoke.mjs:906-914`) and then drop the share (the Leczo swap, `:938-951`). Leave a comment at both insertion points saying S-09 depends on that state, so a future edit to S-08 keeps them in place:
  - Right after "A plan page shows both days of the group with one identical status" (`smoke.mjs:876-880`), while the group is solved and shared: `/plan/shopping?start=2031-01-20` shows the exact note naming Monday and Tuesday, and every product appears at most once (no duplicate `item-<id>` testids). Assert structure only; the solved quantities are not pinned from SQL.
  - Right after "both days of the group are out of date" (`:910-914`): the same page shows both days in the estimate note and no exact note. This covers manual step 3.11's stale fallback over HTTP.
- **Debugging aid.** Add the new testids to the failure dump.

#### 2. CLAUDE.md

**File**: `CLAUDE.md`

**Intent**: Record the slice's rules for future agents.

**Contract**:

- Add `shopping_list_checks` (S-09) to the **Write-revoked tables** paragraph. Writes go only through `public.set_shopping_item_checked`, and the revoke list includes `maintain`.
- Add a **Shopping list (S-09)** architecture bullet covering:
  - the migration;
  - derived-never-stored;
  - one base batch per dish for non-current groups;
  - exact amounts from any current row via `getPlanSolveState()`, the single currency rule;
  - dedup by the plan's `dishId`;
  - KD018/KD019;
  - the no-membership-FK warning;
  - the files involved;
  - the JSON-vs-redirect API contract.
- Update the `npm test` note to list `shopping-list.test.ts`.

#### 3. README

**File**: `README.md`

**Intent**: Document the user-facing route and the smoke coverage, and make the cleanup note complete.

**Contract**:

- Add a `/plan/shopping` row to the Auth routes table.
- Add an "For S-09 …" smoke paragraph.
- Add one sentence to "Cleaning up after smoke runs": shopping checks cascade with their plan and household, so no extra step is needed.

#### 4. Change identity

**File**: `context/changes/shopping-list-from-plan/change.md`

**Intent**: Keep the status current as the implementation progresses. Planning already sets `planned`.

### Success Criteria:

#### Automated Verification:

- Isolation test passes: `npm run test:rls`
- Seed integrity passes: `npm run test:seed`
- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Types check: `npx astro check`
- Production preview smoke passes: `npm run build && npm run preview`, then `npm run smoke`
- Deploy gate passes: `npm run check:migrations`

#### Manual Verification:

- Run `BASE_URL=http://localhost:4321 npm run smoke` against `npm run preview`. The output contains the new S-09 step messages and ends successfully.
- Open the README Auth routes table and confirm the `/plan/shopping` row. Follow it in the running preview: it opens the most recent plan's list for a signed-in user.
- In the running preview, sign in as one of the `smoke-…@example.com` accounts the run just created (password from the script's constant).
  - Open `/plan/shopping?start=2031-01-27` and confirm what smoke asserted: the estimate note, the pinned product's amount, and its final unchecked state.
- In the running preview, as account A from Phase 3's manual steps, open `/plan/shopping?start=2031-02-10` (the hand-built shared batch, solved) and confirm each product appears once with the exact-amounts note. Do not use the smoke account's 2031-01-20 plan: smoke leaves it stale and unshared.
- After merging (push to `main`), wait for the `deploy` job to go green. Then open https://duo-kitchen.mediewilnp.workers.dev/dashboard → **Shopping list** on a real account and tick one item on a phone. It ticks in place, and the tick is still there after reload.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- `shopping-list.test.ts`, the pure builder:
  - base sums;
  - same-day and cross-day shared-batch dedup;
  - mixed exact/estimate plans;
  - piece totals and float rounding;
  - aisle and Polish ordering, plus determinism;
  - check overlay and ignored stale checks;
  - diagnostics and fallback.
- The existing `macro-solver.test.ts` and `day-solutions.test.ts` must stay green. They guard against the refactor drifting from S-04/S-08 behaviour.

### Integration Tests:

- `household_isolation.sql`: household isolation, write revokes including `maintain`, the RPC's idempotency and every KD code, cross-household KD014, anon denial, and checks staying behind on redemption.
- `smoke.mjs`:
  - anonymous redirects;
  - the SQL-pinned base amount and item count;
  - aisle order;
  - check/uncheck across partners;
  - the KD019 message;
  - JSON mode;
  - shared batch appearing once on a solved plan, and both days falling back to the estimate note once stale (both asserted inside the S-08 sequence).

### Manual Testing Steps:

1. Build an unsolved plan and open its list. Verify aisle grouping, the combined salt amount and the estimate note.
2. Check and uncheck as A and confirm B sees it. Then repeat in place with JavaScript and verify the offline revert.
3. Solve a day. Verify that its amounts match the day page, the note says exact, and checks survive.
4. Open a plan with a shared batch and verify a batch-only product is counted once.
5. Make an eater-only edit and verify the day falls back to estimate ("Out of date").

## Performance Considerations

- A render runs:
  - one plan read;
  - `getPlanSolveState()`: one `plan_day_solutions` read, the household, targets and solver-recipe reads, and one SHA-256 per group;
  - one ingredient→product read;
  - one checks read.
- No LP runs, so a render is within `/plan`'s existing cost plus two small reads. That stays well inside the Workers Free 10 ms CPU budget.
- A toggle is one RPC: a household lookup, a plan lookup and, on a check, one `exists` join over a plan's few dishes. It needs no further work.

## Migration Notes

- The migration is additive: a new table and a new function. Nothing existing changes, so there is no backfill.
- Order before merging: `npx supabase db push`, then `npm run test:rls`. CI checks the deployed schema, and the `deploy` job's `check:migrations` gate fails otherwise.
- Rollback:

  ```sql
  drop function public.set_shopping_item_checked(date, uuid, boolean);
  drop table public.shopping_list_checks;
  ```

  Then revert the app commit. Nothing else references the table.

## References

- Research: `context/changes/shopping-list-from-plan/research.md`
- Roadmap entry: `context/foundation/roadmap.md:232-243`; PRD US-02 `prd.md:62-65`, FR-021 `prd.md:111`
- Table + RPC template: `supabase/migrations/20261009120000_plan_day_solutions.sql`
- Currency rule to refactor: `src/lib/services/day-solutions.ts:307-367`
- API route template: `src/pages/api/plan/solve.ts`
- Page pattern: `src/pages/plan/day.astro`
- Shared-batch dedup rule: `context/changes/shared-dish-across-days/plan.md:122-130`
- Amount formatting: `src/lib/services/recipe-macros.ts:62-81`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Check-off table and RPC

#### Automated

- [x] 1.1 Migration applies to the hosted project: `npx supabase db push`
- [x] 1.2 Isolation test passes: `npm run test:rls`
- [x] 1.3 Seed integrity still passes: `npm run test:seed`
- [x] 1.4 Deploy gate sees no missing migration: `npm run check:migrations`

#### Manual

- [ ] 1.5 Supabase dashboard shows the table with RLS and exactly four authenticated policies
- [ ] 1.6 Privilege query returns `false | false` for authenticated INSERT and anon EXECUTE
- [ ] 1.7 `/plan` save and day Solve still work in the running app

### Phase 2: Pure list builder and shared solve state

#### Automated

- [ ] 2.1 Unit tests pass, including the existing solver and day-solutions suites: `npm test`
- [ ] 2.2 Lint passes: `npm run lint`
- [ ] 2.3 Types check: `npx astro check`
- [ ] 2.4 Build succeeds: `npm run build`

#### Manual

- [ ] 2.5 `npm test -- shopping-list` lists the shared-batch, mixed-plan and ordering cases as passing
- [ ] 2.6 `/plan` day statuses and a solved `/plan/day` page are unchanged after the refactor

### Phase 3: Shopping page, check-off API and navigation (no JavaScript)

#### Automated

- [ ] 3.1 Unit tests pass: `npm test`
- [ ] 3.2 Lint passes: `npm run lint`
- [ ] 3.3 Types check: `npx astro check`
- [ ] 3.4 Build succeeds: `npm run build`
- [ ] 3.5 Existing smoke still passes against the preview

#### Manual

- [ ] 3.6 Unsolved plan list shows aisles in order, combined salt and the estimate note
- [ ] 3.7 Check-off reloads at the item, strikes it through and updates the count; unchecking reverts
- [ ] 3.8 Partner sees and can change the same checks
- [ ] 3.9 Solving a day switches it to exact amounts matching the day page; checks survive
- [ ] 3.10 Shared batch product is counted once on a hand-built, solved 2031-02-10 plan
- [ ] 3.11 Eater-only edit moves the day back to estimate ("Out of date")
- [ ] 3.12 Malformed date returns 404, a date with no plan shows the no-plan message, signed-out access redirects
- [ ] 3.13 Dashboard shows the Shopping list link only when a plan exists

### Phase 4: In-place check-off island

#### Automated

- [ ] 4.1 Lint passes: `npm run lint`
- [ ] 4.2 Types check: `npx astro check`
- [ ] 4.3 Unit tests pass: `npm test`
- [ ] 4.4 Build succeeds: `npm run build`
- [ ] 4.5 Existing smoke still passes against the preview

#### Manual

- [ ] 4.6 Tapping an item toggles in place with one JSON POST and no reload or scroll
- [ ] 4.7 The tick persists after reload
- [ ] 4.8 Offline tap reverts with a message; online tap sticks
- [ ] 4.9 With JavaScript disabled the form fallback still works
- [ ] 4.10 Partner sees in-place ticks on reload
- [ ] 4.11 No horizontal scroll and adequate tap targets at 390 px

### Phase 5: Smoke coverage and documentation

#### Automated

- [ ] 5.1 Isolation test passes: `npm run test:rls`
- [ ] 5.2 Seed integrity passes: `npm run test:seed`
- [ ] 5.3 Unit tests pass: `npm test`
- [ ] 5.4 Lint passes: `npm run lint`
- [ ] 5.5 Types check: `npx astro check`
- [ ] 5.6 Production preview smoke passes, including the S-09 section
- [ ] 5.7 Deploy gate passes: `npm run check:migrations`

#### Manual

- [ ] 5.8 Smoke output shows the S-09 steps and ends successfully
- [ ] 5.9 README documents `/plan/shopping` and the link works in the preview
- [ ] 5.10 Smoke account's 2031-01-27 list matches what smoke asserted; the hand-built 2031-02-10 list shows each product once
- [ ] 5.11 After deploy, ticking an item on production on a phone works and persists
