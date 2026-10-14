---
date: 2026-10-14T00:00:00+02:00
researcher: Claude (claude-opus-5-5) for Kamil Schlagowski
git_commit: a1d0ed46084b6f57a49762368eadcac14bfb8d28
branch: feat/s-11-step-by-step-cook-mode
repository: KSchlagowski/Duo-Kitchen
topic: "S-11 step-by-step cook mode: following a cooking session step by step with A and B portions"
tags: [research, codebase, cook-mode, cooking-sessions, day-solutions, macro-solver, s-11]
status: complete
last_updated: 2026-10-14
last_updated_by: Claude (claude-opus-5-5)
---

# Research: S-11 step-by-step cook mode (A/B portions)

**Date**: 2026-10-14 (Europe/Warsaw)
**Researcher**: Claude (claude-opus-5-5) for Kamil Schlagowski
**Git Commit**: a1d0ed46084b6f57a49762368eadcac14bfb8d28
**Branch**: feat/s-11-step-by-step-cook-mode
**Repository**: KSchlagowski/Duo-Kitchen

Permalink base: `https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/`. The commit is on `origin/feat/s-11-step-by-step-cook-mode`. Inline references below are repo-relative `path:line`. The **Code References** section repeats the key ones as permalinks.

## Research Question

S-11 from `context/foundation/roadmap.md`: "user can open a scheduled session and follow it step by step, with portions computed for A and B" (US-03, FR-023; prerequisites S-10 and S-04, both done).

`change.md` holds no constraint beyond pointing at the roadmap, so it imposes no scoping caveat. This session was non-interactive, so no scope questions were asked. Assumptions are stated inline and collected in **Open Questions**.

## Summary

S-11 joins two systems that already exist, and both are pure and derived on read:

1. **The schedule (S-10).** `buildCookingSessions()` in `src/lib/services/cooking-sessions.ts:174` turns a plan plus library steps into up to 7 sessions keyed `<YYYY-MM-DD>-<part>`. Each session has `now` / `ahead` sections. A section has entries (recipe × one or more plan `dishId`s × their meals), one merged step order (`ScheduledStep` = library step + `recipeId` / `recipeName` / `entryKey`) and batch notes. The schedule carries **no amounts**.
2. **The stored solve (S-04/S-08).** `plan_day_solutions.result` is a jsonb `DaySolution` (`src/types.ts:278`), read only through the zod gate `parseStoredSolution()` (`src/lib/services/day-solutions.ts:196`). Each stored meal carries:
   - `mealId`
   - `batch` (`{dishId, cookDayIndex, mealIds}`, or null for an unshared dish)
   - per-component rounded ingredient amounts (`amountG` = the **batch** amount, `perPerson` for per-person components)
   - a `split` with one share per `(meal, eater)` serving (`userId`, `mealId`, `dayIndex`, `value`, `fraction`)

The join contract was written down by S-10 (`context/archive/2026-10-13-cooking-session-schedule/plan.md:395`, and in CLAUDE.md):

- match stored `meals[].mealId` to the entry's `meals[].mealId`
- resolve each match to the plan's `dishId` the way `buildShoppingList()` does (`batch?.dishId ?? dishOfMeal(mealId)`, `src/lib/services/shopping-list.ts:49-65`)
- count each `dishId` once
- never re-derive quantities

Five findings shape the plan more than the contract does:

