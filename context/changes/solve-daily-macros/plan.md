# Solve a Day's Macros for A and B (S-04) Implementation Plan

## Overview

S-04 lets a household solve one planned day so each person's daily totals land within ±10 % of their macro targets (US-01, FR-018, FR-019, FR-020). The user sees:

- the amount of every ingredient to cook, per component and per whole dish;
- how to split each component between A and B;
- each person's totals against their targets.

When ±10 % cannot be reached, the user is asked to accept ±15 % or ±20 %. Beyond ±20 % the app names the recipe that most hinders a fit. Solving never blocks saving or using the plan.

The core is a **pure, deterministic TypeScript solver**. It builds a small minimax LP over per-eater component scale factors and solves it with `yalps`. It then rounds the amounts to cookable quantities, repairs the rounding damage by local search, and decides the tolerance tier from the **rounded** result. Results are **persisted per day** in a new write-revoked household table, together with an input fingerprint. A later plan, target or library change therefore shows the solution as *out of date* instead of silently changing it.

This was planned in a non-interactive session. Every product decision the research left open is settled below as an **assumption (P1…P14)**, so the plan has no open questions. Each assumption can be revisited in review.

## Current State Analysis

All inputs exist, but nothing solves or stores a solve (research §Summary):

- **Who eats what.** `meal_plans` → `plan_dishes` → `plan_meals` (`supabase/migrations/20261008170000_meal_plans.sql:46-102`). One dish belongs to exactly one meal while `plan_meals_dish_id_key` exists (`:101`), so S-04 solves **per day** with no coupling between days. `eater_user_id` null means every current member (`:89-92`). Eater-only edits keep the meal id (`:294-301`), so an FK to `plan_meals` alone cannot detect them.
- **Plan reader.** `getMealPlan()` (`src/lib/services/meal-plans.ts:93-128`) does not return meal ids yet. The FK-named embeds must stay (`:92`).
- **Targets.** `macro_targets` holds one row per person, readable by the partner. `fat_g`, `protein_g` and `carbs_g` may be 0 (`supabase/migrations/20261008120000_macro_targets.sql:26-29`). `getHouseholdMacroTargets()` and `macroKcalMismatch()` are in `src/lib/services/macro-targets.ts:17-84`.
- **Library.** Each solver attribute is a column (`supabase/migrations/20261008150000_shared_recipe_library.sql:294-377`):
  - per-100 g nutrition;
  - `rounding_step_g`, with an ingredient-level override;
  - `grams_per_piece`, and `allow_half_pieces` per ingredient;
  - `min_amount_g`;
  - `base_amount_g`: one base batch serves two;
  - `division_mode`: a `whole_dish` recipe has one component;
  - `cooked_yield_ratio`.

  The library has no maximum or dish-level minimum. The nested component → ingredient → product read already exists for one recipe (`src/lib/services/recipes.ts:159-187`). The pure arithmetic reserved for S-04 is in `src/lib/services/recipe-macros.ts:16-81`: `ingredientMacros`, `sumMacros`, half-up rounding and `formatIngredientAmount`.
- **UI patterns.** `/plan` is a server-rendered form grid with no island. It renders the form only when all three reads succeed (`src/pages/plan.astro:26-61`). POST/redirect/GET carries `?saved=1` / `?error=` (`src/pages/api/plan.ts:34-40, 113-121`). `/plan/*` is protected by prefix and `/api/*` is not (`src/middleware.ts:4-11`).
- **Tests.** There is no unit-test runner (`package.json:5-16`). `npm run test:rls` and `npm run test:seed` run SQL against the hosted project. `scripts/smoke.mjs` already sets targets A = 2200/160/70/230 and B = 1800/120/60/180 (`:79-82`), links the two accounts and saves a shared plan for `2031-01-06` (`:116-121`).
- **Unknown 1 (CPU) is resolved.** A minimax LP plus rounding over the seed recipes takes about 0.3–0.6 ms per day warm and about 4.6 ms cold (research §Experiment). `yalps` is pure JS, MIT-licensed and about 240 KB.
- **Unknown 2 (most obstructive recipe) has a deterministic answer.** Re-solve the day once with each meal left out, and pick the meal whose removal lowers the LP optimum the most (research §9).

## Desired End State

On `/plan`, every day with at least one meal shows a solve status and a **Solve macros** button. A day with all 5 meals and no current solution shows a prompt banner asking to solve it. Solving opens `/plan/day?start=<date>&day=<0-2>`, which shows:

- a status line, one of:
  - `Solved within ±10%`
  - `Best fit needs ±15% — accept to use it` (with an **Accept ±15%** button), or the same for ±20 %
  - `No fit within ±20% · Most obstructive recipe: <name> (too much fat)`
  - `Your daily targets don't add up (protein/fat/carbs vs kcal) — adjust them first.` (when the targets themselves are inconsistent)
- per meal and component: every ingredient's cook amount, in whole or half pieces or step-rounded grams, and the per-person split;
- per person: daily totals with the deviation from each target.

Both partners see the same stored result, with "You" and "Partner" swapped. After any later change to that day's meals, eaters, the household's members, either person's targets, or a used library row, the stored result is marked **Out of date** until solved again. Saving and editing the plan work exactly as before, whatever the solve status (FR-020).

Verification: `npm test` (solver unit tests), `npm run test:rls`, `npm run lint`, `npx astro check`, `npm run build`, and `npm run smoke` against the preview. The smoke run includes a ±10 % day, an escalation day accepted at its tier, a no-fit day naming *Leczo z kiełbasą*, a stale detection after an eater-only edit, and a determinism check.

### Key Discoveries:

- One variable per component per eater is the entire model. A `whole_dish` recipe has one component, so it needs no special case (research §5, `context/archive/2026-10-07-seed-products-and-recipes/plan.md:85`).
- Rounding, not the LP, decides the tier. Naive rounding moved a day from an 11.4 % optimum to 16.1 % (research §6). Any rounded solution is a feasible LP point, so its deviation is never below the LP optimum `t*`. A day's rounded result can therefore never reach a deviation below `t*`; the tier uses the value rounded to 0.1, as displayed (P9).
- `save_meal_plan` keeps meal ids on eater-only edits (`20261008170000_meal_plans.sql:294-301`). Staleness must come from a fingerprint, not from FKs.
- Plan rows must never carry the per-person composite membership FK, because redemption would fail with 23503 (`20261008170000_meal_plans.sql:18-25`). The solution row follows the plan, and target snapshots live in jsonb.
- KD001–KD012 are claimed and KD006 is retired, so S-04 claims **KD013** and **KD014** (`20261008170000_meal_plans.sql:32-38`).
- The isolation catch-all inspects tables only. The new RPC needs its own grant assertions, modelled on `supabase/tests/household_isolation.sql:1183-1188`, and its own anon-execute probe, modelled on `:945-955`.
- The smoke harness pins strings through `format…()` helpers that live next to the logic (`formatPlanSummary`, `meal-plans.ts:47-50`). S-03 keeps its own testid list (`scripts/smoke.mjs:121, 554-559`), so S-04 adds its own list the same way.

## Assumptions (settled here, non-interactive session)

