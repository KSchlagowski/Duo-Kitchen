---
date: 2026-10-13T12:00:00+02:00
researcher: Claude (Opus 5.5)
git_commit: d889c627a278f20ffd1cf93c3db0b43ae81b0001
branch: feat/s-09-shopping-list-from-plan
repository: KSchlagowski/Duo-Kitchen
topic: "S-09 shopping-list-from-plan: combined, aisle-grouped shopping list from the meal plan with online check-off (US-02, FR-021)"
tags: [research, codebase, shopping-list, meal-plans, plan-day-solutions, macro-solver, products, rls, smoke]
status: complete
last_updated: 2026-10-13
last_updated_by: Claude (Opus 5.5)
---

# Research: S-09 — shopping list from the plan

**Date**: 2026-10-13T12:00:00+02:00
**Researcher**: Claude (Opus 5.5)
**Git Commit**: d889c627a278f20ffd1cf93c3db0b43ae81b0001 (on `origin/main`; the branch has no commits of its own yet)
**Branch**: feat/s-09-shopping-list-from-plan
**Repository**: KSchlagowski/Duo-Kitchen

Permalink base for every `path:line` below:
`https://github.com/KSchlagowski/Duo-Kitchen/blob/d889c627a278f20ffd1cf93c3db0b43ae81b0001/<path>#L<line>`

## Research Question

Roadmap item S-09 (`context/foundation/roadmap.md:232-243`): the user can open a shopping list generated from the plan. It shows combined quantities for both people, is grouped by store aisle, and lets them check items off online (PRD US-02 `prd.md:62-65`, FR-021 `prd.md:111`; prerequisite S-03). `change.md` holds only the roadmap line, so it adds no constraints beyond the roadmap entry.

The one recorded Unknown (`roadmap.md:241`, owner: user, non-blocking) is: *"Which quantities feed the list for an unsolved plan (recipe base quantities?) and how does it update after solving?"*

This was a non-interactive session, so no questions were asked. Assumptions are marked **[Assumption]**, and the Open Questions section collects them.

## Summary

- **Nothing shopping-related exists yet.** There is no table, service, route or label for it. Every input the list needs already exists:
  - **The plan:** `getMealPlan()` (`src/lib/services/meal-plans.ts:113-151`) returns meals with `dishId`, `recipeId` and `eaterUserId`.
  - **Solved quantities:** stored per day in `plan_day_solutions.result` (jsonb `DaySolution`, `src/types.ts:277-290`). They must be read through the zod gate `getDaySolutions()` / `parseStoredSolution()` (`src/lib/services/day-solutions.ts:100-234`). The CLAUDE.md hand-off mandates this.
  - **Base (unsolved) quantities:** `recipe_ingredients.base_amount_g`, read today by `getSolverRecipes()` (`src/lib/services/recipes.ts:230-267`). One base batch is "one sensible batch for two people" (`archive/2026-10-07-seed-products-and-recipes/plan.md:305`).
  - **Aisle:** `products.aisle` (`public.store_aisle` enum, `supabase/migrations/20261007120000_products_and_recipes.sql:15-17`; the table is now public, `20261008150000_shared_recipe_library.sql:294-308`).
- **The stored solution does not carry the product id or the aisle.** `DaySolutionIngredient` (`src/types.ts:216-226`) has `id`, `productName`, `amountG`, `gramsPerPiece`, `allowHalfPieces` and `perPerson`. Its `id` is the **library `recipe_ingredients.id`**, set in `buildComponent()` (`src/lib/services/macro-solver.ts:857-860`), so the list must join `recipe_ingredients.id → product_id → products(aisle)`. `getSolverRecipes()` does not select `product_id` or `aisle` today (`recipes.ts:158-159`).
- **Shared batches must be counted once.** Since S-08, every meal of a shared dish carries the **full batch** `amountG` (`macro-solver.ts:849-873`, `types.ts:236-243`). CLAUDE.md requires S-09 to deduplicate by `meals[].batch.dishId`, counting each `dishId` once across the plan, and never to re-derive quantities. When `batch` is null, the meal is its own dish.
- **"Current" must be decided group by group.** A plan can mix solved, stale, unsolvable and unsolved solve groups. `getPlanSolveStatuses()` (`day-solutions.ts:307-367`) already holds the canonical rule: a group is current only when every one of its days has a parsed row carrying the group fingerprint. It returns only a status, though, not the parsed solutions, so S-09 needs a sibling or refactor that exposes them.
- **Check-off needs the slice's only new table.** It is household-scoped (FR-003: linked accounts share shopping lists; F-04 `plan.md:262`: "households own only what is theirs (plans, shopping lists)"). It must follow the household-scoped hard rule. If it uses an RPC, the next free SQLSTATE is **KD018**; KD001–KD017 are claimed and KD006 is retired (`supabase/migrations/20261011120000_shared_dishes.sql:19-25`).
- **The data is small.** The hosted library has 46 products and 8 recipes; 41 distinct products are used across 69 ingredient rows. Every aisle except `other` already has more than one product in use. Several products recur across recipes: salt appears in 9 rows across 6 recipes, pepper in 5, garlic (a piece product) in 4 recipes, and olive oil in 4. Combining therefore matters even on seed data. Five piece products are in use (garlic, egg, banana, two bread rolls).