- **Currency must come from `getPlanSolveState()`, not a bare `getDaySolutions()`.** The hand-off text names `getDaySolutions()`, but that read applies no fingerprint check. Only `getPlanSolveState()` (`day-solutions.ts:321`) is "the single currency rule" shared by `/plan` and the shopping list (CLAUDE.md, S-09). Its `currentSolutions` contains only days of current solve groups, with any stored status. If cook mode used `getDaySolutions()` directly, it would show portions that `/plan` calls "Out of date".
- **A step cannot be tied to its component's amounts today.** `RecipeDetailStep` (`src/types.ts:78-85`) carries `componentName`, not `componentId`. `getRecipeSteps()` already selects `component_id` (`src/lib/services/recipes.ts:336`) but maps it to a name only (`:361`). Component names are **not** unique within a recipe: the schema only has `unique (recipe_id, position)`, `supabase/migrations/20261008150000_shared_recipe_library.sql:324-337`. The stored solve keys components by library `id` (`DaySolutionComponent.id`). Showing "the amounts this step uses" therefore needs `componentId` added to the step type and read. That is additive and needs no migration.
- **Step instructions contain no quantities.** Seed instructions are generic Polish text, e.g. "Wbij jajka, dopraw solą i pieprzem…" (`supabase/migrations/20261007120100_seed_products_and_recipes.sql:221`). So "portions" means showing the stored rounded ingredient amounts and the A/B split next to the steps. Nothing is interpolated into the text.
- **Currency is uniform per section, but not per session.** All dishes in one section have their lead meal on the same day:
  - a `now` section holds dishes cooked that day
  - an `ahead` section holds dishes whose cook day is the next day
  
  A day belongs to exactly one solve group, and a dish never spans groups. So every entry in a section is either all exact or all estimate. An evening session mixes `now` (day d) with `ahead` (day d+1), and those can differ.
- **No storage is needed unless per-step "done" state must sync between partners.** Everything else is derivable: amounts, portions, step order. A shared done state would bring a new household-scoped, write-revoked table, a definer RPC, KD codes and isolation-test changes (the S-09 `shopping_list_checks` pattern). The cheaper choice is client-only state, either a URL step index or localStorage. Assumption: client-only (see Open Questions).

## Detailed Findings

### 1. The S-10 schedule — what S-11 consumes

- Pure builder: `buildCookingSessions({ plan, recipeSteps })` (`src/lib/services/cooking-sessions.ts:174-271`). No Supabase, zod or solver import (header comment `:20-28`).
- I/O: `getCookingSchedule(supabase, startDate?)` (`src/lib/services/cooking.ts:12-32`). It runs `getMealPlan()` then `getRecipeSteps()`, logs diagnostics and returns `{ plan, schedule }` or null.
- Session key: `sessionKey(date, part)` → `${date}-${part}` (`cooking-sessions.ts:76-78`). It is used as the section `id` and `data-testid` on `/plan/sessions` (`src/pages/plan/sessions.astro:100-104`). S-10's research suggested an S-11 route of `/plan/sessions/cook?start=…&session=<date>-<part>` (`context/archive/2026-10-13-cooking-session-schedule/research.md:285`; plan D11 `plan.md:89`).
- Shapes (`src/types.ts:379-455`):
  - `CookingSession { key, date, part, sections, stepCount, knownMinutes, untimedCount }`
  - `CookingSessionSection { kind: "now"|"ahead", entries, steps: ScheduledStep[], batchNotes }`
  - `CookingSessionEntry { key, recipeId, recipeName|null, dishIds (sorted), meals: SessionMealRef[], hasSteps }`
  - `SessionMealRef { mealId, dishId, dayIndex, mealType }`
  - `ScheduledStep extends RecipeDetailStep { recipeId, recipeName, entryKey }`. The comment at `:398` says "S-11 depends on these field names".
- Placement rules:
  - make-ahead prefix → the evening before the cook day, section `ahead` (`cooking-sessions.ts:219-221`)
  - fresh steps → the lead meal's session (`freshSlot()` `:85-88`: dinner → that evening's `now`, everything else → that morning)
  - later meals of a shared batch → `SessionBatchNote` instead of steps (`:228-235`)