- **P1 — Persist per day (research option B).** A new table `public.plan_day_solutions` holds one row per `(plan, day_index)`, written only by a definer RPC. The row stores the status, the accepted tolerance, an input fingerprint and a jsonb result that includes a targets snapshot. Results are not normalised into `plan_dishes`/`plan_meals` columns, because S-08 changes dish→day cardinality anyway.
- **P2 — Minimax LP with an L1 tie-break.** The LP minimises `t + ε·Σ|dev|` with ε = 0.001, in one solve. The tolerance tier is a *presentation* of that one deterministic result, so accepting ±15 % re-runs the same solve and gets the same numbers. That holds only for unchanged inputs, so an acceptance is bound to the fingerprint the user saw (Phase 2 §4): if the inputs changed, nothing is stored and the user reviews the new result first.
- **P3 — One confirmation, naming the tier actually needed.** If the best rounded fit needs ±20 %, the prompt says "needs ±20 %" and offers **Accept ±20%** directly. It does not first offer ±15 %, which the deterministic solve already knows would fail. This reads FR-019's "→ ±15 % → ±20 % on confirmation" as "the user confirms each loosening the solver needs", and skips confirmations that cannot change the outcome.
- **P4 — Scale bounds are solver constants, not library columns.**
  - Each eater eats between `0.2×` and `1.5×` of each component's base batch. A base batch serves two, so this is 0.4–3 normal portions. This range was validated in the research experiment.
  - Each eater's portion is also at least `min_amount_g / base_amount_g` for every ingredient that has a minimum.
  - For `per_component` recipes, no component of a person's portion may exceed **3×** another component of the same recipe, so a curry cannot turn into rice only.
  - If the fitting fixture day (F1 below) does not reach ±10 % with the ratio bound at 3, raise it to 4 and record that in the Progress notes. Do not change any other constant to make a test pass.
- **P5 — A person is solved for on a day only if they eat at least 1 meal that day, and always against their full daily target.** The day page notes "Portions are scaled to each person's full daily targets."
- **P6 — Zero targets.** A 0 g target uses a reference of 50 g in place of the target as the deviation denominator. So ±10 % means at most 5 g, ±15 % means 7.5 g and ±20 % means 10 g. kcal can never be 0, because the column has `check 1–9999`.
- **P7 — Piece semantics (research A7).**
  - **Cook amounts are batch-level.** A gram ingredient rounds half-up to its effective step. An amount below one step is never rounded up to a full step ("6 g stays 6 g"): it rounds to the nearest 1 g, with a minimum of 1 g. A piece ingredient rounds to whole pieces, or to half pieces when `allow_half_pieces` is set, never below one unit.
  - **Exception.** A component containing any `allow_half_pieces` ingredient (bread slices, rolls, banana on porridge) is rounded **per person**, and its batch amount is the sum of the per-person amounts. Those pieces are then served per person ("You: 2 slices, Partner: 1½ slices").
    - **Every** ingredient of such a component carries `perPerson[userId]` amounts: the piece ingredient rounds per the piece rule above, and each gram ingredient rounds to its step (with the below-one-step rule). The ingredient's batch amount is the sum of its per-person amounts.
    - A single-ingredient piece component uses split kind `"pieces"`. A mixed one (Owsianka `Owoce`: banana + blueberries) uses split kind `"per_ingredient"`, rendered `You: 1 pc banana + 50 g blueberries · Partner: ½ pc banana + 40 g blueberries`.
    - Totals for a per-person component use `perPerson` directly, with no share arithmetic.
  - **Split of every other component between two eaters.** When `cooked_yield_ratio` is known, show cooked grams rounded to 10 g. Otherwise show a whole-number percentage of the dish.
  - **Remainder rule.** Order the two eaters by user id ascending. The first eater's share is rounded, and the second eater gets the exact remainder. An equal split also shows "split in half".
  - **Totals.** Every person's totals are computed from these displayed amounts and shares.
- **P8 — Rounding repair is a bounded deterministic local search, not MILP.**
  - **Moves**, tried in a fixed order:
    1. ±1 unit on each batch-rounded ingredient;
    2. shift one split unit (10 g or 1 %) between the two eaters;
    3. ±1 unit on each per-person piece ingredient.
  - **Acceptance.** Accept the first move that strictly improves `(max |dev|, then Σ|dev|)`, then restart the pass.
  - **Stop** when a full pass improves nothing, or after **50** accepted moves.
  - **Bounds after rounding.** Rounding drifts a component's internal proportions, so the P4 bounds are measured on an *effective scale*: `effScale[c,p] = share[c,p] × Σ_i roundedAmount[i] / Σ_i baseAmount[i]` (a mass ratio over the component's ingredients). The scale bound is `MIN_SCALE ≤ effScale[c,p] ≤ MAX_SCALE`. The ratio bound is `effScale[c1,p] ≤ MAX_COMPONENT_RATIO × effScale[c2,p]`. The per-eater minimum is `share[c,p] × roundedAmount[i] ≥ min_amount_g[i]`. Every cook amount stays at least one unit.
  - **Bounds hold.** A repair move is legal only if every bound above still holds afterwards. Rounding itself may violate a bound, so while any bound is violated, repair first accepts moves that strictly reduce the total bound violation (in the same fixed move order) before optimising deviations.
- **P9 — Tier from the displayed value.** `maxDeviationPct` is the worst `|dev|` over people and macros, rounded half-up to 0.1. The required tier is the first of 10, 15 and 20 that is ≥ that value, else `null` (no fit).
- **P10 — Most obstructive recipe.**
  1. If any solved person's targets fail `macroKcalMismatch()`, blame the targets, naming the first such person in user-id order.
  2. Otherwise, run leave-one-out over that day's meals, comparing **LP optima only** (no rounding, which keeps it cheap and stable). The winner is the meal whose removal gives the lowest `t*`. Ties within 1e-9 go to slot order, then recipe id.
  3. A person left with no meals drops out of that re-solve. A re-solve with nobody left scores 0.
  4. The reason comes from the same leave-one-out: pick the `(person, macro)` whose LP deviation improved most between the full-day solve and the solve without the blamed meal, and take the direction from that deviation's sign in the full-day result ("too much fat" or "too little protein"). Ties go to people by user id, then macros in the order kcal, protein, fat, carbs. This needs no extra solves.
- **P11 — Unsolvable inputs are not persisted.** These cases redirect back with their own message and store nothing:
  - no meals on the day;
  - an eater without `macro_targets`;
  - a recipe with no components or ingredients;
  - a meal marked for a non-member, which is defensive only, since S-03 prevents it.
- **P12 — Staleness by fingerprint on read.** The fingerprint is a SHA-256 hex digest of a canonical JSON of:
  - the solver version;
  - the sorted current household member ids;
  - the day's meals as `(mealId, mealType, recipeId, eaterUserId)` in slot order;
  - every solved person's four target values;
  - every solver-relevant value of every used component, ingredient and product, in id/position order.

  It does **not** include the accepted tolerance. `save_meal_plan` stays untouched.
- **P13 — Tooling.**
  - `yalps` (runtime dependency) is the LP library.
  - `vitest` (dev dependency) is the unit-test runner, added as `npm test` and run in the CI `ci` job.
  - No Workers CPU-limit config change: the measured cost is about 1 ms per day.
- **P14 — English UI strings now**, for example "Solve macros" and "split in half". Enum labels (macro names, over/under phrasing, split-kind words, `DaySolveStatus` labels) go in `src/lib/recipe-labels.ts`, the single map S-14 localises. Sentence templates (`formatDaySolveSummary`, `UNSOLVABLE_MESSAGES`, `DAY_SOLVE_ERRORS`) live in `day-solutions.ts`, next to the logic, like `formatPlanSummary`. `macro-solver.ts` returns codes only, never display text.

## What We're NOT Doing

