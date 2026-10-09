---
date: 2026-10-09T12:47:04+02:00
researcher: Claude (Opus 5.5) for Kamil Schlagowski
git_commit: daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e
branch: feat/1-solve-daily-macros
repository: KSchlagowski/Duo-Kitchen
topic: "S-04 solve-daily-macros: solve a planned day so A and B land within ±10% of their daily macro targets"
tags: [research, codebase, solver, linear-programming, meal-plans, macro-targets, recipe-library, determinism, cloudflare-workers]
status: complete
last_updated: 2026-10-09
last_updated_by: Claude (Opus 5.5)
---

# Research: S-04 solve-daily-macros

**Date**: 2026-10-09T12:47:04+02:00
**Researcher**: Claude (Opus 5.5) for Kamil Schlagowski
**Git Commit**: daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e (on `origin/main`; the branch has no commits of its own yet)
**Branch**: feat/1-solve-daily-macros
**Repository**: KSchlagowski/Duo-Kitchen

## Research Question

Roadmap **S-04** (`context/foundation/roadmap.md:168-180`): *user can solve a planned day (prompted when 5 meals are filled, or manually any time) and see per-ingredient / per-component / whole-dish quantities to cook and how to split them between A and B, with each person's daily totals within ±10%, escalating to ±15% and ±20% on confirmation and then naming the recipe that most hinders a fit.* PRD refs: US-01, FR-018, FR-019, FR-020.

The roadmap leaves two Unknowns open:

1. Can a deterministic solver that respects rounding steps, minimum amounts and half-piece rules fit the edge runtime's CPU budget in pure JS or WASM?
2. How is "the recipe that most hinders a fit" chosen so the explanation is stable and reproducible?

`change.md` adds no constraints beyond the roadmap pointer. This was a non-interactive session, so no scope questions were asked. Assumptions are marked **A1…A12** inline. The plan should confirm or overturn them.

## Summary

- **All inputs exist; nothing stores or computes a solve yet.** Targets come from `macro_targets`: one row per person, readable by the partner (S-02). The day's meals come from `meal_plans` → `plan_dishes` → `plan_meals` (S-03). Recipe structure and nutrition come from the public library (F-04). The per-100 g arithmetic already lives in a pure module meant for S-04 (`src/lib/services/recipe-macros.ts`). No solver code, solve table, LP dependency or unit-test runner exists.
- **The schema already reduces the problem to a small LP.** A recipe is a set of *components* with fixed internal proportions. A `whole_dish` recipe has exactly one component. The model needs one scale variable per component per eater. A full 5-meal day has at most ~30 variables and 16 tolerance rows. This was by design in F-02 (`context/archive/2026-10-07-seed-products-and-recipes/research.md:181`).
- **Unknown 1 is resolved by experiment: CPU is a non-issue.** A minimax LP over the real seed recipes, solved with a pure-JS solver (`yalps`, MIT, ~240 KB unpacked) plus a rounding pass, takes **~0.3–0.6 ms per day** warm and ~4.6 ms cold. 200 solves took 73 ms (Node 24). That fits even the Workers Free plan's 10 ms CPU budget. Leave-one-out explanation adds ≤ 5 more solves. WASM (HiGHS, ~4 MB) is unnecessary.
- **Seed data can hit ±10%, but not on every day.** Mixed days land within 0.4–3.3 % before rounding and ≤ 6 % after. A day built only from `whole_dish` recipes (cookies, leczo, casserole) is infeasible: 21 % even before rounding. The escalation path and the explanation are therefore reachable with seed data alone.
- **Rounding is the real design risk, not the LP.** Rounding each ingredient's batch amount after the LP can move a day's deviation by several points, from 11.4 % to 16 % in one experiment. The main cause is piece ingredients (eggs, bananas) mixed into `whole_dish` components. **The tolerance tier must be judged on the rounded result, never the LP optimum**, and the solver needs a deterministic repair step after rounding.
- **Unknown 2 has a natural deterministic answer:** leave-one-out re-solve. Drop each dish, re-solve, and the dish whose removal lowers the optimum the most is "most obstructive". Ties are broken by slot order (`day_index`, `meal_type` enum order), then recipe id. The worst-deviating macro and its sign give the reason text ("too much fat"). In the experiment this named *Leczo z kiełbasą* (fat) on the all-whole-dish day.
- **The decisions the plan must make** (details below): persist results or compute on demand, how piece rules apply to the per-person split, per-eater scale bounds, how to treat a person with fewer than 5 meals, invalidation when the plan or targets change, and adding a unit-test runner.

## Detailed Findings

### 1. Inputs: who eats what on a day (S-03)