- Merged entries: same-recipe dishes in one section become one entry with several `dishIds`, and their steps are listed **once** (`buildSection()` `:142-158`). For S-11, that means one set of steps feeds two batches. Each batch has its own stored amounts.
- Step order inside a section: longest remaining chain first (`mergeSteps()` `:111-137`), each recipe's `position` order kept. Section order inside an evening: `now` before `ahead` (`:245-247`).
- Display strings (`cooking-sessions.ts:276-309`) include `formatSessionTitle()` ("Sunday evening"), `formatStepDuration()`, `formatEntryMeals()` ("For Monday Lunch and Tuesday Lunch · 2 batches") and `formatBatchNote()`. The header comment (`:274`) says no smoke-matched string may contain an apostrophe, because Astro escapes it.
- `/plan/sessions` (`src/pages/plan/sessions.astro`) is a server-rendered list with no island. It has the 404 / 500 / no-plan / empty states (`:25-55`), an `<ol>` of steps with `data-step-id` per step (`:148-174`), and links to the plan and the shopping list (`:180-192`). S-11's entry point would naturally be a "Cook step by step" link per session section on this page.

### 2. The stored solve — where the A/B portions live

- Stored row reads:
  - `getDaySolutions(supabase, planId, dayIndexes)` (`day-solutions.ts:208-238`): raw stored rows, schema-gated, **no currency check**.
  - `getPlanSolveState(supabase, plan)` (`day-solutions.ts:321-390`): one read of all stored rows plus `loadSharedInputs()` (household, targets and `getSolverRecipes()`). It fingerprints every solve group (`solveGroups()`, `solveFingerprint()`) and returns `statuses`, `currentSolutions` (only days of current groups, any stored status) and `recipes` (the `SolverRecipe` rows, already loaded).
  - The S-09 precedent: `getShoppingList()` uses `getPlanSolveState()` explicitly "so the two never disagree" (`src/lib/services/shopping.ts:23-32`). S-09's A2 decision, that any stored status counts as exact, is in `context/archive/2026-10-13-shopping-list-from-plan/plan.md:75`.
- `DaySolutionMeal` (`src/types.ts:245-255`): `mealId`, `mealType`, `recipeId`, `recipeName`, `divisionMode`, `eaterUserIds`, `components[]`, `batch | null`.
- `DaySolutionComponent` (`:228-234`): `id` (library component id), `name`, `cookedYieldRatio`, `ingredients[]` and `split`.
- `DaySolutionIngredient` (`:216-226`):
  - `amountG` is the **batch** cook amount
  - `perPerson` (per-person components only, e.g. half-piece bread) holds grams for **this meal's** eaters, keyed by user id
- `DaySplit` (`:199-214`): `kind` is one of `grams_cooked` (cooked-weight split, when a cooked yield ratio exists), `percent`, `pieces`, `per_ingredient` (per-person rounding) or `all` (single eater). It also has `evenSplit` and `shares[]`, one per `(meal, eater)` serving with `mealId` / `dayIndex` (null in pre-S-08 rows). The solver builds the split in `macro-solver.ts:810-843`.
- Rendering already exists:
  - `formatSplitLine(component, viewerId, context?)` (`day-solutions.ts:649-692`) gives "You: 320 g cooked · Partner: 260 g cooked".
    - It puts the viewer first (`viewerFirst()` `:573-575`).
    - A `SplitLineContext` (`:616-624`) suffixes other servings with their day or meal.
    - `ownOnly` shows only the meal's own servings, a percent share also as grams. The day page uses this for a batch cooked on another day.
  - `formatIngredientAmount(amountG, gramsPerPiece, allowHalfPieces)` (`src/lib/services/recipe-macros.ts`, used at `src/pages/plan/day.astro:277-281`) formats amounts and pieces.
  - `formatEaters()` (`day-solutions.ts:599-602`).
  - `FULL_TARGETS_NOTE` ("Portions are scaled to each person's full daily targets.", `:478`).