- No solving across days or for shared dishes. That is S-08, which drops `plan_meals_dish_id_key` and re-thinks per-day rows.
- No shopping list and no cooking-session portions (S-09, S-11). They consume the stored jsonb later.
- No dish-level minimum or maximum columns, and no library migration. Bounds are solver constants (P4).
- No modelling of eating out or partial-day targets (P5).
- No client-side solving and no React island. Everything is server-rendered forms and POST/redirect/GET.
- No change to `save_meal_plan`, `meal_plans`, `plan_dishes` or `plan_meals`. No automatic re-solve when a plan is saved.
- No Polish labels (S-14). No dashboard solve line.
- No MILP or WASM solver.

## Implementation Approach

The work splits into three vertical phases. Each one leaves the app usable and visibly better:

1. **Pure solver and a read-only day view.** Build and unit-test the whole algorithm (model → LP → rounding → repair → tier → explanation → fingerprint) against seed fixtures, plus the readers that feed it. A new `/plan/day` page computes a **preview** on every render, so the algorithm can be checked in the running app before any schema exists.
2. **Persistence and the solve/accept flow.** Add the migration, RPC, isolation tests, `POST /api/plan/solve` and stale detection. `/plan/day` switches from preview to the stored result.
3. **Grid integration, prompt, smoke and docs.** Show per-day status and Solve buttons on `/plan` and the 5-meal prompt (FR-018), then extend the smoke test and update CLAUDE.md and README.

**Module boundaries** follow the CLAUDE.md conventions:

- `src/lib/services/macro-solver.ts` is pure: no Supabase, no I/O apart from `crypto.subtle` for the fingerprint.
- `src/lib/services/day-solutions.ts` holds the reads, the RPC call, the KD → message map, the unsolvable-reason messages and `formatDaySolveSummary()`.
- DTOs go in `src/types.ts`.
- Pages and API routes never call `supabase.from(...)`.

## Critical Implementation Details

**LP formulation (the contract every phase relies on).**

Variables, all ≥ 0:

- `x[c,p]` for every component `c` of every meal's recipe and every eater `p` of that meal;
- `t`;
- `u[p,m]` and `v[p,m]` for every solved person and each of the 4 macros.

Constraints:

- **Totals:** for each `(p,m)`, `Σ x[c,p]·M[c,m] − u[p,m] + v[p,m] = T[p,m]`, where `M[c,m]` is the macro content of one base batch of `c`.
- **Tolerance:** `u[p,m] − t·D[p,m] ≤ 0` and `v[p,m] − t·D[p,m] ≤ 0`, where `D = T`, or 50 for a zero target (P6).
- **Bounds:** the P4 scale bounds, the min-amount bound, and the ratio bound written as `x[c1,p] − 3·x[c2,p] ≤ 0` for each ordered pair of components of the same `per_component` dish.

Objective: minimise `t + 0.001·Σ (u+v)/D`.

Build the `yalps` model by inserting variables and constraints in a fixed order: meals in slot order, then component `position`, then eaters by user id. Never iterate a `Map` built from DB row order. A non-optimal `yalps` status throws, and the route shows a generic failure.

**Tier on rounded values only.** Never store or show the LP `t*` as the result. `t*` is used only inside leave-one-out (P10). The rounded result can never beat `t*`, so a test asserting "unrounded worst deviation of the rounded result ≥ LP" is a cheap invariant.

**FR-020 isolation on `/plan`.** The solve-status read added in Phase 3 must sit in its own `try/catch`. It must not feed `canEdit` (`src/pages/plan.astro:57-61`), so a failing solve read can never hide or disable the plan grid. The per-day solve forms go **outside** the grid `<form>`, because HTML forms cannot nest. A `formaction` button inside the grid would also post unsaved grid edits that the solve route ignores.

**Determinism.** The same inputs give deep-equal output. Sort every input on stable keys before building anything: meals by `(day_index, meal_type enum order)`, components and ingredients by `position`, people by user id. Use `roundHalfUp` semantics from `recipe-macros.ts:41-45`. Export a `SOLVER_VERSION = 1` constant and include it in the fingerprint, so any later algorithm change marks old results out of date.

---

## Phase 1: Pure solver, readers and a read-only day preview

### Overview

The whole algorithm is implemented and unit-tested against the seed recipes, and the data it needs can be read. A preview page shows the result for any saved day. Nothing is stored yet.

### Changes Required:

#### 1. Dependencies and test runner

**Files**: `package.json`, `vitest.config.ts` (new), `.github/workflows/ci.yml`

**Intent**: Add `yalps` as a runtime dependency and `vitest` as a dev dependency. Add `"test": "vitest run"`, and run `npm test` in the CI `ci` job after lint.

**Contract**: `vitest.config.ts` resolves the `@` alias to `./src`, matching the `tsconfig.json` paths, and includes `src/**/*.test.ts`. The CI step is `- run: npm test` in the `ci` job, needing no secrets.

Install a vitest release whose `peerDependencies.vite` includes `^8` (check with `npm view vitest peerDependencies`), because Astro 7 resolves `vite@8`. Confirm `npm ls vite` shows a single deduped `vite@8.x`. Keep `vitest.config.ts` free of `getViteConfig()`: the solver modules use only type imports from Supabase, so no Astro virtual modules are needed.

#### 2. Solver DTOs

**File**: `src/types.ts`

**Intent**: Add an S-04 block of types shared by the solver, the services and the pages.

**Contract**: The shapes are:

- `SolverRecipe`: id, name, `divisionMode`, components.
- `SolverComponent`: id, position, name, `cookedYieldRatio`, ingredients.
- `SolverIngredient`: id, position, `productName`, `baseAmountG`, `effectiveRoundingStepG`, `minAmountG`, `gramsPerPiece`, `allowHalfPieces`, per-100 g values.
- `PlanMealRecord extends PlanMeal`: adds `mealId`.
- `DaySolution` (also the persisted jsonb, `version: 1`):
  - `people[]`: userId, targets snapshot, totals, deviations as signed fractions per macro;
  - `meals[]`: mealId, mealType, recipeId, recipeName, divisionMode, eaterUserIds;
  - each meal's `components[]`: id, name, `ingredients[]` (cook `amountG`, piece info, optional `perPerson` amounts), and a `split` (per eater: `kind: "grams_cooked" | "percent" | "pieces" | "per_ingredient" | "all"`, value, and an `evenSplit` flag; a `per_ingredient` split reads its per-eater amounts from each ingredient's `perPerson`);
  - `maxDeviationPct`, `requiredTier: 10 | 15 | 20 | null`;
  - `explanation`: `null`, `{ kind: "recipe", mealId, recipeName, macro, direction: "over" | "under" }`, or `{ kind: "targets", userId }`.
- `DaySolveStatus = "solved" | "needs_confirmation" | "no_fit"`.

#### 3. The pure solver

**File**: `src/lib/services/macro-solver.ts` (new)

**Intent**: Implement P2–P12. Build the LP, solve it with `yalps`, round the amounts (P7), repair them (P8), compute per-person totals from the displayed amounts, decide the tier (P9) and produce the explanation (P10). Also produce the canonical fingerprint (P12). Reuse `ingredientMacros`/`sumMacros` from `recipe-macros.ts` and `macroKcalMismatch` from `macro-targets.ts`. Promote `roundHalfUp` in `recipe-macros.ts` to an export rather than duplicating it.

**Contract**:

- `solveDay(input)` returns either:
  - `{ kind: "solution", solution: DaySolution }`, or
  - `{ kind: "unsolvable", reason: "no_meals" | "missing_targets" | "empty_recipe" | "eater_not_member", userIds?: string[], recipeName?: string }`.

  It is synchronous and pure. `input` is `{ memberIds: string[]; meals: PlanMealRecord[] /* one day */; recipes: Record<string, SolverRecipe>; targets: Record<string, MacroTargetsInput> }`.
- `checkSolvable(input)` returns `UnsolvableReason | null` (the `unsolvable` variant above, without `kind`) and runs no LP. `solveDay` calls it first. `getDayView` and `getPlanSolveStatuses` call it instead of `solveDay`, so pages classify a day as unsolvable without solving.
- `statusFor(solution, acceptedTolerance: 10 | 15 | 20)` returns a `DaySolveStatus`:
  - `requiredTier === null` gives `no_fit`;
  - `requiredTier <= accepted` gives `solved`;
  - anything else gives `needs_confirmation`.
- `dayFingerprint(input)` returns `Promise<string>`, a 64-character lowercase hex SHA-256 from `crypto.subtle`.
- `SOLVER_VERSION`, plus the constants `MIN_SCALE = 0.2`, `MAX_SCALE = 1.5`, `MAX_COMPONENT_RATIO = 3`, `ZERO_TARGET_REFERENCE_G = 50`, `TIE_BREAK_WEIGHT = 0.001` and `MAX_REPAIR_MOVES = 50`, all exported so tests can reference them.

#### 4. Solver fixtures and unit tests

**Files**: `src/lib/services/macro-solver.fixtures.ts` (new), `src/lib/services/macro-solver.test.ts` (new)

**Intent**: Transcribe the 8 seed recipes from `supabase/migrations/20261007120100_seed_products_and_recipes.sql` into `SolverRecipe` objects, keeping their `5eed…` ids. Add a header comment naming the source migration. Then test the behaviour that matters.

**Contract**: Fixture days (all meals "both" unless noted), with the smoke targets A = 2200/160/70/230 and B = 1800/120/60/180:

- **F1 fits.** Jajecznica (…001) breakfast, Owsianka (…002) second breakfast, Curry (…004) lunch, Twarożek (…007) afternoon snack, Leczo (…006) dinner. Expect `requiredTier === 10`.
- **F2 no fit.** Ciastka (…003), Leczo, Zapiekanka (…008), Ciastka, Leczo in the five slots. Expect `requiredTier === null`, with the explanation recipe being *Leczo z kiełbasą* at the earlier Leczo slot and the macro chosen by P10 step 4 (expected `fat`).
- **F3 escalation.** Ciastka, Leczo, Zapiekanka, Ciastka in the first four slots. Expect `requiredTier` to be 15 or 20, since the LP optimum is about 11.4 %, so a rounded result cannot reach 10 %.
- **F4 mixed eaters.** F1, with Owsianka for A only and Twarożek for B only.

Assertions:

- **Determinism.** Shuffling the meals, components, ingredients and member order gives `toStrictEqual` output and the same fingerprint.
- **Rounding rules.**
  - Eggs are whole pieces in the jajecznica cook amount.
  - Bread is split per person in whole or half slices.
  - Owsianka `Owoce` uses split kind `per_ingredient`: banana per person in whole or half pieces, blueberries per person in step-rounded grams, and each batch amount equals the sum of its per-person amounts.
  - Every 1 g-step ingredient (salt, spices) stays at least 1 g and is not rounded up to 10 g.
  - No cook amount is 0.
  - Every eater's portion respects the min-amount bound as defined in P8 (`share × roundedAmount ≥ min_amount_g`, so eggs ≥ 50 g each in jajecznica), and every `effScale` respects the P4 scale and ratio bounds.
- **Invariant.** The **unrounded** worst deviation ≥ the LP optimum `t*`. Expose both on the same test-only path (or recompute them); never compare the 0.1-rounded `maxDeviationPct`, which can sit just below `t*` at the boundary.
- **Totals.** Recomputing each person's totals from the displayed amounts and shares matches `people[].totals`.
- **Zero target.** A target with `fatG: 0` on F1 never produces an `Infinity`/`NaN` deviation.
- **Targets explanation.** A kcal-mismatched target on F2 (kcal 3000 with P/F/C summing to about 2000) makes the explanation `kind: "targets"`.
- **Unsolvable reasons.** An empty day, an eater missing from `targets`, and a recipe with no ingredients each return their own reason.
- **`statusFor` table.** Cover every (required tier, accepted tolerance) pair.
- **Performance smoke.** 100 × `solveDay(F2)`, including leave-one-out, finishes in < 1 s under Node. This is a generous ceiling that guards against accidental exponential repair.

#### 5. Readers that feed the solver

**Files**: `src/lib/services/meal-plans.ts`, `src/lib/services/recipes.ts`, `src/lib/services/day-solutions.ts` (new), `src/lib/recipe-labels.ts` (S-04 enum labels, per P14)

**Intent**: Widen the plan reader to return meal ids, add a batch library reader, and add one loader that assembles a day's `solveDay` input.

**Contract**:

- `getMealPlan()` adds `id` to the `plan_meals` select, keeping both FK-named embeds. `MealPlan.meals` becomes `PlanMealRecord[]`. `saveMealPlan(…, meals: PlanMeal[])` is unchanged, and `formatPlanSummary` output is unchanged.
- `getSolverRecipes(supabase, recipeIds)` in `recipes.ts` runs two flat queries:
  1. `recipes` `.in("id", ids)` for `id, name, division_mode`;
  2. `recipe_components` `.in("recipe_id", ids)` with the existing nested `recipe_ingredients(…, products(…))` embed plus `recipe_id`, `products.id` and the per-100 g columns.

  It returns `Record<string, SolverRecipe>`, with components and ingredients sorted by position and numerics through `Number()`. It reuses `IngredientRow`/`ComponentRow` and `toNumberOrNull`.
- `loadDaySolveInputs(supabase, startDate, dayIndex)` in `day-solutions.ts` returns either `{ plan: MealPlan, input: SolveDayInput }` or `null` when there is no plan for that date. It combines `getMealPlan`, `getCurrentHousehold` (member ids), `getHouseholdMacroTargets` and `getSolverRecipes`. A read error throws: it never degrades into "no targets".
- `day-solutions.ts` also exports:
  - `UNSOLVABLE_MESSAGES`, mapping each P11 reason to text, with "You"/"Your partner" resolved against the viewer;
  - `formatDaySolveSummary(solution, status)`, which returns exactly one of the status-line strings in **Desired End State**. The smoke test pins these strings.

#### 6. Read-only preview page

**File**: `src/pages/plan/day.astro` (new), and a link per day on `src/pages/plan.astro`

**Intent**: Validate `start` (`isIsoDate`) and `day` (`0|1|2`). Load the inputs, call `solveDay`, and render the result labelled **Preview — not saved**. Protection comes from the existing `/plan` prefix in middleware. On `/plan`, add a plain `<a>` "Macros →" under each day heading, linking to `/plan/day?start=<start>&day=<n>`. This link is outside any form and is replaced in Phase 3.

**Contract**:

- **Bad or missing input.**
  - A malformed `start` or `day`, or no plan for that date, returns 404 with testid `day-not-found` ("Day not found").
  - A failed read returns 500 with testid `day-unavailable` ("This day is unavailable right now.").
  - An unsolvable reason returns 200 with testid `day-unsolvable` and the P11 message. A missing-targets message links to `/targets`.