- **Shape.** One `meal_plans` row covers one household and one `start_date`, 3 days (`supabase/migrations/20261008170000_meal_plans.sql:46-58`). A `plan_dishes` row is one cooked batch of one library recipe (`:63-73`). A `plan_meals` row is one filled slot `(day_index 0–2, meal_type)` that eats from a dish (`:82-102`). Empty slots are absent rows.
- **One dish ⇒ one meal ⇒ one day, for S-04 only.** `plan_meals_dish_id_key unique (dish_id)` (`:101`) means each dish belongs to exactly one meal. S-04 can therefore solve **per day** with no coupling between days. S-08 drops that constraint later (`:11-16`), and then a shared dish couples days (roadmap S-08 Unknown).
- **Eaters.** `eater_user_id` is null for "both", otherwise one member's id (`:89-92`). The S-03 research set the mapping S-04 must use (`context/archive/2026-10-08-plan-three-day-grid/research.md:128`): null → every *current* household member's targets, uuid → that person's targets. A plan saved while alone with "Both" covers the partner automatically once they link. Membership is checked only at save time (KD012, `:264-274`). A deleted account turns its meals into "both" (`on delete set null`).
- **Whole-day marking is not stored** (`src/pages/api/plan.ts:92-99`). It is a save-time shortcut, so the solver reads only per-meal eaters.
- **Slot-level diff keeps ids stable.** `save_meal_plan` deletes only meals whose slot disappeared or whose recipe changed (4a, `:285-292`). Eater-only changes **update in place and keep the meal id** (4b, `:295-301`). New or changed slots get a new dish and meal (4c). This was built so "S-04's per-day solve results on untouched days survive an edit elsewhere" (`:167-169`). **Consequence for invalidation:** an FK cascade from a solve row to `plan_meals` catches recipe changes and removals but *not* eater changes. A stale-check must also cover `eater_user_id` (see §7).
- **Reading.** `getMealPlan()` (`src/lib/services/meal-plans.ts:93-128`) returns `dayIndex, mealType, recipeId, eaterUserId` per meal, but **not the meal id or dish id**. S-04 needs those to attach results and fingerprint inputs, so it must widen the select or add its own reader. The embed must keep naming FKs (`plan_meals!plan_meals_plan_fkey`, `plan_dishes!plan_meals_dish_fkey`) because `plan_meals` references both tables (`:92`).
- **UI.** `/plan` is a server-rendered form grid with no island (`src/pages/plan.astro:137-219`). Saves POST to `/api/plan` and redirect back with `?saved=1` or `?error=` (`src/pages/api/plan.ts:113-121`). The page refuses to render the form unless all three reads succeed (`plan.astro:26-61`). That pattern matters if a solve panel is added to the same page.

### 2. Inputs: daily targets (S-02)

- `public.macro_targets`: PK `user_id`, `household_id` + composite FK `(household_id, user_id) → household_members` with `on update cascade` (`supabase/migrations/20261008120000_macro_targets.sql:23-34`). Four `not null` ints: `kcal 1–9999`, `protein_g/fat_g/carbs_g 0–999` (`:26-29`). "Not set" means no row.
- RLS lets both partners read both rows, and only the owner can write (`:51-63`). `getHouseholdMacroTargets()` returns every row in the household (`src/lib/services/macro-targets.ts:17-34`), which is exactly the solver's input.
- **Zero targets are legal** (`fat_g = 0` for keto). A relative tolerance `|actual − target| ≤ tol·target` then forces that macro to exactly 0, which no real recipe meets. **A1:** treat a 0 target as a ceiling with an absolute slack. The plan must pick the slack, e.g. ≤ 5 g. Otherwise any keto user always fails.
- `macroKcalMismatch()` (`macro-targets.ts:81-84`) already flags targets whose 4/4/9 kcal total differs from the kcal target by > 10 %. The S-02 research expected such targets to make the solver fail (`context/archive/2026-10-08-set-daily-macro-targets/research.md:155-158`). **A2:** when that mismatch exists, the infeasibility explanation should blame the targets, not a recipe. Leave-one-out would otherwise name an innocent dish.
- **Hand-off from S-02:** "S-04 must snapshot targets for determinism" (`context/archive/2026-10-08-set-daily-macro-targets/plan-brief.md:75`, `research.md:232`). Targets are a mutable current row with no history.

### 3. Inputs: recipe library (F-02 shape, F-04 ownership)

The final table shapes are in `supabase/migrations/20261008150000_shared_recipe_library.sql:294-377`. Each solver attribute lives here:

| Attribute | Column | Level | Solver meaning |
| --- | --- | --- | --- |
| Nutrition per 100 g | `products.kcal/protein/fat/carbs_per_100g` (`:297-301`) | product | Linear coefficients. Carbs exclude fibre (EU labels). |
| Rounding step | `products.rounding_step_g` (default 10), overridden by `recipe_ingredients.rounding_step_g` (`:303`, `:345-346`) | product / ingredient | Granularity of the displayed amount. 1 g for salt, spices and baking powder. |
| Pieces | `products.grams_per_piece` (`:305`) | product | Amount must be whole pieces. |
| Half pieces | `recipe_ingredients.allow_half_pieces` (`:349-350`) | ingredient | Halves allowed ("podziel na pół"). |
| Minimum amount | `recipe_ingredients.min_amount_g` (`:347-348`) with `check (min_amount_g <= base_amount_g)` | ingredient | Lower bound. The only seed use is eggs in jajecznica: min 50 g = 1 egg. |
| Base batch | `recipe_ingredients.base_amount_g` (`:344`) | ingredient | Fixed proportions inside a component. One base batch is "for two people" (seed header `20261007120100_…:12`). |
| Division mode | `recipes.division_mode` (`:318`) | recipe | `per_component` lets each component scale separately per person. `whole_dish` has exactly 1 component (enforced by `seed_integrity.sql:76-85` for seeds only). |
| Cooked yield | `recipe_components.cooked_yield_ratio` (`:330`) | component | Cooked/raw. Seed values: rice 2.50, chicken 0.75, spaghetti 2.20. Null elsewhere. |