## Detailed Findings

### 1. The plan model the list is generated from

- `meal_plans` holds one row per household per `start_date`, covering 3 days (`supabase/migrations/20261008170000_meal_plans.sql:46-58`). Several plans can exist, and they may overlap: `unique (household_id, start_date)` is the only constraint. The S-03 research already flagged that "S-09/S-10 consume one plan at a time" (`archive/2026-10-08-plan-three-day-grid/research.md:347`).
- `plan_dishes` is one cooked batch of one recipe (`meal_plans.sql:63-80`). `plan_meals` is one filled slot that eats from a dish (`meal_plans.sql:82-105`). Since S-08 a dish may feed several meals, possibly on several days (`20261011120000_shared_dishes.sql:43-54`).
- `getMealPlan(supabase, startDate?)` (`meal-plans.ts:110-151`) returns that date's plan, or with no date the **most recently saved** plan (`updated_at`). It maps every meal to a `PlanMealRecord` with `mealId`, `dishId`, `dayIndex`, `mealType`, `recipeId` and `eaterUserId` (`types.ts:115-139`).
- The dish is the natural shopping unit. Each `dishId` is cooked once, so a dish's ingredients enter the list exactly once whatever the number of meals or eaters.
- Eaters do not change *what* is bought, only how much (and only once solved). "Combined quantities for both people" (US-02) means the list sums every dish of the plan regardless of whose meal it is.

### 2. Solved quantities: the stored jsonb and its rules

- **Storage.** `plan_day_solutions` holds one row per `(plan_id, day_index)`, with `status`, `accepted_tolerance_pct`, `input_fingerprint` and the `result` jsonb (`20261009120000_plan_day_solutions.sql:39-55`). Since S-08 its only writer is `save_plan_day_solutions` (`shared_dishes.sql:328-432`).
- **Shape.** `DaySolution` (`types.ts:277-290`) has `meals[]`. Each meal has `components[].ingredients[]` with:
  - `amountG`, the **batch cook amount**, already rounded to cookable quantities. For a per-person component it is the sum of the eaters' amounts (`types.ts:216-226`, `macro-solver.ts:851-873`).
  - `gramsPerPiece` and `allowHalfPieces`, for display.
  - `perPerson`, which holds the meal's own eaters only.

  `meals[].batch` is `{ dishId, cookDayIndex, mealIds }`, or null for a batch cooked for that meal alone (`types.ts:236-255`, `macro-solver.ts:989-997`).
- **Deduplication rule** (CLAUDE.md, S-08 bullet; `changes/shared-dish-across-days/plan.md:122-130`, `plan-brief.md:38`). Every day of a shared dish carries the dish's full component data with the batch `amountG`. S-09 must count each `batch.dishId` once across the whole plan. A meal whose `batch` is null is keyed by its `mealId`, because the solver emits `batch: null` exactly when `dish.mealIndexes.length === 1` (`macro-solver.ts:990`). Within one current solve group, the stored `mealId`s equal the plan's `mealId`s, since the fingerprint covers them (`macro-solver.ts:1100`). So a null-batch meal can also be mapped back to `PlanMealRecord.dishId` and the whole list keyed uniformly by `dishId`.
- **Zod gate.** The stored jsonb is client-assertable: any household member can call the RPC with any object up to 64 KB. Every consumer must read it through `daySolutionSchema` (`day-solutions.ts:100-200`). A row that fails the schema reads as "not solved" (S-04 `reviews/impl-review.md:40-63`). Fields added later must be `.nullable().default(null)` (S-08 `reviews/plan-review.md:222-249`). S-09 adds no fields to the jsonb.
- **Staleness.** A stored row is current only if its `input_fingerprint` equals the fingerprint of the **group's** current inputs (`day-solutions.ts:283-299`, `:338-352`). Computing that fingerprint needs members, targets and solver recipes (`loadSharedInputs`, `day-solutions.ts:69-88`), plus `solveFingerprint()` (`macro-solver.ts:1087-1135`). `save_meal_plan` keeps meal ids across eater-only edits, so ids alone cannot detect staleness (`plan_day_solutions.sql:11-13`).
- **Groups never split a dish.** `solveGroups()` (`macro-solver.ts:100-132`) joins meals that share a dish or a day. Every meal of a dish is therefore in one group, and that group is either wholly current or wholly not. A dish can never be half solved, half base.
- **Status semantics.**
  - `solved` means the group fits within the accepted tolerance. An accepted ±15/20 % is stored as `solved` (`statusFor`, used at `src/pages/api/plan/solve.ts:130`).
  - `needs_confirmation` is a best fit not yet accepted.
  - `no_fit` means nothing fits within ±20 %. Even then the row stores fully rounded amounts.