- **Markup for testids.** The text of `day-solve-summary`, `day-person`, `day-status-<n>` and `day-prompt-<n>` sits in a `<p>` carrying the `data-testid`, so the smoke helpers can read it. `day-person` renders as `<p data-testid="day-person" data-person="you|partner">`.
- **Result rendering.**
  - **Status line:** testid `day-solve-summary`, text from `formatDaySolveSummary(solution, statusFor(solution, 10))`.
  - **Per person:** testid `day-person`, for example `You · 2190 kcal (−0.5%) · P 158 g (−1.3%) · F 72 g (+2.9%) · C 228 g (−0.9%)`, followed by the target line.
  - **Per meal:** a card with the recipe name, meal-type label (`MEAL_TYPE_LABELS`) and eaters. Each component lists its ingredients through `formatIngredientAmount`, then a split line:
    - grams: `You: 320 g cooked · Partner: 260 g cooked`;
    - percent: `You: 58% · Partner: 42% of the dish`;
    - pieces: `You: 2 pcs · Partner: 1½ pcs`;
    - per ingredient (mixed piece component): `You: 1 pc banana + 50 g blueberries · Partner: ½ pc banana + 40 g blueberries`;
    - single eater: `All for you`;
    - an even split appends `· split in half`.
  - **Note:** "Portions are scaled to each person's full daily targets."
- The plan grid itself is untouched apart from the link.

### Success Criteria:

#### Automated Verification:

- Dependencies install and the lockfile is updated: `npm install`
- Solver unit tests pass: `npm test`
- Linting passes: `npm run lint`
- Type checking passes: `npx astro check`
- Production build succeeds, so the bundle includes `yalps` for workerd: `npm run build`
- Existing smoke still passes against the preview: `npm run build && npm run preview` then `BASE_URL=http://localhost:4321 npm run smoke`

#### Manual Verification:

Prerequisites: run `npm run dev`. You need two linked accounts, A and B, each with targets saved on `/targets`, for example A = 2200/160/70/230 and B = 1800/120/60/180.

- As A, open `/plan`, set **Plan starting** to `2031-02-03` and click **Open**. Fill day 1 with Jajecznica / Owsianka / Kurczak curry / Twarożek / Leczo, all **Both**, and click **Save plan**. Click **Macros →** under day 1. The page shows **Preview — not saved** and the line `Solved within ±10%`. Both people's deviations are all within ±10 %. In Jajecznica, eggs show whole pieces and bread shows a per-person split in whole or half slices. Salt and spices show small gram amounts (for example `2 g`), not `10 g`.
- Reload the page twice. Every number is identical.
- Sign in as B and open the same URL. The numbers are the same, with "You" and "Partner" swapped.
- Back on `/plan` as A, fill day 2 with Ciastka / Leczo / Zapiekanka / Ciastka / Leczo, save, and open its **Macros →**. The line reads `No fit within ±20% · Most obstructive recipe: Leczo z kiełbasą (…)`, and best-effort amounts are still shown.
- Fill day 3 with Ciastka / Leczo / Zapiekanka / Ciastka only (no dinner), save, and open **Macros →**. The line reads `Best fit needs ±15% — accept to use it` or the same for ±20 %. There is no accept button yet in this phase.
- On day 1, change Owsianka to **Me** and save. The preview now shows Owsianka for "You" only, with `All for you`.
- Visit `/plan/day?start=2031-02-03&day=7` and `/plan/day?start=1999-01-01&day=0`: both show **Day not found** (404). Sign out and visit `/plan/day?start=2031-02-03&day=0`: you are redirected to `/auth/signin`.
- With a fresh third account C that has **no** targets, save a 1-meal plan and open its **Macros →**. The page shows "Set your daily targets first" with a link to `/targets`, and the plan itself still saves and reloads normally.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Persisted solutions, the solve/accept flow and stale detection

### Overview

Solving becomes an explicit, stored action that both partners see. Escalation is accepted with one click, and a result whose inputs changed is flagged **Out of date**.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/20261009120000_plan_day_solutions.sql` (new)

**Intent**: Add a household-scoped, write-revoked table holding one solution per plan day, and the single definer RPC that writes it. The header comment follows `20261008170000_meal_plans.sql`: ownership class, the no-membership-FK warning, write-revoke rationale, claimed SQLSTATEs and rollback.

**Contract**:

- **Table** `public.plan_day_solutions`:
  - `id uuid pk default gen_random_uuid()`
  - `household_id uuid not null references public.households on delete cascade`, indexed with `plan_day_solutions_household_id_idx`
  - `plan_id uuid not null`
  - `day_index smallint not null check (day_index between 0 and 2)`
  - `status text not null check (status in ('solved','needs_confirmation','no_fit'))`
  - `accepted_tolerance_pct smallint not null check (accepted_tolerance_pct in (10,15,20))`
  - `input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$')`
  - `result jsonb not null check (jsonb_typeof(result) = 'object')`
  - `solved_at timestamptz not null default now()`
  - `constraint plan_day_solutions_plan_fkey foreign key (plan_id, household_id) references public.meal_plans (id, household_id) on delete cascade`
  - `constraint plan_day_solutions_plan_day_key unique (plan_id, day_index)`
  - **No** `eater`/`user_id` column and **no** membership FK.
- **RLS and grants**: enable RLS and add the four `plan_day_solutions_{select,insert,update,delete}_authenticated` policies with the helper predicate. Then `revoke all … from anon` and `revoke insert, update, delete, truncate, references, trigger, maintain … from authenticated`.
- **RPC** `public.save_day_solution(p_start_date date, p_day_index int, p_status text, p_accepted_tolerance_pct int, p_input_fingerprint text, p_result jsonb) returns uuid`:
  - `security definer`, `set search_path = ''`, every name fully qualified.
  - **Order:**
    1. KD007 when there is no caller or household.
    2. KD013 for a malformed argument, raised inside a sub-block that relabels any parse error, as `save_meal_plan` 2a does. Malformed means: a null start date; `p_day_index` not in 0–2; an unknown status; a tolerance not in (10,15,20); a fingerprint not matching the regex; a result that is not a jsonb object; or a result over 65 536 bytes (`octet_length(p_result::text)`).
    3. KD014 when no `meal_plans` row exists for `(caller household, p_start_date)`.
    4. Upsert on `(plan_id, day_index)`, refreshing `solved_at`, and return the row id.
  - `revoke execute … from public, anon; grant execute … to authenticated;` and a `comment on function` listing KD007/KD013/KD014.

#### 2. Isolation test extension

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Prove the new table and function honour every hard rule, and that both levers (policies and revokes) are in place.

**Contract**: The new blocks follow the existing S-03 ones.

- **Catch-all:** no change is needed. The table has `household_id`, so the catch-all automatically requires its four policies.
- **As user A**, against A's own plan saved with `save_meal_plan`:
  - `save_day_solution` returns an id;
  - a second call for the same day updates in place, with the same id and a new status;
  - a direct `insert` into `plan_day_solutions` raises `insufficient_privilege`.
- **Rejections**, one SQLSTATE each, using the existing `when others` re-raise idiom:
  - KD013 for day 3, a bad status, tolerance 12, a non-hex fingerprint, a jsonb array result and a null start date;
  - KD014 for a start date with no plan.