- **There is no "minimum sensible amount of a dish"** column, although the concept doc names one (`docs/app-concept-eng.md:100`, "of an ingredient or dish"). **A3:** S-04 uses the ingredient-level minimum plus a generic per-eater lower bound (§5). A dish-level minimum is out of scope unless the plan adds a column (library tables are write-revoked, so that would be a new migration).
- **There is no maximum** of any kind, so the solver must impose its own upper bounds (§5).
- The library is read-only and identical for every user. Seed ids are stable (`5eed000N-…`) and suit fixture tests. S-07 will add user-editable rows (`CLAUDE.md` Public library tables). After that, a recipe edit changes the solver's inputs for an already-solved day, which also argues for snapshotting or fingerprinting (§7).
- **Reading the library for a solve.** `getRecipeDetail()` (`src/lib/services/recipes.ts:159-205`) already fetches components → ingredients → products for **one** recipe in three flat queries. It avoids embedding steps under recipes because of PGRST201 ambiguity (`:156-158`). The solver needs the same data for up to 5 recipes. One `recipe_components` query with `.in("recipe_id", ids)` and the same nested `recipe_ingredients(…, products(…))` embed avoids N round-trips, and steps are not needed. Numerics may arrive as strings, so wrap them in `Number()` (`recipes.ts:73`).
- `recipe-macros.ts` is pure and was explicitly built for reuse by S-04 (`src/lib/services/recipe-macros.ts:3-4`). It provides `ingredientMacros(amountG, per100g)`, `sumMacros`, `cookedWeight`, and `formatIngredientAmount(amountG, gramsPerPiece, allowHalfPieces)`, which already renders `"2½ pcs (…)"` / `"½ pc (…)"` (`:62-81`). Rounding happens once at display (`:15`).

### 4. Seed recipes as solver fixtures

There are 8 recipes (`supabase/migrations/20261007120100_seed_products_and_recipes.sql:89-106`):

- `per_component` (5): Jajecznica (eggs+butter / bread), Owsianka (oat base / fruit), Kurczak curry (rice / chicken / sauce), Makaron z krewetkami (pasta / shrimp), Twarożek (cheese spread / rolls).
- `whole_dish` (3): Ciastka proteinowe, Leczo z kiełbasą, Zapiekanka makaronowa.

Piece ingredients and how they would round:

- **Eggs** (50 g, no halves): jajecznica base 200 g with min 50 g; ciastka 50 g.
- **Rye bread** (35 g slice, halves allowed): 140 g.
- **Banana** (120 g): halves allowed in owsianka (120 g); halves *not* allowed in ciastka (240 g).
- **Graham roll** (60 g, halves allowed): 120 g.
- **Garlic** (5 g clove): 10–15 g in curry, krewetki, leczo and zapiekanka.

`seed_integrity.sql:262-302` guarantees protein-, carb- and fat-dominant components exist. It is a heuristic for "S-04 has independent levers", not a proof of solvability (`context/archive/2026-10-07-seed-products-and-recipes/plan-brief.md:83`).

### 5. Model: an LP over component scale factors

**Variables.** For each dish *d* in the day, component *c*, and eater *p* of that meal: `x[c,p] ≥ 0`, the fraction of the base batch of *c* that *p* eats. The cook amount of each ingredient *i* in *c* is `(Σₚ x[c,p]) · base_amount_g[i]`. `per_component` gives independent `x` per component. `whole_dish` has one component, so it has one `x` per eater automatically and needs no special case.

**Daily totals** are linear: `total[p,m] = Σ x[c,p] · macros_m(component c base batch)`, where *m* is one of kcal, protein, fat or carbs.

**Objective (recommended): minimax relative deviation.** Minimise `t` subject to `−t·T[p,m] ≤ total[p,m] − T[p,m] ≤ t·T[p,m]` for every person and macro: 8 constraint pairs. One solve yields `t*`, the best achievable tolerance. The escalation tiers then become a **presentation** of one deterministic result: ≤ 10 % shows the result, ≤ 15 % / ≤ 20 % ask for confirmation first, and > 20 % explains. This matches FR-019's "on confirmation" without re-solving per tier.
  - Alternative: a feasibility LP per tier at 10 / 15 / 20 % with a secondary objective (e.g. closeness to base proportions). That means three solves and less information. Rejected.
  - Caveat: minimax spends slack evenly. At ±15 % it may push all 8 deviations near 15 % where another objective would put most near 2 %. **A4:** add a small secondary term, such as the L1 sum of deviations with a tiny weight, or a lexicographic second solve with `t ≤ t*`, so results look natural. This is optional, and the plan decides.