- **What exists to reuse.** `getPlanSolveStatuses(supabase, plan)` (`day-solutions.ts:307-367`) already loads every stored row once, loads the shared inputs once, fingerprints every group and classifies it. It discards the parsed `DaySolution`s, though. S-09 needs the same computation returning, per group, the current parsed solutions (or none). The cleanest options:
  - (a) Extract the inner loop into an exported `getPlanSolveState()` that returns `{ statuses, currentSolutions }`, with `getPlanSolveStatuses()` delegating to it.
  - (b) Duplicate the logic in the shopping service.

  Option (b) risks a third staleness rule. S-08's impl-review F4 was exactly such a divergence between `/plan` and `/plan/day` (`changes/shared-dish-across-days/reviews/impl-review.md:89-97`).

### 3. Base (unsolved) quantities

- `recipe_ingredients.base_amount_g` holds one base batch per recipe (`20261008150000_shared_recipe_library.sql:339-354`; F-02 `plan.md:85`). One base batch is "one sensible batch for two people", and every base amount is a multiple of its rounding step, or a whole or half multiple of `grams_per_piece` (F-02 `plan.md:82`, `:305`). So base amounts are already shoppable quantities.
- F-02's research named S-09 as a consumer of base quantities: "unsolved list uses base quantities, see S-09 Unknown" (`archive/2026-10-07-seed-products-and-recipes/research.md:71`).
- `getSolverRecipes(supabase, recipeIds)` (`recipes.ts:228-267`) already returns `baseAmountG`, `productName`, `gramsPerPiece` and `allowHalfPieces` per ingredient for any set of recipes. It does **not** return `product_id` or `aisle`.
- **Extending `SolverIngredient` is fingerprint-safe.** `solveFingerprint()` lists ingredient fields explicitly (`macro-solver.ts:1118-1131`), so an added `productId` or `aisle` would not stale every stored solve. It would, however, ripple into the solver fixtures (`src/lib/services/macro-solver.fixtures.ts`, 340 lines), which construct `SolverIngredient` literals.
- **Alternative to extending:** a separate read of `recipe_ingredients(id, product_id, products(id, name, aisle, grams_per_piece))` for the plan's ingredient ids. It doubles as the lookup that maps a **stored** ingredient id to its product and aisle (section 2).
- **[Assumption]** A dish of an unsolved, stale or unsolvable group contributes one base batch per dish, whatever the eaters. This is the hypothesis the roadmap Unknown proposes, and the "batch for two people" convention is consistent with it. It is an estimate: a meal for one person still buys a two-person batch. The UI should say which days' amounts are estimates (see section 7).

### 4. Products, aisles and units

- **Aisles.** `public.store_aisle` is `produce, dairy, meat_fish, bakery, dry_goods, spices, frozen, other`. That matches FR-021's fixed list in order (`products_and_recipes.sql:15-17`) and the TS type `StoreAisle` (`types.ts:22`). Aisles are stored as language-neutral keys "S-14 translates" (F-02 `research.md:64`). No aisle labels exist yet. The single label map is `src/lib/recipe-labels.ts` (CLAUDE.md: "every enum label lives in `src/lib/recipe-labels.ts`, the single map S-14 localises"), so an `AISLE_LABELS: Record<StoreAisle, string>` belongs there.
- **Products.**
  - `products` is a public library table with `name text not null unique`, `aisle not null`, `grams_per_piece` (nullable: counted in pieces when set) and `rounding_step_g` (`shared_recipe_library.sql:294-308`).
  - It is read-only to clients, with no `household_id` and a select-only policy (`:421-449`).
  - A household-owned row may reference it with a plain FK. The reverse is never allowed (CLAUDE.md, Public library tables).
  - S-07 (not started) will add user-created products with `created_by`. Combining must therefore key on `product_id`, not the name, even though names are unique today.