- Day-page precedent for a shared batch (`src/pages/plan/day.astro:247-306`): on the cook day it lists the batch's ingredient amounts plus the full split. On a non-cook day it lists only that meal's own portions (`cookedElsewhere` → `ownOnly`). `formatCookDayNote()` / `formatFromBatchNote()` (`day-solutions.ts:462-474`) give the notes. `formatFromBatchNote` contains an apostrophe ("Monday's batch"), so it cannot be used in a smoke-matched string verbatim.
- Duplication traps that S-11 must handle the way S-09 does (`shopping-list.ts:46-65`):
  - every stored meal of a shared batch carries the **full** batch amounts, on every day
  - a dish feeding two meals on one day appears twice in that day's `meals[]` with the same `batch.dishId`
  - so take the first stored meal per plan `dishId`, never sum across meals
  - S-09's plan-review trap is at `context/archive/2026-10-13-shopping-list-from-plan/reviews/plan-review.md:76`

### 3. Joining a session entry to its amounts and portions (the core of S-11)

Recommended derivation, all pure and reusing existing pieces:

1. Load `getCookingSchedule()` and `getPlanSolveState()` for the same plan. Both start from `getMealPlan()`, so a new I/O function should read the plan **once** and call `buildCookingSessions()` itself. `getCookingSchedule()` currently reads the plan internally (`cooking.ts:16`).
2. Build `storedMealsByDish` as `shopping-list.ts:49-65` does: first stored meal per plan `dishId` across `currentSolutions` days. That helper is module-private today. Exporting it, or moving it to a shared pure module, avoids a third copy of the dedup rule.
3. For each entry and each `dishId`:
   - amounts = the stored meal's `components[].ingredients` (batch `amountG`)
   - portions = each component's `split`, rendered with `formatSplitLine` and a context naming the viewed session's meals
   - the cook day of a dish is its lead meal's day. Its stored meal sits in the lead day's solution (`batch.cookDayIndex` = lowest day, `src/types.ts:236-243`), and also in later days' solutions with the same full amounts.
4. Tie a step to amounts by `componentId`:
   - a step with a component → that component's ingredients and split
   - a step with `component_id = null` (e.g. "Rozgrzej piekarnik", `seed…sql:235`) → recipe-level, no specific amounts
   - this needs `componentId: string | null` added to `RecipeDetailStep` (`src/types.ts:78`), set in `getRecipeSteps()` (`recipes.ts:356-363`) and `getRecipeDetail()` (`:196-203`), and in the S-10 fixture `step()` (`src/lib/services/cooking-sessions.fixtures.ts:17-38`, which derives names from `SEED_RECIPES`)
   - the seed component id scheme `5eed0003-…-00000000RRCC` makes the fixture mapping mechanical
5. Batch notes (later meals of a shared batch, `SessionBatchNote`): nothing to cook, but **serving** is that meal's own portion. Use `ownOnly` mode with the note's `meal.mealId`, via the stored meal of `note.meal.dishId`. S-10 D4 left reheat and serve to S-11: "S-11 owns serving" (`context/archive/2026-10-13-cooking-session-schedule/plan.md:77`). S-08 left "whether the non-cook day should also show reheating grams" to S-11 (`context/archive/2026-10-10-shared-dish-across-days/plan.md:862`).
6. Not-current days (unsolved, stale, unsolvable):
   - **Recommendation (assumption):** follow the S-09 precedent. Show the recipe **base batch** amounts from `state.recipes` (`SolverRecipe.components[].ingredients[].baseAmountG`), marked as an estimate, with **no A/B split** and a link to `/plan/day?start=…&day=…` to solve.
   - Rationale: the PRD guardrail says a plan is usable unsolved and nothing blocks the user (`context/foundation/prd.md:45`), while the roadmap risk line wants "real portions instead of placeholders". So placeholders must be visibly marked as estimates.
   - Precision: the unit is the section, because currency is uniform per section (Summary). Within an evening session, `now` and `ahead` may differ.
7. Merged entries (`dishIds.length > 1`): the steps are listed once because the batches are cooked together. Amount options:
   - (a) one combined list, ingredient amounts summed across the entry's dishes (one pot)
   - (b) per-batch lists
   
   Portions stay per meal either way. **Assumption:** (a) with the per-meal split lines listed under it, because merged steps imply one pot. This is a planning decision.