**Bounds (needed; nothing in the schema provides them).** Without bounds the LP can give one eater 0 g of a meal they are marked for, or scale a dish to 5 batches. The experiment used `0.2 ≤ x[c,p] ≤ 1.5` per eater, where a base batch is for two.
  - **A5:** a generic per-eater lower and upper bound on each component, plus `x[c,p] ≥ min_amount_g / base_amount_g` for ingredients with a minimum (the minimum applies to each eater's portion: "fried eggs need at least 1 egg"). For `per_component` recipes, also bound the ratio between one eater's components, e.g. `x[rice,p] ≤ 3·x[chicken,p]`. Otherwise a "curry" can become rice only. The exact numbers are product decisions to record in the plan.

**Who is in the day.** **A6:** a person is solved for on a day only if they eat ≥ 1 meal that day. Their target is the full daily target. Experiment day 4, with only 2 meals, still hit ±1 % by scaling both meals up to the bound. That is mathematically fine, but if the person eats out (the FR-015 rationale) they would over-eat. The PRD does not model eating out, so the simplest rule wins. The plan should state it, and the UI might note that portions are scaled to the full daily target.

**Unsolvable inputs (not an LP failure):** an eater with no `macro_targets` row, a recipe with no components or ingredients (only possible for future S-07 rows), or a day with no meals. Each gets its own message. None of them blocks the plan (FR-020).

### 6. Rounding: the actual hard part

PRD guardrails: amounts round to each ingredient's step, small amounts never round up into a different quantity ("6 g must not become 10 g"), pieces are whole or half, and a halved item may show "podziel na pół" without grams (`context/foundation/prd.md:46`, `:137`; `docs/app-concept-eng.md:99-110`).

**Experiment** (§ Experiment below): rounding every batch ingredient to its step or piece after the LP changed the per-macro deviations by up to ~5 points. On the 2-dish day (dropping leczo) the LP optimum was 11.4 % but the rounded result was **16.1 %** fat. The dominant cause is piece rounding inside scaled mixed components: 1 egg and 2 bananas in a cookie batch scaled ×1.3 become 1 egg and 3 bananas.

The schema leaves one semantic gap: **the piece rule has two possible readings.**

- **(R-batch)** The cook amount of a piece ingredient is whole (or half) pieces: "buy and crack 5 eggs". The per-person split is a share of the cooked component.
- **(R-person)** Each person's portion is whole (or half) pieces: "A: 3 eggs, B: 2 eggs".

`allow_half_pieces` is set exactly on items served as pieces: bread slices, a banana on porridge, rolls. It is not set on pieces mixed into a mass (eggs and bananas in cookies). That suggests the PRD's "split into whole pieces (or halves)" is the per-person reading for served items. Applying R-person to mixed components such as cookies would quantise `x` to whole base batches, which is unusably coarse.

**A7 (recommended):**
- Every ingredient's **cook amount** follows R-batch: a multiple of the effective step, or of a whole or half piece when `allow_half_pieces` is set, never below one unit when the LP amount is > 0.
- The **per-person split** of a component is shown as cooked grams (when `cooked_yield_ratio` is known; the seed steps already say "zważ go po ugotowaniu"), otherwise raw-sum grams, rounded to 10 g. A 50/50 split shows "podziel na pół".
- **Exception:** in a component whose piece ingredients carry `allow_half_pieces`, those pieces are split per person in whole or half pieces (bread slices, rolls, banana).
- Whole-dish casseroles have no yield ratio, so the per-person split is best shown as a share ("A: 58 % of the dish") with an approximate weight.

**Repair step (recommended):** after rounding, recompute each person's totals from the **rounded** amounts and the displayed split. Then assign the tier from that deviation. If rounding pushed a day over a tier boundary, run a small deterministic local search, e.g. nudge single ingredients or splits by ±1 unit in a fixed order and accept strict improvements, before falling back to the next tier. MILP branch-and-bound (`yalps` supports integer variables) is the heavier alternative. With ≤ 30 variables it is feasible, but the rounding interacts with display rules that are easier to express in TS. Either way the result is deterministic.

**Determinism notes.** The NFR requires the same plan and targets to give the same output (`prd.md:135`).
- Sort every input by stable keys: slot order, then component `position`, then ingredient `position`. Never rely on PostgREST row order.
- Use a solver with a fixed pivoting rule.
- Round with the existing half-up helper semantics (`recipe-macros.ts:41-45`).
- Node and workerd are both V8, so float results match.
- Do not let `Promise.all` ordering or `Map` insertion order from DB rows leak into variable order.

### 7. Persisting results vs computing on demand

S-03 anticipated persistence: "S-04 attaches solved batch quantities to `plan_dishes` and the A/B split to `plan_meals`" (`context/archive/2026-10-08-plan-three-day-grid/research.md:76`). It left invalidation to S-04 (`:345`): "S-04 can invalidate per day (e.g. compare `plan_meals` ids or a per-day hash)".

| Option | What it is | For | Against |
| --- | --- | --- | --- |
| **A. Compute on render** | The day view calls the pure solver every time. The only state is the accepted tier, e.g. `?tolerance=15`. | Smallest slice: no migration, no RPC, no isolation-test extension. Deterministic by construction. | No "solved" state for FR-018's prompt. Output silently changes when targets or a library recipe change (S-07). S-09/S-11 would recompute too. Ignores the S-02 snapshot hand-off. |
| **B. Persist a per-day solution (recommended)** | New household-scoped table, e.g. `plan_day_solutions (plan_id, day_index)`. It stores the accepted tolerance, status (`solved` / `needs_confirmation` / `infeasible`), a **targets snapshot**, an **input fingerprint** and the result (jsonb: per dish → component → ingredient cook amounts, per meal → per-eater split, totals and deviations). Written only via a definer RPC. | Gives FR-018 a solved/unsolved signal. Honours the S-02 snapshot hand-off. Gives S-09/S-11 stable quantities. One row per day keeps S-08 open, since a shared dish later becomes a multi-day row or a coupling decision. | Needs a migration, RLS, revokes, an RPC with KD SQLSTATEs, isolation-test extensions and a smoke step. |
| C. Normalised rows on `plan_dishes` / `plan_meals` | Columns or child rows per ingredient. | Queryable by S-09 (shopping list sums). | Most schema work. S-08 changes dish→day cardinality anyway. |

**Recommendation: B**, with a jsonb result. S-09 can sum jsonb in TS.

**Invalidation:** store a fingerprint of the solver inputs: sorted `(meal id, recipe id, eater)` for the day, the eaters' target values, and a hash or `created_at` of the library rows used. Mark the solution **stale** on read when the fingerprint no longer matches, instead of editing `save_meal_plan`. This also catches eater-only edits, which keep meal ids (§1), and target changes, which have no FK path.
- An `on delete cascade` FK from `plan_day_solutions (plan_id, household_id) → meal_plans` keeps cleanup automatic. Deleting a household cascades plans and therefore solutions, which matters for the README cleanup notes.

**Rules that apply if B is chosen (CLAUDE.md hard rules):**
- `household_id uuid not null references public.households on delete cascade` (indexed), and the four per-operation helper-predicate policies `to authenticated`.
- Write-revoke `insert, update, delete, truncate, references, trigger, maintain` from `authenticated`, and `all` from `anon`. Same pattern as `meal_plans` (`20261008170000_meal_plans.sql:117-122`).
- The writer is `public.<name>` `security definer`, `set search_path = ''`, fully-qualified names, `revoke execute … from public, anon; grant … to authenticated`.
- Use new KD SQLSTATEs from **KD013 upward** (KD001–KD012 are taken and KD006 is retired, `20261008170000_meal_plans.sql:32-38`).
- **No per-person composite membership FK** on the row. Plans are household-owned and stay behind on redemption. That FK would make redemption fail with 23503 (`:18-25`). The targets snapshot is data in jsonb, not an FK.
- Extend `supabase/tests/household_isolation.sql`: the catch-all classifies the table, plus explicit grant assertions for the new function. The existing `save_meal_plan` grant checks at `:1183-1187` are the template. Then run `npx supabase db push` followed by `npm run test:rls`, because CI tests the deployed schema.
- **Trust model:** the result is computed in TS on the server and written through the RPC. A household member calling the RPC directly could store arbitrary numbers, but only for their own household. The RPC validates shape (KD class), day index and plan ownership. Re-validating the maths in SQL is not worth it.

### 8. Where the solver runs and how the UI flows

- **Runtime.** Cloudflare Workers via `@astrojs/cloudflare` (`wrangler.jsonc:1-15`, `nodejs_compat`). The tech stack requires the solver to be pure JS or WASM on the edge (`context/foundation/tech-stack.md:24`). It runs server-side in an API route. There is no client-side solve: the solver needs both partners' targets, which RLS already gives to the server client.
- **Placement under the conventions** (`CLAUDE.md` Key conventions):
  - `src/lib/services/macro-solver.ts`: pure, no Supabase. The model build, the LP call, rounding/repair and the explanation.
  - `src/lib/services/day-solutions.ts` (name TBD): the reads (plan day + library + targets), the RPC call and the KD → message map, mirroring `meal-plans.ts:54-76`.
  - A new `POST` API route, e.g. `src/pages/api/plan/solve.ts`, with zod, the uppercase export and the anonymous-user redirect (`/api/*` is not protected by middleware: `src/pages/api/plan.ts:43-47`).
  - New DTOs go in `src/types.ts`.
  - Labels go through `src/lib/recipe-labels.ts` so S-14 can localise them.
- **Flow (FR-018/FR-019, A8).** On `/plan`, each day with 5 filled meals and no fresh solution shows a "Przelicz makro" (Solve macros) form button. Every day also gets a manual solve button. The page has no island and the prompt is a server-rendered banner after save, not a JS popup. That matches S-03's no-island grid and the "narrowest client directive" convention.
  - POST solve → a 10 % result is stored and shown.
  - A 15 % or 20 % result is stored as `needs_confirmation` and the page offers "Accept ±15 %". A second POST with `accept=15` flips the status. The result is identical because the solve is deterministic.
  - > 20 % shows the explanation.
  - The plan is never blocked: saving and using the plan are independent of solve status (FR-020).
- **Display.** Per meal: each ingredient's cook amount (step-rounded, pieces via `formatIngredientAmount`) and the per-eater split, with per-person daily totals vs targets and the deviation %. A separate day page (e.g. `/plan/day?start=…&day=…`) is likely cleaner than overloading the grid form, which only renders when three reads succeed (`plan.astro:57-61`). `/plan` already falls under `PROTECTED_ROUTES` (`src/middleware.ts:4-11`) by prefix.

### 9. The "most obstructive recipe" (Unknown 2)

- **Recommended algorithm:** for a day whose rounded optimum is above 20 %, re-solve once per dish with that dish removed, keeping the other meals and bounds. Pick the dish whose removal gives the lowest `t*`. Break ties by slot order (`day_index`, then the `meal_type` enum order breakfast → dinner, `MEAL_TYPES` in `meal-plans.ts:9`), then recipe id. Name it with the macro and direction that dominate at the full-day optimum, e.g. "Leczo z kiełbasą — too much fat for your targets". The direction comes from the largest positive/negative deviation and that dish's share of that macro.
- **Experiment:** on the all-whole-dish day, removing either leczo dropped `t*` from 21.1 % to 11.4 %, removing zapiekanka gave 17.5 %, and removing ciastka changed nothing. Leczo is named and the first leczo slot wins the tie. That matches intuition: kiełbasa makes leczo fat-dense.
- Cost: ≤ 5 extra LP solves at ~0.3 ms each.
- **Alternatives considered:** LP dual values / shadow prices are cheap but unstable under degeneracy and hard to explain. "Recipe with the most extreme macro ratio vs targets" is target-independent and ignores interactions. Both were rejected as less stable or less meaningful.
- **A2 again:** if the targets are themselves inconsistent (`macroKcalMismatch` non-null), report that instead.

### 10. Testing surface

- **No unit-test runner exists** (`package.json:5-16`: no vitest/jest). S-05 explicitly left one out of scope (`context/archive/2026-10-08-browse-recipe-library/plan-brief.md:37`). The solver is pure logic where unit tests pay off most: fixtures from seed ids, determinism (same input twice gives deep-equal output), rounding rules ("6 g stays 6 g", eggs whole, bread halves), tier boundaries and tie-breaking.
- **A9:** add `vitest` as a dev dependency with an `npm run test` script and a CI step. The alternative is `node --test` with type stripping, but `.nvmrc` pins Node 22.14, where it is still behind `--experimental-strip-types`, and the `@/` path alias would not resolve. Vitest resolves `@/` via Vite and is the low-friction choice.
- **Smoke** (`scripts/smoke.mjs`): after S-03's shared plan exists (`:388-434`), fill a 5-meal day for both partners (targets A `2200/160/70/230` and B `1800/120/60/180` are already set, `:79-82`), solve, and assert a pinned summary string from a `format…()` helper, the same pattern as `formatPlanSummary` (`meal-plans.ts:47-50`). Also add an anonymous-redirect check for the new route and one infeasible day (e.g. all whole-dish recipes) asserting the escalation prompt. Pin the result from an independent computation, as S-05 did for macros (`smoke.mjs:84-108`).
- **SQL:** isolation-test extensions for the new table and RPC (§7). `seed_integrity.sql` needs no change unless the plan adds seed rows. If it does, update the pinned counts at `:328-331`.

## Experiment

The experiment script lived in the session scratchpad, not the repo.

- **Setup:** the 8 seed recipes transcribed from `20261007120100_seed_products_and_recipes.sql`, targets A = 2200 kcal / P160 / F70 / C230 and B = 1800 / 120 / 60 / 180 (the smoke fixtures).
- **Model:** a minimax LP over `x[c,p] ∈ [0.2, 1.5]`, solved with `yalps@0.6.4`. Then a naive rounding pass: batch amount → step or (half) piece, split by the LP share.
- **Hardware and runtime:** Windows dev box, Node 24.14.

| Day (all meals "both" unless noted) | LP `t*` | Worst rounded deviation | Solve time |
| --- | --- | --- | --- |
| Jajecznica, Owsianka, Curry, Twarożek, Leczo | 0.36 % | 4.0 % (B fat) | 4.6 ms (cold) |
| Owsianka, Ciastka, Krewetki, Twarożek, Zapiekanka | 3.31 % | 6.0 % (B carbs) | 1.4 ms |
| Ciastka, Leczo, Zapiekanka, Ciastka, Leczo (whole-dish only) | **21.09 %** | 23.7 % | 0.6 ms |
| Curry + Owsianka only (2 meals) | 0.79 % | 2.0 % | 0.4 ms |
| Mixed eaters (Owsianka A only, Twarożek B only) | 0.38 % | 5.5 % (A carbs) | 0.6 ms |
| Whole-dish day minus one Leczo | 11.36 % | **16.1 %** (fat) | 0.3 ms |

200 consecutive solves of day 1, including rounding, took 72.9 ms (≈ 0.36 ms each).

**Takeaways:**
1. CPU is negligible.
2. Seed data reaches every tier: success, escalation, explanation.
3. Rounding must be part of the tier decision and needs repair.
4. Leave-one-out gives a stable, sensible "most obstructive recipe".

**LP library options:**

| Library | Package | License | Size | Updated | Notes |
| --- | --- | --- | --- | --- | --- |
| `yalps` | 0.6.4 | MIT | ~240 KB unpacked | 2025-12 | TS, pure JS, integer support. |
| `javascript-lp-solver` | 1.0.3 | Unlicense | ~2.4 MB | 2026-01 | |
| `highs` | 1.15.3 | MIT | ~4 MB | | WASM. |

A hand-written dense simplex (~200 lines, Bland's rule) is also viable and dependency-free. **A10:** `yalps` is the recommended default, because it is small, typed and deterministic. The plan may prefer hand-rolled code to keep the dependency count flat.

## Code References

Permalinks at `daf18d6`:

- [`supabase/migrations/20261008170000_meal_plans.sql:46-102`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/supabase/migrations/20261008170000_meal_plans.sql#L46-L102): plan tables, the `unique (dish_id)` S-08 seam, and the eater semantics.
- [`supabase/migrations/20261008170000_meal_plans.sql:176-326`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/supabase/migrations/20261008170000_meal_plans.sql#L176-L326): `save_meal_plan`, the slot diff (4a–4d), the KD007/KD010–KD012 pattern and the grants. Template for a solve RPC.
- [`supabase/migrations/20261008120000_macro_targets.sql:23-63`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/supabase/migrations/20261008120000_macro_targets.sql#L23-L63): target columns, bounds and RLS.
- [`supabase/migrations/20261008150000_shared_recipe_library.sql:294-377`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/supabase/migrations/20261008150000_shared_recipe_library.sql#L294-L377): library tables with every solver attribute.
- [`supabase/migrations/20261007120100_seed_products_and_recipes.sql:35-210`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/supabase/migrations/20261007120100_seed_products_and_recipes.sql#L35-L210): seed products, recipes, components and ingredients (the fixtures).
- [`src/lib/services/recipe-macros.ts:16-81`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/src/lib/services/recipe-macros.ts#L16-L81): pure macro arithmetic, half-up rounding and piece formatting, reserved for S-04.
- [`src/lib/services/recipes.ts:159-205`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/src/lib/services/recipes.ts#L159-L205): the nested component/ingredient/product read to generalise to many recipes.
- [`src/lib/services/meal-plans.ts:93-128`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/src/lib/services/meal-plans.ts#L93-L128): `getMealPlan()`, which does not expose meal or dish ids yet.
- [`src/lib/services/macro-targets.ts:17-84`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/src/lib/services/macro-targets.ts#L17-L84): household targets read and `macroKcalMismatch()`.
- [`src/pages/plan.astro:26-219`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/src/pages/plan.astro#L26-L219): the grid, the three-read guard and the eater mapping.
- [`src/pages/api/plan.ts:42-122`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/src/pages/api/plan.ts#L42-L122): the POST/redirect/error-param pattern to mirror for solving.
- [`src/types.ts:35-128`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/src/types.ts#L35-L128): `MacroTotals`, `MacroTargets`, `PlanMeal`, `MealPlan`.
- [`supabase/tests/household_isolation.sql:1155-1190`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/supabase/tests/household_isolation.sql#L1155-L1190): grant assertions for write-revoked plan tables and the RPC, the template for S-04's.
- [`scripts/smoke.mjs:78-124`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/scripts/smoke.mjs#L78-L124): target, plan and seed-recipe fixtures already in place.
- [`src/middleware.ts:4-11`](https://github.com/KSchlagowski/Duo-Kitchen/blob/daf18d61ca4bde0d0b5c798fc0b696f9ea3b4b9e/src/middleware.ts#L4-L11): `PROTECTED_ROUTES`. `/plan/*` is covered by prefix and `/api/*` is not.

## Architecture Insights

- **The component is the unit of scaling.** F-02 chose fixed proportions inside a component so the LP stays at one variable per component per eater. Everything downstream (S-09 shopping sums, S-11 portions) should consume the solver's per-component scale plus the rounded ingredient amounts, never re-derive them.
- **Write-revoked household tables + one definer RPC** is the established pattern for derived household state (`meal_plans`, `household_invites`). A solve-result table fits it, with both levers (policies and revokes) load-bearing and asserted in the isolation test.
- **Pure core, thin services.** The repo already separates pure arithmetic (`recipe-macros.ts`, testable and reusable) from I/O services. The solver belongs in the pure layer, so it can be unit-tested with seed fixtures and reused by S-08/S-09/S-11 without Supabase.
- **Server-rendered forms, no islands.** `/plan` and `/targets` use POST-redirect-GET with `?error=` / `?saved=1`. Solve, confirm-escalation and explanation map onto that pattern with no client JavaScript.
- **Smoke strings are pinned through `format…()` helpers** that live next to the logic (`formatMacroTargets`, `formatPlanSummary`, `formatMacroTotals`). S-04 should add a `formatDaySolveSummary()` the same way.

## Historical Context (from prior changes)

- `context/archive/2026-10-07-seed-products-and-recipes/research.md:41-42, 63-71, 181-182`: the solver attribute matrix, the "coverage matrix" seed philosophy, and the reasoning that fixed proportions keep the LP small for the edge CPU budget.
- `context/archive/2026-10-07-seed-products-and-recipes/plan.md:85`: "The solver (S-04) picks the scale factor per component, or per recipe for whole-dish recipes."
- `context/archive/2026-10-07-seed-products-and-recipes/plan-brief.md:83`: macro-diversity thresholds are a heuristic, not a solvability proof (confirmed: the all-whole-dish day fails).
- `context/archive/2026-10-08-set-daily-macro-targets/plan-brief.md:75` and `research.md:232`: S-04 owns snapshotting targets for determinism.
- `context/archive/2026-10-08-set-daily-macro-targets/research.md:155-158`: the kcal-mismatch hint exists because S-04 needs all four totals within tolerance.
- `context/archive/2026-10-08-plan-three-day-grid/research.md:70-76`: dish/meal split chosen so S-04 attaches batch quantities to dishes and the A/B split to meals, and S-08 drops one constraint.
- `context/archive/2026-10-08-plan-three-day-grid/research.md:127-128`: whole-day marking not stored; eater null = every current member.
- `context/archive/2026-10-08-plan-three-day-grid/research.md:345`: invalidation left to S-04 (per day, by ids or a hash).
- `context/archive/2026-10-08-shared-recipe-library/plan-brief.md:22, 26`: seed rows immutable, and stable seed ids for solver fixtures. A shared library means one bad edit would change every couple's solver inputs.
- `context/archive/2026-10-08-browse-recipe-library/plan-brief.md:25, 37`: `recipe-macros.ts` is shared with S-04. The per-person split and a unit-test runner were explicitly deferred.
- `context/foundation/shape-notes.md:200`: "The solver is linear programming (LP), not an LLM."

## Related Research

- `context/archive/2026-10-07-seed-products-and-recipes/research.md`
- `context/archive/2026-10-08-set-daily-macro-targets/research.md`
- `context/archive/2026-10-08-plan-three-day-grid/research.md`
- `context/archive/2026-10-08-browse-recipe-library/research.md`
- `context/archive/2026-10-08-shared-recipe-library/research.md`

## Open Questions

These are for `/10x-plan`. Each has a working assumption above.

1. **Persist vs compute on demand (§7).** Recommended: persist a per-day solution with a targets snapshot and input fingerprint (option B). Option A is the time-boxed fallback.
2. **Piece-rule semantics (§6, A7).** Batch-level pieces for mixed components, per-person whole or half pieces only where `allow_half_pieces` marks a served-as-pieces item. Needs product sign-off.
3. **Scale bounds and component-ratio bounds (§5, A5).** These are new product parameters (e.g. per-eater `0.2–1.5×` base batch, rice:chicken ≤ 3:1). Where do they live: constants in the solver, or columns (a library migration)?
4. **Partial days (§5, A6).** Does a person with fewer than 5 meals still aim at the full daily target? The assumption is yes, with a UI note.
5. **Zero targets (§2, A1).** What absolute slack applies to a 0 g target?
6. **Rounding repair (§6).** Local search vs MILP, and how many repair moves are allowed before falling back to the next tier.
7. **Secondary objective (§5, A4).** Is pure minimax acceptable, or should a lexicographic tie-break make portions look natural?
8. **Test runner (§10, A9).** Add vitest (recommended) or keep the repo test-runner-free and rely on smoke + SQL.
9. **LP library (A10).** `yalps` vs a hand-rolled simplex.
10. **Workers plan.** The experiment's < 1 ms per solve fits even the Free plan's 10 ms CPU limit, but which plan the deployed worker uses was not checked (no access from this session). **A11:** no CPU-limit config change is needed.
11. **Display language.** UI strings stay English through `recipe-labels.ts`-style maps until S-14. The PRD's Polish labels ("Przelicz makro", "podziel na pół") are S-14 translations. **A12:** English labels now ("Solve macros", "split in half").