- **Units.** Grams are the only stored unit; liquids are grams at density ≈ 1 (F-02 `plan.md:82`, `:55`). Piece products display as pieces plus grams through `formatIngredientAmount(amountG, gramsPerPiece, allowHalfPieces)` (`src/lib/services/recipe-macros.ts:62-81`, used by `/plan/day` at `src/pages/plan/day.astro:277-281`).
  - `allowHalfPieces` is a flag on the recipe *ingredient*, not the product, so a summed total has no single value. Since every summed amount is a whole or half multiple of `grams_per_piece`, the list can pass `allowHalfPieces = true` for a total that is a half multiple, or format pieces itself.
  - Sums of `numeric(7,1)` values can pick up float noise, so round the total to 0.1 g before display. The precedent is `roundHalfUp`'s `toFixed(6)` pass (`recipe-macros.ts:41-45`).
- **Spices and salt** are 1 g-step amounts (`prd.md:46`). On the list they will read like "Sól 9 g". The user mostly checks them off as "already have it", which is exactly what FR-021 calls for: check off "what they already have" (`prd.md:65`).

### 5. Check-off persistence: the new table

Constraints that apply (CLAUDE.md hard rules, plus precedents):

- `household_id uuid not null references public.households on delete cascade`, indexed. Four per-operation policies `to authenticated` using `household_id in (select private.user_household_ids())`. No `anon` policies, and no `household_members` reference inside a policy.
- The isolation catch-all (`supabase/tests/household_isolation.sql:1367-1412`) checks every `public` table with `household_id`. It needs all four operations covered even if writes are revoked.
- Tie the row to its plan with a composite FK `(plan_id, household_id) → meal_plans (id, household_id) on delete cascade`, like `plan_day_solutions` (`plan_day_solutions.sql:51-52`). A check then cannot name another household's plan, and it cascades with the plan.
- `product_id → public.products` as a **plain** FK. This direction (household → library) is the allowed one.
- **No per-person membership FK.** Checks are household-owned and stay behind with the plan on redemption. The `(household_id, user_id) → household_members … on update cascade` FK would fail `redeem_household_invite()` with 23503 (warnings at `meal_plans.sql:18-25`, `plan_day_solutions.sql:15-19`). A `checked_by` column, if wanted, would be a plain `auth.users on delete set null` FK like `plan_meals.eater_user_id` (`meal_plans.sql:89-92`).
- **The revoke list must include `maintain`** (PG17 default grant; `20261008160000_library_revoke_maintain.sql`, S-03 `plan.md:34`). `macro_targets` and `household_invites` still lack it, an open gap recorded in S-03 `research.md:346`. S-09 should not copy those two as templates.

Two write designs fit the rules:

| | A. Direct writes under RLS (the `macro_targets` pattern) | B. Write-revoked table + definer RPC (the `meal_plans` / `plan_day_solutions` pattern) |
|---|---|---|
| Write path | `supabase.from(...).upsert/delete` with insert/update/delete policies on the helper predicate | `public.set_shopping_item_checked(p_start_date date, p_product_id uuid, p_checked boolean)`, `security definer`, `set search_path = ''`, revoke from `public, anon`, grant to `authenticated` |
| Household resolution | The client must send `household_id` (there is no default), and the service would have to read it first | Resolved server-side, as in `save_plan_day_solutions` (`shared_dishes.sql:340-344`) |
| Validation errors | Postgres FK/check errors (23503 / 23514), no KD codes | Distinct KD codes: claim **KD018** (malformed argument / unknown product), reuse KD007 (no caller/household) and **KD014** ("no meal plan for that start date", `plan_day_solutions.sql:143-149`) |
| Isolation test | Strict cross-household insert probes, as for `macro_targets` | Copy the `plan_day_solutions` blocks: revoke asserts (`household_isolation.sql:1583-1626`), anon RPC probe (`:1334-1346`), KD table (`:1064-1131`), B cross-household KD014 (`:1201-1231`) |
| CLAUDE.md upkeep | Add a household-scoped bullet | Add the table to the "Write-revoked tables" sentence, as S-03 and S-04 did |

**[Assumption / recommendation]** B. It matches every other plan-family table, resolves the household and plan server-side, gives the API precise KD-mapped messages, and keeps one write path per table. The cost is one plpgsql function and its test blocks.

Suggested shape (to be fixed in `/10x-plan`):