- **As user B** (another household): selecting A's solution returns 0 rows, and calling the RPC with A's start date raises KD014, because B's household has no such plan.
- **Anon:** executing the RPC is denied, mirroring the `save_meal_plan` anon probe.
- **Grants block (as postgres):** add `plan_day_solutions` to a copy of the S-03 grant loop (write privileges absent, column-level privileges absent, SELECT present for authenticated, nothing for anon). Assert `has_function_privilege` for `public.save_day_solution(date, int, text, int, text, jsonb)`: false for anon, true for authenticated.
- **Cascade:** saving A's plan with zero meals keeps the solution row. Deleting A's plan's household inside the rolled-back transaction removes it.

#### 3. Service: persist, read, stale

**File**: `src/lib/services/day-solutions.ts`

**Intent**: Wrap the RPC and the read, and decide staleness by comparing fingerprints.

**Contract**:

- `saveDaySolution(supabase, startDate, dayIndex, status, acceptedTolerance, fingerprint, solution)` returns `Promise<string>`, using the `RpcResult` cast idiom from `meal-plans.ts:130-155`.
- `getDaySolution(supabase, planId, dayIndex)` returns `{ status, acceptedTolerancePct, inputFingerprint, solution, solvedAt } | null`.
- `DAY_SOLVE_ERRORS`: KD007 "You need to be signed in to solve a day.", KD013 "That solve result could not be saved. Please try again.", KD014 "Save the plan before solving it.". `DAY_CHANGED_BEFORE_ACCEPT = "The day changed since you looked — review the new result before accepting."`. The fallback is `DAY_SOLVE_FAILED = "Macros could not be solved right now. Please try again."`. `daySolveErrorMessage(error)` maps a thrown error to one of these.
- A day view model `getDayView(supabase, startDate, dayIndex)` returns `{ plan, input | unsolvable, stored | null, stale: boolean }`. Here `stale = stored !== null && stored.inputFingerprint !== await dayFingerprint(input)`, and an unsolvable current input (`checkSolvable(input) !== null`) also counts as stale.

#### 4. Solve API route

**File**: `src/pages/api/plan/solve.ts` (new)

**Intent**: Run a POST/redirect/GET solve or accept, mirroring `src/pages/api/plan.ts`: check the anonymous user first, guard `formData()`, validate with zod without coercion, then redirect with messages.

**Contract**:

- **Form fields:** `start_date` (`isIsoDate`), `day_index` (`z.enum(["0","1","2"])`), `accept_tolerance` (`z.enum(["10","15","20"]).default("10")`) and an optional `fingerprint` (`/^[0-9a-f]{64}$/`), required when `accept_tolerance > 10`.
- **Flow:**
  1. Load the inputs. `null` (no plan for that date) → redirect to `/plan?start=<date>&error=` + `DAY_SOLVE_ERRORS.KD014`.
  2. If they are unsolvable (`checkSolvable`), redirect to `/plan/day?start=…&day=…&error=<message>`.
  3. Compute the current fingerprint. If `accept_tolerance > 10` and the posted `fingerprint` ≠ current, store nothing and redirect to the day URL with `error=` + `DAY_CHANGED_BEFORE_ACCEPT`; the page then shows the stale result as usual.
  4. Otherwise `solveDay` and set `status = statusFor(solution, accept)`. For a plain **Solve again** (`accept_tolerance = 10`) on an unchanged fingerprint, carry forward the stored `accepted_tolerance_pct`, so re-solving an accepted day keeps it accepted.
  5. Save, then redirect to `/plan/day?start=…&day=…&solved=1`.
- **Errors:**
  - An anonymous caller is redirected to `/auth/signin`.
  - Invalid fields redirect to `/plan?error=…` when the date is malformed, otherwise to the day URL with `error`.
  - A solver throw or a read failure logs with `console.error` and the eslint-disable comment used elsewhere, then redirects with `DAY_SOLVE_FAILED`.

#### 5. Day page: stored result, Solve and Accept

**File**: `src/pages/plan/day.astro`

**Intent**: Replace the preview with the stored result, and add the buttons that drive the flow. The page never computes a result it does not store.

**Contract**:

- **No stored solution:** show testid `day-solve-summary` "Not solved yet" and a **Solve macros** POST form.
- **Stored solution:** render it with the Phase 1 renderer, and the summary from `formatDaySolveSummary(stored.solution, stored.status)`.
  - `needs_confirmation`: show an **Accept ±N%** form (hidden `accept_tolerance=N`, where N = `requiredTier`, and hidden `fingerprint` = `stored.inputFingerprint`) and a **Solve again** form. The Accept form is hidden while `stale` is true.
  - `no_fit`: show the explanation and a **Solve again** form.
  - **Stale:** show a banner with testid `day-solve-stale`, "Out of date — the plan, targets or recipes changed since this was solved.", and a **Solve again** form. The old result stays visible but is dimmed.
- **Feedback:** show `?solved=1` and `?error=` notices like `/plan` does. Show `Solved at <time>` from `solvedAt`, formatted in Europe/Warsaw.
- Unsolvable current inputs show the P11 message, plus the stale banner if a stored result exists.

### Success Criteria:

#### Automated Verification:

- Migration applies to the hosted project: `npx supabase db push`
- Isolation test passes against the deployed schema: `npm run test:rls`
- Seed integrity still passes: `npm run test:seed`
- Unit tests pass: `npm test`
- Linting passes: `npm run lint`
- Type checking passes: `npx astro check`
- Build succeeds: `npm run build`
- Existing smoke still passes against the preview: `BASE_URL=http://localhost:4321 npm run smoke`

#### Manual Verification:

Prerequisites: run `npm run dev` with the same linked accounts A and B, and the `2031-02-03` plan from Phase 1.

- As A, open `/plan/day?start=2031-02-03&day=0`. It shows **Not solved yet** and **Solve macros**. Click it: you land back on the page with a "Solved" notice, the line `Solved within ±10%`, and a `Solved at` time.
- As B, open the same URL. B sees the same stored result, with no Solve click needed.
- Open day 3 (`day=2`) and click **Solve macros**. The line reads `Best fit needs ±N% — accept to use it` with an **Accept ±N%** button. Click it: the line becomes `Solved within ±N%`, and every quantity is unchanged from before accepting.
- Open day 2 (`day=1`) and solve. You see `No fit within ±20% · Most obstructive recipe: Leczo z kiełbasą (…)` and a **Solve again** button.
- On `/plan`, change only the eater of day 1's Owsianka to **Me** and save. Back on `/plan/day?…&day=0`, the **Out of date** banner shows and the old numbers are dimmed. Click **Solve again**: the banner disappears and Owsianka now says `All for you`.
- As B, change B's protein target on `/targets` and save. A's day 1 page now shows **Out of date**.
- On `/plan`, edit and save the plan freely while days are solved, out of date or unsolved. Saving always succeeds and the grid behaves exactly as before (FR-020).
- Open `/plan/day?start=2031-02-04&day=0`, a date with no saved plan. It shows **Day not found** (404) with no Solve button, so an unsaved date can never be solved. The RPC-level rejections (KD013/KD014) are covered by `npm run test:rls`.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Grid status and 5-meal prompt, smoke test and docs

### Overview

The `/plan` grid shows where each day stands and prompts the user to solve a full day (FR-018). The smoke test covers the whole flow end to end, and the docs describe S-04.

### Changes Required:

#### 1. Per-day status on `/plan`

**Files**: `src/lib/services/day-solutions.ts`, `src/pages/plan.astro`

**Intent**: Compute a status for each of the three days from the already-loaded plan and render, outside the grid form:

- a status line per day;
- a **Solve macros** POST form for every day with at least one meal;
- a link to the day page;
- a prompt banner for every day that has all 5 meals and no current solution. A "current solution" is `stored !== null && !stale`, whatever its status. The prompt is not shown for `unsolvable` days, which show `Can't solve yet — see day` instead.