### 4. The step-by-step UI — options inside the conventions

Conventions that apply (CLAUDE.md "Key conventions"; F-03):

- `.tsx` island only when the component has state, effects or handlers; narrowest `client:*`.
- Hooks go in `src/components/hooks/`.
- `cn()` is used for classes.
- Labels live in `src/lib/recipe-labels.ts`, so S-14 can localise them; recipe content stays Polish (PRD FR-026).
- Installable, mobile-first, **no service worker and no offline** (CLAUDE.md "Installability").

Options:

- **A. Server-rendered per-step pages.** Example: `/plan/sessions/cook?start=…&session=<key>&step=N`, with Prev/Next links.
  - No island, works without JavaScript, trivially smoke-testable.
  - Downside: a full round trip per step on a phone in the kitchen.
- **B. Server-render the whole session plus a `client:idle` island for a focus mode.**
  - The island shows one step at a time, Next/Prev, optional per-step "done" ticks in `localStorage`, optional Screen Wake Lock.
  - Precedent: the S-09 island `src/components/shopping/ShoppingList.tsx` + `src/components/hooks/useShoppingChecks.ts`, server-rendered with working forms so it works without JS.
  - Under this option the step index and done ticks are per device, not shared with the partner.
- **C. B plus server-persisted done state shared by the household.**
  - Needs:
    - a new `cook_step_checks`-like table (household-scoped, write-revoked, revoke list including `maintain`)
    - a `public` security-definer RPC with KD codes
    - isolation-test extension, a migration, `db push` + `test:rls`
  - That is roughly the full S-09 check-off stack. Nothing in the PRD (FR-023) asks for shared progress.

**Assumption for the plan:** B, with done state client-only. It gives a real step-by-step mode, stays within conventions, and adds no schema. S-10 explicitly assigned "per-step done state" to S-11 (`context/archive/2026-10-13-cooking-session-schedule/plan.md:53`) but did not require persistence.

Routing and auth:

- `PROTECTED_ROUTES` uses `startsWith` on `"/plan"` (`src/middleware.ts:4-11, 25`), so any `/plan/...` cook route is protected automatically.
- An API route under `/api/plan/...` is **not** covered by the middleware. Existing routes check the user themselves (`src/pages/api/plan/shopping.ts`, `solve.ts`). S-11 needs no API route under option B.
- Validation pattern, from `sessions.astro:31-55`:
  - malformed `start` → 404
  - a session key that does not parse (`^\d{4}-\d{2}-\d{2}-(morning|evening)$` plus `isIsoDate`), or that is not among the plan's sessions → 404
  - failed read → 500, never "no plan"
- Viewer identity: `Astro.locals.user?.id` (`src/pages/plan/day.astro:36`). "You" / "Partner" come from `EATER_LABELS` (`src/lib/recipe-labels.ts:49`).

### 5. Testing surfaces

- `npm test` (vitest, pure). A new pure module (e.g. `src/lib/services/cook-mode.ts`) can be tested by combining:
  - `cooking-sessions.fixtures.ts` (33 seed steps; plan builders)
  - `macro-solver.fixtures.ts` (`SEED_RECIPES`, `recipeId()`); running `solveGroup()` in-test yields real `DaySolution`s, as `day-solutions.test.ts` does for split lines (`src/lib/services/day-solutions.test.ts:37-68`)
- Cases to pin:
  - shared-batch dedup (two days, one dish)
  - same-day double meal
  - merged entry (two batches)
  - null-component step
  - per-person component (`perPerson`)
  - not-current fallback
  - `ahead` section reading tomorrow's solution