```
shopping_list_checks(
  household_id uuid not null → households on delete cascade,
  plan_id uuid not null, (plan_id, household_id) → meal_plans on delete cascade,
  product_id uuid not null → products,
  checked_at timestamptz not null default now(),
  primary key (plan_id, product_id))
```

- A row means "checked". Un-checking deletes the row. Both writes are idempotent, so two partners tapping the same item concurrently converge (last write wins). That is enough for "online, not live" (FR-021, `prd.md:111`). Real-time sync and offline check-off are explicitly v2 or non-goals (`prd.md:128`, `:163-164`; roadmap Parked `:344-345`).
- **[Assumption]** A check is keyed on `(plan, product)` and survives quantity changes. For example, an item checked while the plan was unsolved stays checked after solving changes its amount. A check for a product that leaves the list is ignored on render and reappears if the product returns. An alternative is to store `checked_amount_g` and flag "amount changed since checked". It adds complexity and is listed under Open Questions.
- Plan deletion and household deletion cascade the checks away. The README cleanup queries (`README.md` "Cleaning up after smoke runs") need no extra step, only a sentence, as S-04 added for `plan_day_solutions`.

### 6. Routes, auth and app conventions

- **Route.**
  - `src/middleware.ts:4-11` protects `["/dashboard", "/targets", "/plan", "/recipes"]` by `pathname.startsWith`. **`/plan/shopping` is protected for free**, as `/plan/day` is. A top-level `/shopping` would need a new `PROTECTED_ROUTES` entry.
  - `/api/*` routes are not protected by middleware. Each must redirect anonymous callers itself (`src/pages/api/plan/solve.ts:48-52`).
- **Page pattern** (`src/pages/plan/day.astro`, `src/pages/plan.astro:49-96`):
  - Each read sits in its own try/catch, and a failed read logs `console.error` and shows an "unavailable" line or a 500.
  - A malformed date param is checked with `isIsoDate` (`meal-plans.ts:16-23`).
  - Notices come back via `?error=` / `?saved=1` query params.
  - Display strings the smoke test pins live as exported constants or `format*` functions in the service, never inline in the page.
- **[Assumption]** The page is `/plan/shopping?start=<date>`, and without `start` it uses the most recently saved plan (`getMealPlan` with no date). The dashboard and `/plan` link to it. `/plan/day` returns 404 without a start; a shopping list opened from the dashboard is friendlier with a default.
- **Island vs forms.**
  - Every domain page so far is form-POST → redirect with no island (`plan.astro`, `day.astro`, `targets.astro`). The only React islands are the auth forms (`src/components/auth/*.tsx`).
  - CLAUDE.md allows a `.tsx` island exactly when a component needs state or event handlers, with the narrowest `client:*` directive.
  - Ticking items one by one in a store on a phone is the case where a full reload per tap, with lost scroll position, hurts.
  - Options:
    - (i) A form per item, POST → redirect back to `#item-<productId>`. No JS, trivially smoke-testable, a reload per tap.
    - (ii) A React island checkbox list with optimistic toggle that POSTs to `/api/plan/shopping`, reverting with a message on failure.

    Only `button` is installed from shadcn (`src/components/ui/`); a checkbox would need `npx shadcn@latest add checkbox`, or a native `<input type="checkbox">`.
  - **[Assumption / recommendation]** Use (ii) for in-store usability, with the API also accepting a plain form POST. The smoke script, which is dependency-free HTTP, can then drive it without JS, and the server-rendered list stays the source of truth on reload. `/10x-plan` should decide.
- **Services and types.** Supabase queries and domain logic go in `src/lib/services/` (pages must not call `supabase.from`). DTOs go in `src/types.ts`. Following the S-04 split between the pure `macro-solver.ts` and the I/O `day-solutions.ts`, S-09 fits:
  - A **pure** builder: plan meals + current solutions + base recipes + an ingredient→product map + checks → aisle-grouped items. Unit-testable under `npm test` (vitest, `src/**/*.test.ts`) with no Supabase.
  - An **I/O** wrapper: `getShoppingList(supabase, startDate?)`, `setShoppingItemChecked(...)`, the KD → message map, and the `format*` strings smoke pins.
- **Navigation.**
  - The dashboard shows a `Plan:` line with an "Open plan" / "Start a plan" link (`src/pages/dashboard.astro:48-62`, markup `:118-124`). A shopping link fits right after it.
  - `/plan` already renders the summary (`plan.astro:164`) and per-day links to `/plan/day` (`plan.astro:376`).
  - `src/components/Topbar.astro:9-18` has only Dashboard and Sign out.