**Contract**:

- `getPlanSolveStatuses(supabase, plan)` returns `Record<PlanDayIndex, { kind: "empty" | "unsolved" | "stale" | "unsolvable" | DaySolveStatus; requiredTier?: 10 | 15 | 20 | null }>`. It makes one read of all of the plan's `plan_day_solutions` rows, plus a single shared input load: targets, members and `getSolverRecipes` for every recipe in the plan. It fingerprints each day and classifies `unsolvable` with `checkSolvable`, never `solveDay`.
- In `plan.astro`, this call sits in its own `try/catch`. On failure the page shows "Solve status is unavailable right now." and **the grid still renders** (FR-020). `canEdit` must not depend on it.
- The per-day solve section is a sibling **after** the grid `<form>`: three cards in the same `md:grid-cols-3` layout.
  - Status testid `day-status-<n>`, with these texts:
    - `No meals`
    - `Not solved`
    - `Solved within ±N%`, where N = `requiredTier` (10, or 15/20 for an accepted day)
    - `Needs ±N% — open to accept`
    - `No fit within ±20%`
    - `Out of date`
    - `Can't solve yet — see day`
  - Prompt testid `day-prompt-<n>`: `<Weekday> has all 5 meals. Solve its macros?`, with the **Solve macros** button inside it.
  - Under the cards, the helper text "Solves the saved plan — save your changes first." The solve forms post only `start_date`/`day_index`, so unsaved grid edits are not part of a solve.
- The Phase 1 **Macros →** link under each day heading is replaced by the card's **View day** link.

#### 2. Smoke steps

**File**: `scripts/smoke.mjs`

**Intent**: Extend the end-to-end run with S-04 after the S-05 block and before sign-out, using the already-linked A and B and their saved targets. The strings are pinned through `formatDaySolveSummary()`.

**Contract**: Add an S-04 fixtures block. It holds a new start date `2031-01-13`, so the S-03 plan at `2031-01-06` is untouched, plus the recipe ids `…001`–`…008` reused from the existing constants and an `S04_TEST_IDS` list printed on failure in its own loop. The existing `testIdText()`/`testIdBody()` return only the first match, so add a `testIdTexts(body, id)` helper (global regex, all matches) for `day-person`, and compare lines after stripping the leading `You · ` / `Partner · ` label (or select by `data-person`). The steps, in order:

1. Anonymous `POST /api/plan/solve` and `GET /plan/day?…` both redirect to `/auth/signin`. These use a fresh signed-out client, or are placed after sign-out.
2. A saves day 0 = F1, day 1 = F2 and day 2 = F3 (all Both), and gets 302 with `saved=1`.
3. A's `/plan` shows `day-prompt-0` and `day-prompt-1`, but not `day-prompt-2`, which has only 4 meals, and shows `day-status-2` `Not solved`.
4. A solves day 0 and gets 302 to `/plan/day?start=2031-01-13&day=0&solved=1`. The day page shows `day-solve-summary` `Solved within ±10%`. Capture the full `day-person` lines.
5. **Determinism:** A solves day 0 again, and the `day-person` lines equal the captured ones.
6. B opens day 0 and sees the same numbers, in B's perspective: A's captured `data-person="you"` line equals B's `data-person="partner"` line once the leading label is stripped.
7. A solves day 1. The page shows `No fit within ±20% · Most obstructive recipe: Leczo z kiełbasą`, matched as a prefix, since the reason text is unit-tested instead.
8. A solves day 2. The page matches `Best fit needs ±(15|20)% — accept to use it`. Capture N and the Accept form's hidden `fingerprint` value, post `accept_tolerance=N` with that `fingerprint`, and the page shows `Solved within ±N%`. A's `/plan` then shows `day-status-2` `Solved within ±N%`.
9. **Stale:** B re-saves the same 2031-01-13 grid with day 0's Owsianka eater set to `partner`. That is an eater-only edit, so the meal id is kept. A's day 0 page then shows `day-solve-stale`, and A's `/plan` shows `day-status-0` `Out of date`.
10. **Unknown day:** `GET /plan/day?start=2031-01-13&day=7` returns 404 with `day-not-found`.

Add a top-of-block comment explaining why the LP numbers are not pinned from an SQL oracle (no SQL LP exists). Determinism and perspective symmetry are asserted instead, and exact values are covered by `npm test`.

#### 3. Documentation

**Files**: `CLAUDE.md`, `README.md`

**Intent**: Record S-04's architecture and rules where future slices will look.

**Contract**:

- **CLAUDE.md:**
  - Add `plan_day_solutions` to the **Write-revoked tables** rule. Its writes go only through `public.save_day_solution`, and the revoke list includes `maintain`.
  - Add an Architecture bullet "Macro solver (S-04)" covering:
    - the pure `macro-solver.ts`;
    - `day-solutions.ts`;
    - `/plan/day` and `POST /api/plan/solve`;
    - the LP over component scale factors;
    - the tier judged on rounded values;
    - the fingerprint-based staleness, including `SOLVER_VERSION`;
    - the solver constants;
    - KD013/KD014;
    - S-04 enum labels living in `src/lib/recipe-labels.ts` (sentence templates in `day-solutions.ts`);
    - "never give solution rows the membership FK";
    - the S-08/S-09/S-11 hand-off: consume the stored jsonb and never re-derive quantities.
  - Add `npm test` (vitest) to the Commands notes.
- **README.md:**
  - Add `npm test` to Available Scripts.
  - Add `/plan/day` to the Auth routes table.
  - Add an S-04 paragraph to the Smoke test section.
  - Add a note in the cleanup section that solutions cascade with their plan and household.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Isolation test still passes: `npm run test:rls`
- Linting passes: `npm run lint`
- Type checking passes: `npx astro check`
- Build succeeds: `npm run build`
- Full smoke, including the new S-04 steps, passes against the production preview: `npm run preview -- --port 4321` then `BASE_URL=http://localhost:4321 npm run smoke`
- Prettier is clean for the edited markdown: `npx prettier --check CLAUDE.md README.md`

#### Manual Verification:

Prerequisites: run `npm run dev` with linked accounts A and B, both with targets.

- As A, open `/plan`, pick a new start date such as `2031-03-03`, fill day 1 with 5 meals and day 2 with 3 meals, and save. Below the grid, day 1 shows the prompt "<Weekday> has all 5 meals. Solve its macros?". Day 2 shows `Not solved` with a **Solve macros** button and no prompt. Day 3 shows `No meals` with no button.
- Click **Solve macros** inside day 1's prompt. You land on the day page with the result. Go back to `/plan`: the prompt is gone and day 1 shows `Solved within ±10%`, or `Needs ±N%` for a tight day.
- Change one recipe on day 1 and save. Day 1 shows `Out of date` and the prompt reappears, because the day is full and has no current solution.
- Change a recipe in the grid **without** saving and look under the solve cards. The helper text "Solves the saved plan — save your changes first." is shown. The solve buttons sit outside the grid form, so they solve the saved plan only.
- Temporarily break the solve-status read, for example by renaming the table in a local-only edit of the select string, and reload `/plan`. The "Solve status is unavailable right now." notice shows, and the grid still renders and saves. Revert the edit.
- Run `npm run smoke` against `npm run dev` and see every step PASS, including the S-04 steps.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding.

---

## Testing Strategy

### Unit Tests:

Vitest, in `src/lib/services/macro-solver.test.ts`:

- Fixture days F1–F4 from the seed recipes: tier outcomes, and the explanation recipe and macro.
- Determinism under input shuffling, for both the output and the fingerprint.
- Rounding guardrails:
  - whole eggs;
  - per-person half-slice bread;
  - a 1 g-step ingredient never jumps to 10 g;
  - no zero cook amounts;
  - per-eater minimums.
- Invariants:
  - rounded deviation ≥ LP optimum;
  - totals recomputed from the displayed amounts equal the reported totals;
  - the split remainder sums exactly.
- Edge inputs: zero targets, kcal-mismatched targets, missing targets, an empty day, an empty recipe, a single-eater meal.
- The `statusFor` truth table.
- A coarse performance ceiling.

### Integration Tests:

- `supabase/tests/household_isolation.sql`:
  - table classification (automatic);
  - the write-revoke and grant assertions;
  - RPC happy path and upsert;
  - KD013/KD014 rejections;
  - cross-household invisibility;
  - anon denial;
  - cascade on plan and household deletion.
- `scripts/smoke.mjs`:
  - anonymous redirects;
  - the prompt only on full days;
  - the ±10 % day;
  - determinism and partner symmetry;
  - the no-fit explanation;
  - escalation accepted at its tier;
  - stale detection after an eater-only edit;
  - 404 for a bad day.

### Manual Testing Steps:

1. Two linked accounts with targets: solve a full mixed day and check it lands within ±10 %, with sensible eggs, bread and spice amounts.
2. A whole-dish-heavy day: the escalation prompt, then accept, then a stable result.
3. An all-whole-dish day: *Leczo z kiełbasą* is named as most obstructive.
4. Edit an eater, a recipe or a target: the result is **Out of date**. Solve again and it clears.
5. Saving the plan works whatever the solve state, and a broken solve read never hides the grid.

## Performance Considerations

- A solve is one LP of at most about 30 + 33 variables, up to 5 leave-one-out LPs only for no-fit days, and at most 50 repair moves. Each repair move re-evaluates totals in O(ingredients). The research measured about 0.3–0.6 ms warm per LP, which is well inside the Workers Free plan's 10 ms CPU limit. The unit test's 100-solve ceiling guards against regressions.
- `/plan` gains one extra set of reads in Phase 3 (solutions, targets, members, library rows for at most 15 recipes) and up to three `checkSolvable` checks. The page fingerprints the inputs but **does not re-solve** them. Fingerprints use `crypto.subtle` (microseconds).
- The jsonb result is capped at 64 KB by the RPC. A 5-meal day is a few KB.

## Migration Notes

- The new table only. No backfill, because no solutions exist yet. Apply with `npx supabase db push` **before** merging, then run `npm run test:rls`, because CI tests the deployed schema.
- Rollback: `drop function public.save_day_solution(date, int, text, int, text, jsonb); drop table public.plan_day_solutions;`. Nothing else references them.
- Redemption is unaffected. Solutions belong to the plan's household and stay behind with it, as plans do.
- README cleanup queries need no change. Deleting a household cascades its plans and their solutions.

## References

- Research: `context/changes/solve-daily-macros/research.md`
- Roadmap S-04: `context/foundation/roadmap.md:168-180`; PRD FR-018–FR-020: `context/foundation/prd.md:105-108`
- Write-revoked table + RPC template: `supabase/migrations/20261008170000_meal_plans.sql:110-333`
- Isolation grant template: `supabase/tests/household_isolation.sql:1150-1190`
- POST/redirect route template: `src/pages/api/plan.ts:34-122`
- Pure arithmetic to reuse: `src/lib/services/recipe-macros.ts:16-81`
- Nested library read to generalise: `src/lib/services/recipes.ts:159-187`
- Smoke fixtures: `scripts/smoke.mjs:78-125`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Pure solver, readers and a read-only day preview

#### Automated

- [x] 1.1 Dependencies install and the lockfile is updated: `npm install` — f15f9ef
- [x] 1.2 Solver unit tests pass: `npm test` — f15f9ef
- [x] 1.3 Linting passes: `npm run lint` — f15f9ef
- [x] 1.4 Type checking passes: `npx astro check` — f15f9ef
- [x] 1.5 Production build succeeds, so the bundle includes `yalps` for workerd: `npm run build` — f15f9ef
- [x] 1.6 Existing smoke still passes against the preview — f15f9ef

#### Manual

- [ ] 1.7 Full mixed day previews `Solved within ±10%` with whole eggs, per-person bread halves and small spice grams
- [ ] 1.8 Reloading twice gives identical numbers
- [ ] 1.9 Partner B sees the same numbers with You/Partner swapped
- [ ] 1.10 All-whole-dish day previews no fit naming Leczo z kiełbasą
- [ ] 1.11 4-meal whole-dish day previews `Best fit needs ±15%/±20%`
- [ ] 1.12 Single-eater meal shows `All for you`
- [ ] 1.13 Bad day/start gives 404; signed-out visit redirects to sign-in
- [ ] 1.14 Account without targets sees "Set your daily targets first" and can still save the plan

### Phase 2: Persisted solutions, the solve/accept flow and stale detection

#### Automated

- [x] 2.1 Migration applies to the hosted project: `npx supabase db push` — ab39035
- [x] 2.2 Isolation test passes against the deployed schema: `npm run test:rls` — ab39035
- [x] 2.3 Seed integrity still passes: `npm run test:seed` — ab39035
- [x] 2.4 Unit tests pass: `npm test` — ab39035
- [x] 2.5 Linting passes: `npm run lint` — ab39035
- [x] 2.6 Type checking passes: `npx astro check` — ab39035
- [x] 2.7 Build succeeds: `npm run build` — ab39035
- [x] 2.8 Existing smoke still passes against the preview — ab39035

#### Manual

- [ ] 2.9 Unsolved day shows Not solved; Solve macros stores and shows `Solved within ±10%` with a time
- [ ] 2.10 Partner sees the stored result without solving
- [ ] 2.11 Escalation day: Accept ±N% flips to solved with unchanged quantities
- [ ] 2.12 No-fit day shows the explanation and Solve again
- [ ] 2.13 Eater-only edit marks the day Out of date; Solve again clears it
- [ ] 2.14 Partner's target change marks the day Out of date
- [ ] 2.15 Plan saving is unaffected by solve state (FR-020)
- [ ] 2.16 A date with no saved plan shows Day not found and offers no Solve button

### Phase 3: Grid status and 5-meal prompt, smoke test and docs

#### Automated

- [x] 3.1 Unit tests pass: `npm test`
- [x] 3.2 Isolation test still passes: `npm run test:rls`
- [x] 3.3 Linting passes: `npm run lint`
- [x] 3.4 Type checking passes: `npx astro check`
- [x] 3.5 Build succeeds: `npm run build`
- [x] 3.6 Full smoke including S-04 steps passes against the production preview
- [x] 3.7 Prettier is clean for the edited markdown

#### Manual

- [ ] 3.8 Full day shows the 5-meal prompt; partial day shows Not solved without prompt; empty day shows No meals
- [ ] 3.9 Solving from the prompt clears it and updates the day status
- [ ] 3.10 Changing a recipe marks the day Out of date and brings the prompt back
- [ ] 3.11 "Solves the saved plan — save your changes first" helper text is shown under the solve cards
- [ ] 3.12 A failing solve-status read shows a notice while the grid still renders and saves
- [ ] 3.13 `npm run smoke` against dev passes every step