- Smoke (`scripts/smoke.mjs`). **Ordering constraint:**
  - S-10's smoke block (`scripts/smoke.mjs:1158-1189`) runs on the shared `2031-01-20` plan **after** the un-share and re-share (`:1139-1157`), so at that point the group is **stale**. It needs no solve.
  - The window where the group is solved and shared is `:1068-1110`: after "A plan page shows both days … one identical status", before "B marks Tuesday's lunch for A only". S-09's exact-amount check is pinned there with the comment "S-09 depends on this exact state".
  - An S-11 smoke step that asserts real portions must therefore either sit inside that window or re-solve before it runs.
  - S-11 smoke step 1: assert the shared curry batch shows amounts once.
  - S-11 smoke step 2: assert A and B portions appear for both lunches.
  - S-11 smoke step 3: assert B sees the same numbers with You/Partner swapped (the S-04 partner-symmetry pattern).
  - Smoke step 4 is a stale-plan step, which can piggy-back on the existing stale window (`:1117-1138`) and asserts the estimate note.
- No `test:rls` or `test:seed` change unless option C is chosen.

## Code References

- [`src/lib/services/cooking-sessions.ts:174-271`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/cooking-sessions.ts#L174-L271): `buildCookingSessions()`, the schedule S-11 walks
- [`src/lib/services/cooking-sessions.ts:139-172`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/cooking-sessions.ts#L139-L172): `buildSection()`, merged same-recipe entries
- [`src/lib/services/cooking-sessions.ts:273-309`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/cooking-sessions.ts#L273-L309): session display strings and the no-apostrophe rule
- [`src/lib/services/cooking.ts:12-32`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/cooking.ts#L12-L32): `getCookingSchedule()` I/O
- [`src/pages/plan/sessions.astro`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/pages/plan/sessions.astro): the S-10 page, states and step markup (`data-step-id`)
- [`src/types.ts:78-85`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/types.ts#L78-L85): `RecipeDetailStep`, with `componentName` only and no `componentId`
- [`src/types.ts:195-290`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/types.ts#L195-L290): the stored `DaySolution` shape (split, shares, batch, perPerson)
- [`src/types.ts:379-455`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/types.ts#L379-L455): the S-10 schedule types and the hand-off field names
- [`src/lib/services/day-solutions.ts:196-238`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/day-solutions.ts#L196-L238): `parseStoredSolution()` / `getDaySolutions()`, which apply no currency check
- [`src/lib/services/day-solutions.ts:316-390`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/day-solutions.ts#L316-L390): `getPlanSolveState()`, the single currency rule
- [`src/lib/services/day-solutions.ts:572-692`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/day-solutions.ts#L572-L692): `viewerFirst()`, `formatEaters()`, `SplitLineContext`, `formatSplitLine()`
- [`src/lib/services/shopping-list.ts:46-65`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/shopping-list.ts#L46-L65): `storedMealsByDish()`, the dedup-by-plan-`dishId` rule (module-private)
- [`src/lib/services/shopping.ts:15-50`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/shopping.ts#L15-L50): how S-09 combines the plan read with `getPlanSolveState()`
- [`src/lib/services/recipes.ts:319-369`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/recipes.ts#L319-L369): `getRecipeSteps()`, which selects `component_id` but exposes only the name
- [`src/pages/plan/day.astro:82-97,247-306`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/pages/plan/day.astro#L82-L306): rendering amounts and split, the batch notes and `ownOnly` for a non-cook day
- [`src/lib/recipe-labels.ts`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/recipe-labels.ts): where S-11's new labels go
- [`src/middleware.ts:4-29`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/middleware.ts#L4-L29): the `/plan` prefix protects any cook route
- [`src/components/shopping/ShoppingList.tsx`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/components/shopping/ShoppingList.tsx) + [`src/components/hooks/useShoppingChecks.ts`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/components/hooks/useShoppingChecks.ts): the only island precedent with progressive enhancement
- [`supabase/migrations/20261008150000_shared_recipe_library.sql:324-377`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/supabase/migrations/20261008150000_shared_recipe_library.sql#L324-L377): `recipe_components` / `recipe_steps` (a step has at most one `component_id`; component names are not unique)
- [`supabase/migrations/20261007120100_seed_products_and_recipes.sql:212-243`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/supabase/migrations/20261007120100_seed_products_and_recipes.sql#L212-L243): seed steps; instructions carry no amounts; some steps have no component
- [`src/lib/services/cooking-sessions.fixtures.ts:1-40`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/src/lib/services/cooking-sessions.fixtures.ts#L1-L40): step fixtures (need `componentId` if the type grows)
- [`scripts/smoke.mjs:1068-1189`](https://github.com/KSchlagowski/Duo-Kitchen/blob/a1d0ed46084b6f57a49762368eadcac14bfb8d28/scripts/smoke.mjs#L1068-L1189): the solved-shared, stale and S-10 smoke windows on plan `2031-01-20`

## Architecture Insights

- **Derived, never stored.** S-09's list and S-10's schedule are both pure builders, each fed by a thin I/O module and logging a `diagnostics` object. S-11 fits as a third pure builder (`cook-mode.ts`) with no Supabase, zod or solver import, plus an I/O function. The pure module must not import `day-solutions.ts`, because that pulls in zod and Supabase types, if an island imports it (the S-09 rule for `shopping-list.ts`). That means `formatSplitLine` (which lives in `day-solutions.ts`) is usable from `.astro` server code but not from an island bundle without moving it.
- **One currency rule.** Any "is this amount current?" decision goes through `getPlanSolveState()`, so `/plan`, the shopping list and the cook mode cannot disagree.
- **Dedup by plan `dishId`.** This is the cross-slice invariant for stored amounts. S-09 implements it privately; S-11 is the second consumer, which is the natural moment to share it.
- **Household view, viewer-relative labels.** S-10 is identical for both partners and ignores eaters. S-11 adds portions, and they are viewer-relative ("You" / "Partner", viewer first), like the S-04 day page. Smoke asserts partner symmetry.
- **The stored jsonb is client-assertable.** Any household member can write any object under 64 KB through the RPC (CLAUDE.md, S-04). S-11 must read it only through `parseStoredSolution()`, which happens automatically via `getPlanSolveState()`, and render it as text. Astro escapes it. The S-04 impl review noted the blast radius "grows with each later slice", S-11 included (`context/archive/2026-10-09-solve-daily-macros/reviews/impl-review.md:52`).
- **Display strings the smoke test matches** live next to the builder, with no apostrophes.

## Historical Context (from prior changes)

- `context/archive/2026-10-13-cooking-session-schedule/plan.md:7` says "It shows steps, not amounts: per-person portions are S-11's job."
- `context/archive/2026-10-13-cooking-session-schedule/plan.md:53-58` lists what S-10 left out:
  - no step-by-step mode
  - no per-step "done" state
  - no amounts (S-11)
  - no island
  - no clock times or lanes
  - no per-person view
  - no library schema change (equipment / "serve" timing belong "with S-07 / S-11")
- `context/archive/2026-10-13-cooking-session-schedule/plan.md:395` is the S-11 hand-off contract, quoted in the Summary.
- `context/archive/2026-10-13-cooking-session-schedule/plan.md:77` (D4): the reheat step is not repeated for a shared batch's later meal; "S-11 owns serving".
- `context/archive/2026-10-13-cooking-session-schedule/research.md:280` (Open Q4): reheat and serve steps are stored as `fresh`. A third `step_timing` value would be a library schema change, "with S-07, or with S-11 if the cook mode needs it".
- `context/archive/2026-10-13-cooking-session-schedule/research.md:141`: a merged entry keeps all its `dishIds` "so S-11 can still pull per-batch amounts".
- `context/archive/2026-10-13-cooking-session-schedule/reviews/impl-review.md:67-68`: the curry "reheat and serve" entry reads "For Monday Lunch and Tuesday Lunch". The review says "Revisit in S-11 if users find it confusing".
- `context/archive/2026-10-10-shared-dish-across-days/plan.md:127`: S-09 and S-11 deduplicate a shared batch by its dish.
- `context/archive/2026-10-10-shared-dish-across-days/plan.md:862`: reheating grams on the non-cook day are left to S-11.
- `context/archive/2026-10-09-solve-daily-macros/plan.md:79-82`: per-person (half-piece) components are served per person ("You: 2 slices, Partner: 1½ slices").
- `context/archive/2026-10-09-solve-daily-macros/plan.md:554`: consumers read the stored jsonb and never re-derive quantities.
- `context/archive/2026-10-13-shopping-list-from-plan/plan.md:75` (A2): any current stored status counts as exact; unsolved falls back to base amounts.
- `context/archive/2026-10-13-shopping-list-from-plan/reviews/plan-review.md:76`: the same-day double-count trap.
- `context/archive/2026-10-07-seed-products-and-recipes/research.md:67,69`: the half-piece ("podziel na pół") and raw/cooked weight rules were tagged for S-11.
- `context/foundation/prd.md` contains:
  - US-03 at `:67-70`
  - FR-023 at `:116`
  - the guardrail that the plan is usable unsolved at `:45`
  - the weighable-quantity NFR at `:137` ("podziel na pół" without grams is allowed)
  - the determinism NFR at `:135`
  - recipe content in Polish only (FR-026 `:124`)
- No archive mentions timers for cook mode.
- `context/foundation/lessons.md` does not exist, so there are no recorded lessons to apply.

## Related Research

- `context/archive/2026-10-13-cooking-session-schedule/research.md`: the schedule rules and the S-11 route suggestion
- `context/archive/2026-10-13-shopping-list-from-plan/research.md`: the first consumer of stored amounts (dedup, currency, estimates)
- `context/archive/2026-10-10-shared-dish-across-days/research.md`: the batch and share shape in the stored jsonb
- `context/archive/2026-10-09-solve-daily-macros/research.md`: the solver output and split kinds

## Open Questions

Assumptions are marked (A); `/10x-plan` should confirm or override them.

1. **Per-step done state: client-only or shared?** (A) Client-only (URL step index and/or `localStorage`), option B. Shared progress between partners would need the full S-09-style storage stack (table, RPC, KD codes, isolation test).
2. **Not-current days (unsolved, stale, unsolvable).** (A) Show base-batch amounts marked as an estimate, no A/B split, and a link to solve the day (S-09 precedent; never block). The alternative is to hide amounts entirely until solved.
3. **Merged same-recipe entries (`· 2 batches`).** (A) One combined ingredient list (summed per ingredient across the entry's dishes), because the steps are cooked once, plus per-meal split lines. The alternative is per-batch lists.
4. **Step ↔ amounts granularity.** (A) Add `componentId` to `RecipeDetailStep` and `getRecipeSteps()` (no migration), and show each step's component amounts beside it. A null-component step shows none. The alternative is entry-level amounts only, which needs no type change.
5. **Serving and reheat for later meals of a shared batch.** (A) Show that meal's own portions (`ownOnly`) at its batch note. No new `step_timing` value; that schema change stays with S-07 or later.
6. **Route shape.** (A) `/plan/sessions/cook?start=<date>&session=<date>-<part>` (S-10's suggestion), linked from each session on `/plan/sessions`. An unknown or malformed session gives 404.
7. **Island reuse of `formatSplitLine`.** If the step-by-step view is an island, the portion strings should be precomputed server-side and passed as props, or the formatter moved out of `day-solutions.ts`, so the island bundle does not pull in zod and Supabase.
8. **Smoke placement.** Real-portion assertions must run while plan `2031-01-20` is solved and shared (`scripts/smoke.mjs:1068-1110`), or after a re-solve. The S-10 block runs on a stale group.
9. **Screen wake lock.** It is optional and per device. Its value in the kitchen is real, but the iOS Safari support level should be checked during planning. It is not in the PRD.