### 7. Building the list: proposed algorithm (for `/10x-plan` to confirm)

1. Load the plan: `getMealPlan(supabase, start?)`. With no plan, show "no plan yet" and a link to `/plan`. With a plan but zero meals, show an empty list.
2. Load the per-group solve state once, using the `getPlanSolveStatuses` machinery refactored to also return the current parsed `DaySolution`s (section 2).
3. For each **dish** of the plan, grouping `plan.meals` by `dishId`:
   - **Current group:** take the dish's ingredients from one stored meal of that dish. Use the meal whose `batch?.dishId === dishId`, or for `batch === null` the meal whose `mealId` is the dish's only meal. Use each ingredient's `amountG` as stored. **Never** take them twice and never recompute them.
   - **Otherwise:** take the recipe's base ingredients (`baseAmountG`) once per dish.
4. Map each ingredient id to `{ productId, productName, aisle, gramsPerPiece }` using one read of `recipe_ingredients` joined to `products`. Sum the grams per `productId`, rounding to 0.1.
5. Group by aisle in enum order, then sort products within an aisle with `localeCompare(…, "pl")` (precedent: `recipes.ts:64-72`). Deterministic output is required (NFR, `prd.md:135`).
6. Overlay checks from `shopping_list_checks` for the plan.
7. Show per day, or overall, which amounts are estimates: "Tuesday: recipe base amounts — solve the day for exact amounts". Link to `/plan/day`, reusing `formatPlanDayStatus()` (`day-solutions.ts:398-415`).

**[Assumption]** Step 3 treats a current row of **any** status (`solved`, `needs_confirmation`, `no_fit`) as the source of exact amounts. They are the rounded quantities the day page shows, and they beat base amounts as a prediction. The alternative, only `solved` and base otherwise, is listed under Open Questions.

What re-solving does: the list is derived on every read and **never stored**. Solving, or editing a plan, changes the next render automatically. That answers the second half of the roadmap Unknown with no invalidation machinery. Only the checks are persisted.

Cost per render, on the Workers **Free** plan with a 10 ms CPU budget (S-08 `plan.md` Phase 4 §3):

- one plan read;
- one `plan_day_solutions` read;
- household, targets and solver-recipes reads (already done by `getPlanSolveStatuses`);
- one ingredient→product read;
- one checks read;
- one SHA-256 per group.

No LP runs. That is lighter than `/plan`, which already does all of this except the last two reads.

### 8. Tests and CI touch points

- **`supabase/tests/household_isolation.sql`**: one rolled-back transaction (`:23`, `:2388`). For a new household table + RPC, copy the `plan_day_solutions` set:
  - A/B fixtures as postgres (`:151-183`, next free suffix);
  - A reads only its own rows (`:552-591` pattern);
  - write-revoke probes accepting only `insufficient_privilege` (`:593-653`, `:1018-1050`);
  - an RPC behaviour block with its own start dates (2030-01-01, 2030-02-01, 2030-02-03, 2030-04-01 and 2030-05-01 are taken);
  - a KD table (`:1064-1131` loop idiom, which re-raises a bare `P0001`);
  - B cross-household probe (`:1201-1231`);
  - anon RPC probe (`:1334-1346`);
  - add the table to the anon zero-row loop (`:1348-1365`);
  - grant/revoke asserts including `MAINTAIN` and column-level privileges (`:1583-1626`);
  - append to the summary notice (`:2373-2386`).

  The household catch-all (`:1367-1412`) checks policies automatically. The classification catch-all (`:1414-1502`) needs no change for a `household_id` table.
- **Redemption.** Check rows stay in the origin household with their plan. The redemption blocks (`:1755-1781`, `:1911-1931`, `:2062-2085`) can assert that.
- **`scripts/smoke.mjs`**:
  - Existing plan dates are `2031-01-06` (S-03), `2031-01-13` (S-04) and `2031-01-20` (S-08, `:119`, `:137`, `:207`). Use e.g. `2031-01-27` for a fresh unsolved plan.
  - Base amounts are deterministic, so an unsolved list can be **pinned from an SQL oracle** (sum of `base_amount_g` per product), as S-05 pins its totals.
  - Solved amounts cannot be pinned from SQL: there is no LP in SQL (README, S-04 section).
    - Assert structure and invariants instead: the shared batch of the `2031-01-20` plan is counted once, and partner symmetry holds.
    - Assert exact quantities in a vitest suite over the pure builder.
  - Assert anon redirects for the page and the API (`:408-413` pattern), and check then uncheck with the partner seeing it.
  - Add new testids to the failure dump (`:992-1031`). `testIdBody()` only matches `<p>` elements (`:113`; S-08 `plan.md:~280`).
- **`npm test`**: add e.g. `src/lib/services/shopping-list.test.ts`, and update the CLAUDE.md `npm test` note listing the suites.
- **CI** (`.github/workflows/ci.yml`): `ci` runs lint, `npm test`, astro check and build (`:10-26`). `smoke` runs `test:rls`, `test:seed` and smoke against the **already-deployed** hosted schema (`:28-61`). `deploy` gates on `check:migrations` (`:99-102`).
  - Run `npx supabase db push` before merging, then `npm run test:rls`.
  - Mandated order (S-08 `plan.md:1009-1014`): `db push` → `test:rls` → `test:seed` → `npm test` → `lint` → `astro check` → `build && preview` → `smoke`.
- **Seed integrity.** No seed change is needed. Every aisle already has products (F-02 `plan.md:290,331`).

## Code References

- `src/lib/services/meal-plans.ts:113-151`: `getMealPlan()`, with or without a date; meals carry `dishId`.
- `src/lib/services/meal-plans.ts:47-50`: `formatPlanSummary()`, the precedent for smoke-pinned strings.
- `src/lib/services/meal-plans.ts:69-95`: KD → message map + `errorCode()` to reuse.
- `src/lib/services/day-solutions.ts:100-200`: `daySolutionSchema` / `parseStoredSolution()`, the mandatory gate for jsonb.
- `src/lib/services/day-solutions.ts:204-234`: `getDaySolutions()`.
- `src/lib/services/day-solutions.ts:307-367`: `getPlanSolveStatuses()`, the canonical group-currency rule, to refactor so it also yields the current solutions.
- `src/lib/services/day-solutions.ts:398-415`: `formatPlanDayStatus()`, for per-day "estimate" notes.
- `src/lib/services/macro-solver.ts:100-142`: `solveGroups()`, `groupDayIndexes()`, `cookDayIndex()`.
- `src/lib/services/macro-solver.ts:849-873`: `buildComponent()`. Stored `amountG` is the full batch; ingredient `id` is the library `recipe_ingredients.id`.
- `src/lib/services/macro-solver.ts:989-997`: `batch` is null exactly for single-meal dishes.
- `src/lib/services/macro-solver.ts:1087-1135`: `solveFingerprint()`, with an explicit field list, so new `SolverIngredient` fields would not stale anything.
- `src/lib/services/recipes.ts:158-159, 210-267`: `COMPONENT_COLUMNS` / `getSolverRecipes()`. Base amounts; no `product_id` or `aisle` selected.
- `src/lib/services/recipe-macros.ts:41-45, 62-81`: `roundHalfUp()`, `formatIngredientAmount()` (pieces display).
- `src/lib/recipe-labels.ts`: the single label map; add `AISLE_LABELS` here.
- `src/types.ts:22`: `StoreAisle`. `:115-139`: plan types. `:216-290`: `DaySolution*` types.
- `src/pages/plan/day.astro:247-306`: how stored amounts and batches are rendered, including the cook-day-only rule.
- `src/pages/api/plan/solve.ts:47-143`: API route pattern (anon redirect, `formData` try/catch, zod, error redirect).
- `src/middleware.ts:4-11, 25-28`: `PROTECTED_ROUTES`, prefix match.
- `src/pages/dashboard.astro:48-62, 118-131`: plan line and links; where a shopping link goes.
- `supabase/migrations/20261007120000_products_and_recipes.sql:15-17`: `store_aisle` enum.
- `supabase/migrations/20261008150000_shared_recipe_library.sql:294-308, 339-354, 421-449`: public `products` / `recipe_ingredients` and their select-only RLS.
- `supabase/migrations/20261008170000_meal_plans.sql:18-30, 46-165`: plan tables, the no-membership-FK warning, the write-revoked template.
- `supabase/migrations/20261009120000_plan_day_solutions.sql:39-82`: the closest table template (composite plan FK, `maintain` revoke).
- `supabase/migrations/20261011120000_shared_dishes.sql:19-25, 328-435`: KD numbering up to KD017; the RPC template with revoke/grant.
- `supabase/tests/household_isolation.sql`: section map in section 8.
- `scripts/smoke.mjs:113, 119, 137, 207, 408-413, 992-1031`: helpers, used dates, anon-redirect pattern, testid dump.

## Architecture Insights

- **Derived, not stored.** Like the day page, which never shows a result it did not store, the list should be a pure function of stored state: the plan, current solutions, the library and the checks. Persisting the list itself would create a second staleness problem. Only the user's checks are new state.
- **Pure core, thin I/O shell.** The S-04 split (`macro-solver.ts` pure / `day-solutions.ts` I/O) makes the aggregation unit-testable without Supabase, and keeps smoke to structural assertions plus SQL-pinnable base amounts.
- **One rule per concept.** "Is this group current?" already has one implementation that `/plan` and `/plan/day` agree on, after S-08 F4. S-09 should reuse it, not re-express it.
- **Library ↔ household direction.** Checks (household) → products (library) is the permitted FK direction. Checks → plan through the composite FK keeps them in-household and cascades them with the plan.
- **Both RLS levers.** Whichever write design is chosen, keep policies *and* grants (including the `maintain` revoke), and assert both in the isolation test.

## Historical Context (from prior changes)

- `context/archive/2026-10-07-seed-products-and-recipes/research.md:64-71`: aisle stored as a key for S-14; piece products and base quantities are named for S-09 ("unsolved list uses base quantities").
- `context/archive/2026-10-07-seed-products-and-recipes/plan.md:82-85, 305`: grams are the only stored unit; one base batch is sized for two people.
- `context/archive/2026-10-07-link-partner-household/plan.md:7`: FR-003, partners share shopping lists.
- `context/archive/2026-10-08-shared-recipe-library/plan.md:262`: households own plans and shopping lists. `reviews/impl-review.md:35-43`: the PG17 `MAINTAIN` default grant.
- `context/archive/2026-10-08-plan-three-day-grid/research.md:346-347`: open `MAINTAIN` gap on `macro_targets` / `household_invites`; overlapping plans are fine because S-09 consumes one plan at a time. `reviews/plan-review.md:70-82`: `eater_user_id on delete set null` was chosen partly so S-09 sees no orphan dishes.
- `context/archive/2026-10-09-solve-daily-macros/plan.md:123, 554`: S-09 consumes the stored jsonb and never re-derives quantities. `reviews/impl-review.md:40-63`: why every consumer goes through the zod schema.
- `context/changes/shared-dish-across-days/plan.md:122-130, 950-960` and `plan-brief.md:38`: deduplicate by `batch.dishId`. `reviews/impl-review.md:89-97`: the stale-rule divergence (F4) to avoid repeating. Phase 4 §3: Workers Free plan CPU notes. S-08's change folder is `impl_reviewed`, merged but not archived. `roadmap.md:43` still shows S-08 as `ready`.

## Related Research

- `context/archive/2026-10-09-solve-daily-macros/research.md`: solver output shape and downstream consumption.
- `context/changes/shared-dish-across-days/research.md`: batch and solve-group semantics that S-09 must deduplicate.
- `context/archive/2026-10-08-plan-three-day-grid/research.md`: plan model and the write-revoked pattern.
- `context/archive/2026-10-07-seed-products-and-recipes/research.md`: aisle taxonomy and units.

## Open Questions

Each question has a stated default that the research assumed.

1. **Unsolved quantities** (the roadmap Unknown, owner: user). Default: one recipe **base batch per dish**, labelled as an estimate per day. Alternatives:
   - scale base amounts by eater count (a "both" meal = 1 batch, a single-eater meal = ½ batch). This conflicts with rounding steps and piece rules;
   - hide unsolved days from the list.
2. **Which stored statuses count as exact.** Default: any **current** stored row (`solved`, `needs_confirmation`, `no_fit`). Alternative: only `solved`, with base amounts for the rest.
3. **Check semantics when amounts change.** Default: a check is keyed on `(plan, product)` and survives amount changes. Alternative: store `checked_amount_g` and flag "amount changed since you checked".
4. **Write design for checks.** Default: write-revoked table + `public.set_shopping_item_checked` RPC (KD018 new, KD007 and KD014 reused). Alternative: direct RLS writes (`macro_targets` style).
5. **Interaction model.** Default: a React island with optimistic toggles over an API that also accepts plain form POSTs. Alternative: a no-JS form per item.
6. **Which plan.** Default: `?start=` or else the most recently saved plan, one list per plan; overlapping plans are not merged. Should a list ever span two plans? The PRD's 3-day cycle suggests not.
7. **Showing who checked or per-meal breakdown.** Default: no `checked_by` and no per-recipe breakdown under an item (YAGNI). The spice-blend parent/child display is v2 (`prd.md:130`).
8. **Housekeeping outside S-09.** The `MAINTAIN` gap on `macro_targets` / `household_invites`, archiving S-08, and S-08's roadmap status (`ready` vs merged) are worth a separate chore and are not in S-09's scope.
