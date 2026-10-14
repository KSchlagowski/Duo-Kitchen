---
date: 2026-10-13T11:06:57+02:00
researcher: Claude (Opus 5.5), for Kamil Schlagowski
git_commit: 426e9226d39d6e4cf772b670084f6bdaed351dd5
branch: feat/s-10-cooking-session-schedule
repository: KSchlagowski/Duo-Kitchen
topic: "S-10 cooking-session schedule: arrange a plan into evening/morning sessions with merged steps (US-03, FR-022)"
tags: [research, codebase, cooking-sessions, meal-plans, recipe-steps, shared-dishes, s-10]
status: complete
last_updated: 2026-10-13
last_updated_by: Claude (Opus 5.5)
---

# Research: S-10 cooking-session schedule

**Date**: 2026-10-13T11:06:57+02:00
**Researcher**: Claude (Opus 5.5), for Kamil Schlagowski
**Git Commit**: 426e9226d39d6e4cf772b670084f6bdaed351dd5 (S-09's last commit; this branch has no commits of its own yet)
**Branch**: feat/s-10-cooking-session-schedule (based on `feat/s-09-shopping-list-from-plan`, which is not yet merged to `main`)
**Repository**: KSchlagowski/Duo-Kitchen

Permalink base for the references below: `https://github.com/KSchlagowski/Duo-Kitchen/blob/426e9226d39d6e4cf772b670084f6bdaed351dd5/<path>#L<line>`. The commit is pushed (it is on `origin/feat/s-09-shopping-list-from-plan`).

## Research Question

Roadmap item S-10 (`context/foundation/roadmap.md:245-256`): the user sees the plan arranged into evening and morning cooking sessions, with steps from several recipes merged. Everything possible goes to the evening; the morning holds only what must be fresh (PRD US-03, FR-022; prerequisite S-03). Build on top of S-09. Respect the S-08 rule from CLAUDE.md: downstream consumers deduplicate a shared batch by `dishId` and never re-derive quantities. Where a decision would normally go to the user, pick the recommended option and note it.

This was a non-interactive session, so no questions were asked. Assumptions and decisions are marked **[Decision]** or **[Assumption]**. The Open Questions section collects the ones `/10x-plan` should confirm.

## Summary

- **Nothing new is needed in the database.** Every input already exists. Plans come from `getMealPlan()` (`src/lib/services/meal-plans.ts:113`), which returns each meal's `dishId`, `dayIndex`, `mealType` and `recipeId`. Steps live in the public library table `recipe_steps` (`supabase/migrations/20261008150000_shared_recipe_library.sql:358-371`), with `position` (unique per recipe), `timing` (`make_ahead` | `fresh`), an optional `component_id` and an optional `duration_minutes`. The schedule is derived on every read and never stored (change.md). So there is no migration, no RLS change and no new isolation-test assertion.
- **No solve is needed.** The schedule depends only on the plan and the step metadata. It shows steps, not amounts: portions for A and B are S-11's job. So it works on unsolved plans (prerequisite S-03 only), and solve staleness and currency (`getPlanSolveState()`) do not apply. The S-08 rule is still met: the unit of scheduling is the **plan's `dishId`**, so a shared batch is scheduled once. No quantity is shown, so none can be re-derived.
- **The seed data supports the rule well.** In all 8 seed recipes the `make_ahead` steps come before the `fresh` steps (`supabase/migrations/20261007120100_seed_products_and_recipes.sql:215-290`). That makes a clean split possible: the make-ahead prefix goes to the evening before, the fresh tail goes to the meal's session. Two make-ahead steps are passive and have no duration: overnight soaking (Owsianka step 2) and thawing (Krewetki step 1). Several fresh steps are really "reheat / weigh and serve" steps (Curry 5, Leczo 5). The schema has no way to tell those apart from real fresh cooking.
- **Recommended engine** (pure, deterministic, unit-tested like `shopping-list.ts`):
  1. **Session assignment**:
     - A dish's make-ahead prefix goes to the **evening before its cook day**. The cook day is the lowest day among the dish's meals.
     - Its fresh steps go **once**, to the session of its **earliest meal**. That session is the morning of that day, except when the earliest meal is **dinner**: then it is the **evening of the same day**.
     - The sessions are named by calendar date and part ("Sunday evening", "Monday morning"), so up to 7 can exist: the evening before day 0, then morning and evening of days 0 to 2.
  2. **Merging within a session**: each recipe's own step order is a hard constraint. Across recipes, the step whose **remaining duration chain is longest goes first** (critical-path list scheduling, untimed steps count 0). Ties go to the earliest meal slot, then the recipe name (Polish collation), then the dish id. This confirms change.md's "by duration" decision and refines its tie-break.
- **Recommended app surface** (mirrors S-09's `/plan/shopping`):
  - a protected `src/pages/plan/sessions.astro` (`?start=`, else the latest plan; a malformed date returns 404, a failed read returns 500), with no island;
  - a pure builder `src/lib/services/cooking-sessions.ts` and its I/O wrapper `src/lib/services/cooking.ts`;
  - a new flat read `getRecipeSteps()` in `src/lib/services/recipes.ts`;
  - links from `/plan` and the dashboard;
  - a vitest suite and a smoke section on the existing shared-batch plan `2031-01-20`.

## Detailed Findings

### 1. What the requirement actually says

- PRD FR-022 (`context/foundation/prd.md:115`): "The app automatically arranges cooking sessions (morning/evening) by merging steps from several recipes. Everything possible goes to the evening; the morning holds only what must be fresh."
- PRD US-03 (`prd.md:67-70`): opening a session such as "Monday evening" shows the merged steps from several recipes "with portions computed for A and B". The portions half is FR-023, which is S-11 (`roadmap.md:258-268`). S-10 covers FR-022 only.
- PRD business rule (`prd.md:146`): "Anything that can be made ahead goes to the evening before, and only what must be fresh goes to the morning. The user encounters it as the session list and the step-by-step cook mode."
- Concept doc (`docs/app-concept-eng.md:128-136`):
  - "Cooking happens in the morning and evening. During the day, only reheating or eating from the container."
  - The example session is "Monday evening: cook rice, sauce and eggs for **Tuesday**". An evening session is therefore named by its own date and cooks for the next day.
  - The logic must be deterministic, with an LLM only if essential.
- Roadmap unknown (`roadmap.md:254`): how merged steps are ordered within a session (by recipe, equipment or duration). Owner: user. Non-blocking. change.md pre-decides **by duration**, which is confirmed below (§5).

### 2. Inputs available today

#### 2.1 The plan (S-03, S-08)

- `getMealPlan(supabase, startDate?)` (`src/lib/services/meal-plans.ts:113-151`) returns `MealPlan { id, startDate, updatedAt, meals: PlanMealRecord[] }`. Each `PlanMealRecord` (`src/types.ts:129-132`) has `mealId`, `dishId`, `dayIndex` (0–2), `mealType`, `recipeId` and `eaterUserId`. Without `startDate` it returns the most recently saved plan, which is the same default `/plan/shopping` uses.
- One `plan_dishes` row is one cooked batch. Since S-08 one dish can feed several meals of one plan, on the same day or across days (CLAUDE.md "Shared dish across days"). `cookDayIndex(dishMeals)` (`src/lib/services/macro-solver.ts:140-142`) is the lowest day among a dish's meals. CLAUDE.md fixes it as the batch's cook day.
- `MEAL_TYPES` (`meal-plans.ts:9`) holds the meal-type enum order: breakfast, second_breakfast, lunch, afternoon_snack, dinner. `addDays()` / `weekdayLabel()` (`meal-plans.ts:26-34`) are UTC-safe date helpers, already used by `/plan/shopping` for weekday labels.
- Grouping meals by `dishId` is exactly what S-09's builder does (`src/lib/services/shopping-list.ts:70-74`). S-10 needs the same map and no stored solve at all.

#### 2.2 Steps (F-02 / F-04 library)

- Table: `public.recipe_steps (id, recipe_id, position, instruction, timing step_timing, component_id, duration_minutes int check > 0, unique (recipe_id, position))` (`supabase/migrations/20261008150000_shared_recipe_library.sql:358-371`). It is a public library table: select-only for `authenticated`, with no household scope. The enum is `step_timing as enum ('make_ahead', 'fresh')`, where make_ahead means "can be done the evening before" and fresh means "must be done right before eating" (`supabase/migrations/20261007120000_products_and_recipes.sql:27-28`).
- Existing reads:
  - `getRecipeDetail()` (`src/lib/services/recipes.ts:166-207`) reads one recipe's steps in a **separate flat query**. Embedding steps under recipes risks PGRST201, because `recipe_steps` has FKs to both `recipes` and `recipe_components` (comment at `recipes.ts:163-165`, CLAUDE.md S-05).
  - `RecipeDetailStep` (`src/types.ts:78-85`) carries `componentName` and `durationMinutes`.
  - No multi-recipe step read exists yet. `getSolverRecipes()` and `getIngredientProducts()` (`recipes.ts:232`, `:285`) show the pattern for a flat `.in("recipe_id", ids)` read keyed by recipe.
- Labels: `STEP_TIMING_LABELS` (`src/lib/recipe-labels.ts:18-21`) and `MEAL_TYPE_LABELS` (`:5-11`). recipe-labels.ts is the single file S-14 localises, so any new session-part labels belong there.
- Seed integrity already requires every `step_timing` value to occur (`supabase/tests/seed_integrity.sql:246-249`) and pins 33 seed steps (`:330`).

#### 2.3 The seed steps, analysed for scheduling

From `supabase/migrations/20261007120100_seed_products_and_recipes.sql:215-290` (durations in minutes, MA = make_ahead, F = fresh):

| # | Recipe (meal types) | Steps by position | MA chain | F chain |
|---|---|---|---|---|
| 1 | Jajecznica (breakfast) | F2, F5, F1, F2 | — | 10 |
| 2 | Owsianka overnight (breakfast, 2nd breakfast) | MA5, MA*null* (overnight in fridge), F3 | 5 | 3 |
| 3 | Ciastka proteinowe | MA10 (oven, no component), MA5, MA5, MA15, MA10 | 45 | — |
| 4 | Kurczak curry (lunch, dinner) | MA15, MA5, MA10, MA15, F5 (weigh portions, reheat, serve; no component) | 45 | 5 |
| 5 | Makaron z krewetkami | MA*null* (thaw shrimp), F10, F6, F2 | 0 | 18 |
| 6 | Leczo (dinner) | MA15, MA10, MA30 (simmer), MA5, F5 (reheat) | 60 | 5 |
| 7 | Twarożek (2nd breakfast, snack) | MA3, MA5, F1 | 8 | 1 |
| 8 | Zapiekanka (no meal type) | MA10, MA10, MA10, F25 (bake) | 30 | 25 |

Observations that shape the design:

1. **The make-ahead steps always form a prefix** in the seed: no recipe has a make-ahead step after a fresh one. The schema does not enforce this, and a user-added recipe (S-07 / S-12) could break it.
2. **There are three kinds of fresh step, but one enum value**: real fresh cooking (Jajecznica, Krewetki, Zapiekanka's bake), assembly (Owsianka's fruit, Twarożek's bread), and reheat or serve (Curry 5, Leczo 5). The concept doc says reheating happens "during the day", not in a session, but the data cannot separate it.
3. **Untimed steps are passive** (overnight soak, thaw). They take no cook time but have a real-world lead time.
4. **There is no equipment metadata.** Only Ciastka step 1 names the oven, and only in text. "Order by equipment" is not implementable without a schema change, which confirms change.md.

### 3. Session model

**[Decision] A session is identified by (calendar date, part)**, with part ∈ {morning, evening}. It is labelled by weekday and part, matching the concept doc's "Monday evening … for Tuesday". The possible sessions, in chronological order:

- the evening of `startDate − 1` (make-ahead for day 0);
- day 0 morning;
- day 0 evening (day 0 dinner's fresh steps, plus make-ahead for day 1);
- day 1 morning;
- day 1 evening;
- day 2 morning;
- day 2 evening (day 2 dinner's fresh steps only).

Empty sessions are omitted. The evening before day 0 lies outside the plan's three days. It is still part of this plan's schedule, because that is when day 0 is prepared.

**[Decision] Assignment rules**, per dish (the plan's `dishId` is the unit, never the meal):

1. **Make-ahead** steps go to the **evening before the dish's cook day**: `addDays(startDate, cookDayIndex − 1)`, evening. This is the PRD's literal rule.
2. **Fresh** steps go **once per dish**, to the session of the dish's **earliest meal**, in (day, meal-type enum) order:
   - the **morning** of that day for breakfast, second breakfast, lunch and afternoon snack;
   - the **evening of the same day** for dinner.

   Rationale:
   - Dinner is eaten in the evening, when the household is cooking anyway.
   - Cooking a fresh dinner in the morning and boxing it contradicts "fresh".
   - "Only reheating during the day" still holds.
   - FR-022's wording ("the morning holds **only** what must be fresh") does not require every fresh step to be in the morning.

   Alternatives:
   - **literal**: every fresh step in the morning of the eating day, which would mean shrimp pasta for dinner cooked at breakfast time;
   - **per-meal fresh**: fresh steps repeated for each meal of a shared batch. See rule 3.
3. **Shared batches (S-08)**: every step of a dish appears **once**. Its make-ahead steps follow the cook day and its fresh steps follow its earliest meal. A later meal of the same batch adds no steps. On that later meal's session the page may show an **information line, not a step**, such as "Tuesday lunch: from Sunday evening's batch". This is the literal reading of the CLAUDE.md invariant: count each `dishId` once across the whole plan.

   Known cost: the reheat step for the later meal (Curry 5) is not repeated. That is consistent with the concept doc ("reheating happens during the day, outside sessions"). S-11 owns per-meal serving and portions.

   Rejected alternative: repeating fresh steps per eating day. It would tell the user to bake a shared Zapiekanka twice and cook a shared shrimp pasta twice with the full batch amounts.
4. **Make-ahead after fresh (defensive)**: a `make_ahead` step is scheduled ahead only if **every earlier step of the recipe** (lower `position`) is also `make_ahead`. Otherwise it is treated as fresh, because it may depend on a fresh step. The seed never triggers this. It protects S-07/S-12 recipes. A component-aware variant (only earlier steps of the same component or with no component) is possible later, but is not worth the risk in v1.
5. **Recipes with only fresh steps** (Jajecznica) appear in one session. **Recipes with only make-ahead steps** (Ciastka) appear only in the evening before.
6. **Eaters do not matter.** A dish is cooked once, whoever eats it. **Solves do not matter either**: no amounts are shown.

**[Decision] Two dishes of the same recipe in one session part are merged into one step sequence.** For example, F2 has Ciastka at breakfast and at afternoon snack, and Leczo at lunch and at dinner, all as separate dishes. The merged entry lists the meals it feeds and its batch count ("2 batches"). Cooking two batches of cookies is one bake, and showing "Preheat the oven" twice would be noise. The entry keeps all its `dishIds`, so S-11 can still pull per-batch amounts from the stored solve.

- Alternative: one entry per dish. It is simpler and 1:1 with the data model, but it repeats steps.
- This merging never applies across the tonight / tomorrow parts of an evening session (see below).

**[Decision] An evening session has two ordered parts**: "Tonight" (that day's dinner fresh steps), then "For tomorrow" (make-ahead for the next day). The merge rule runs within each part. Otherwise the 60-minute leczo chain for tomorrow would push tonight's dinner to the end of the evening.

- Alternative: one merged list with tonight's steps given top priority. It gives the same order with less structure.

### 4. Worked example (smoke plan `2031-01-20`, S-08)

The plan is F1 on Monday and Tuesday: Jajecznica, Owsianka, Curry, Twarożek, Leczo. Tuesday lunch shares Monday's curry batch (`scripts/smoke.mjs:225-236`, README S-08 paragraph). Under the rules above:

- **Sunday evening** (for Monday):
  - Owsianka MA: 5 min, then the untimed overnight step.
  - Curry MA, **cooked once for Monday and Tuesday lunch**: 45 min.
  - Twarożek MA: 8 min.
  - Leczo MA: 60 min.
  - Merged by longest remaining chain:
    1. Leczo 1
    2. Curry 1 (tie with Leczo at 45; lunch comes before dinner)
    3. Leczo 2
    4. Leczo 3 (the 30-minute simmer starts early)
    5. Curry 2
    6. Curry 3
    7. Curry 4
    8. Twarożek 1
    9. Owsianka 1
    10. Twarożek 2
    11. Leczo 4
    12. Owsianka 2 (the untimed overnight step)
  - Sum of known durations: 118 min. This is a sequential upper bound, since the model has no parallelism.
- **Monday morning**: Jajecznica F (10), Curry F (5, the earliest meal of the shared batch), Owsianka F (3), Twarożek F (1), merged.
- **Monday evening**:
  - Tonight: Leczo F (reheat).
  - For tomorrow: Owsianka MA, Twarożek MA, Leczo MA (Tuesday's own dish).
  - **No curry steps**: the dedup holds.
- **Tuesday morning**: Jajecznica F, Owsianka F, Twarożek F. There is no Curry F, only an information line "Tuesday lunch: from Sunday evening's batch".
- **Tuesday evening**: tonight, Leczo F.

This is a good smoke target: it proves the dedup (curry steps appear only on Sunday evening and Monday morning), the dinner-to-evening rule, and the session before day 0. Its state is order-sensitive in the smoke script. S-09 already notes that steps depending on "the group solved and still shared" must stay before the un-share step (`scripts/smoke.mjs:978`, `:1027`). S-10 needs only "still shared", not "solved".

### 5. Ordering merged steps within a session (the roadmap's open question)

**[Decision] By duration: longest remaining chain first**, with each recipe's order as a hard constraint. This confirms change.md.

- **The algorithm**: deterministic list scheduling.
  - Each entry (a recipe within a session part) is a queue of its steps in `position` order.
  - Its priority is the sum of `duration_minutes` of its remaining steps in this part, with null counting as 0.
  - At each pick, take the head of the queue with the highest priority.
  - Ties go to the entry's earliest meal (day, then meal-type order), then the recipe name (`localeCompare(…, "pl")`, as S-05/S-09 do), then the smallest dish id.
- **Why**: it front-loads long and passive work, such as Leczo's 30-minute simmer and Ciastka's 15-minute bake. Short tasks then fill the gaps, which is what "merging" buys over recipe-by-recipe blocks.
- **The alternatives**:
  - **by recipe** (contiguous blocks, ordered by total duration): simpler to follow, but not really "merged";
  - **by equipment**: impossible without schema data.
- **Limitation**: without an active/passive flag, a 15-minute chopping step gets front-loaded the same way as a 30-minute simmer. The model is a priority order, not a timeline. It shows no clock times and no parallel lanes.
- **[Assumption] Untimed steps count 0** for priority. They are passive (soak, thaw), so they sort late within their recipe's constraint. Thawing shrimp the evening before is fine anywhere in the session. A later refinement could hoist untimed passive make-ahead steps to the start of their session.
- **Display**: each step shows its recipe name, component name (if any), instruction and duration ("—" if untimed). Each session header shows "≈ N min of steps", the sum of known durations, plus a count of untimed steps.

### 6. Where the code should go (following S-09's shape)

| Concern | Recommended location | Precedent |
|---|---|---|
| Pure builder: `buildCookingSessions({ plan, recipeSteps })` → `CookingSchedule`; display-string formatters the smoke test pins | `src/lib/services/cooking-sessions.ts` (no Supabase, no zod) | `shopping-list.ts` (pure builder, plus display strings at `:170-206`) |
| I/O: `getCookingSchedule(supabase, startDate?)` → `{ plan, schedule } \| null`; a failed read throws, never "no plan" | `src/lib/services/cooking.ts` | `shopping.ts:15-50` |
| Steps read: `getRecipeSteps(supabase, recipeIds)` → `Record<recipeId, { name, steps[] }>`, as flat queries (`recipes` name, `recipe_components` id and name, `recipe_steps` by `.in("recipe_id")`); no embed, because of PGRST201 | `src/lib/services/recipes.ts`, a new `--- S-10 ---` block | `getRecipeDetail()` `:166`, `getIngredientProducts()` `:285` |
| Types: `SessionPart`, `CookingSession`, `CookingSessionEntry`, `ScheduledStep`, `CookingSchedule` | `src/types.ts` | S-09's `ShoppingList` types |
| Labels: `SESSION_PART_LABELS` ({ morning: "morning", evening: "evening" }) and part headings ("Tonight", "For tomorrow") | `src/lib/recipe-labels.ts` | `AISLE_LABELS` |
| Page: protected `src/pages/plan/sessions.astro?start=`, latest plan by default; 404 for a malformed date, 500 for a failed read, "No plan for that date" | new | `src/pages/plan/shopping.astro:21-66` |
| Navigation: a "Cooking sessions" link next to "Shopping list" on `/plan` (outside the grid form) and on the dashboard | `src/pages/plan.astro:168-175`, `src/pages/dashboard.astro:127` | S-09 |
| Unit tests: `src/lib/services/cooking-sessions.test.ts`, plus seed-step fixtures (33 rows; extend `macro-solver.fixtures.ts` or add `cooking-sessions.fixtures.ts`) | new | `shopping-list.test.ts` |
| Smoke: anonymous redirect; a section on `2031-01-20` while it is still shared; a 404 for a malformed date | `scripts/smoke.mjs` | the S-09 section `:1081` |
| Docs: an architecture bullet in CLAUDE.md (plus the `npm test` list); a README routes-table row and smoke paragraph | CLAUDE.md, README.md | every slice |

Notes:

- **Route protection is automatic.** `PROTECTED_ROUTES` matches by prefix (`src/middleware.ts:4-11`, `:25`), and `/plan` covers `/plan/sessions`. There is no API route: S-10 has no writes.
- **No island.** The schedule has no client state. Per CLAUDE.md "Astro vs React", it is plain `.astro`. A "done" checkbox per step is S-11's step-by-step mode.
- **The builder may import `cookDayIndex()`** from `macro-solver.ts:140` to keep one definition of the cook day. The builder is server-only (no island imports it), so pulling `yalps` into its module graph is harmless. The alternative is to move `cookDayIndex` to a tiny shared module. `/10x-plan` can pick either. The earliest-meal rule needs (day, meal type), not just the day, so it is a small local helper anyway.
- **Diagnostics like S-09's**: a recipe of the plan with no steps (seed integrity forbids it, but S-07 might not) or a missing recipe is logged with `console.error` (`shopping.ts:44-48` pattern) and shown as "No steps recorded" rather than failing the page.
- **Hand-off to S-11.** Each `ScheduledStep` should carry `stepId`, `recipeId` and its entry's `dishIds` and meals. Each session should carry a stable key (`<date>-<part>`). S-11 can then render one session step by step and attach per-person amounts from `getDaySolutions()` / `parseStoredSolution()` by `dishId`, which is CLAUDE.md's mandated door. S-11 must not re-derive quantities. Making the session key URL-safe now (`/plan/sessions?start=…#<date>-<part>`) costs nothing.

### 7. What does *not* apply

- **No migration, table, RPC or KD code.** The hard rules about RLS, write-revoked tables, definer functions and the isolation catch-all are not engaged. `npm run test:rls` and `check:migrations` are unaffected. A **[Assumption]** applies here: S-10 stores nothing. That matches change.md's "derived on read, not stored".
- **No solve currency.** Unlike S-09, the schedule does not read `plan_day_solutions`. A plan edit changes the schedule on the next read. There is nothing to go stale.
- **No partner-specific view.** Both members see the same household schedule. Eaters are irrelevant to cooking steps.

## Code References

- `src/lib/services/meal-plans.ts:9` — `MEAL_TYPES`, the meal-type order used for "earliest meal" and tie-breaks
- `src/lib/services/meal-plans.ts:26-34` — `addDays()`, `weekdayLabel()` (UTC-safe; session dates and labels)
- `src/lib/services/meal-plans.ts:113-151` — `getMealPlan()`: plan meals with `dishId`, latest-plan default
- `src/lib/services/macro-solver.ts:100-142` — `solveGroups()`, `cookDayIndex()` (the S-08 cook-day rule)
- `src/lib/services/shopping-list.ts:67-74` — grouping meals by `dishId`, which S-10 reuses
- `src/lib/services/shopping-list.ts:170-206` — the pattern for display strings pinned by smoke
- `src/lib/services/shopping.ts:15-50` — the I/O wrapper pattern: a failed read throws, diagnostics are logged
- `src/lib/services/recipes.ts:163-207` — flat step read, the PGRST201 rationale, `componentName` mapping
- `src/lib/services/recipes.ts:285-315` — the multi-recipe flat read pattern (`.in("recipe_id", ids)`)
- `src/types.ts:25`, `:78-85`, `:129-139`, `:238-255` — `StepTiming`, `RecipeDetailStep`, `PlanMealRecord`/`MealPlan`, `DaySolutionBatch`/`DaySolutionMeal` (the S-11 hand-off)
- `src/lib/recipe-labels.ts:5-21` — `MEAL_TYPE_LABELS`, `STEP_TIMING_LABELS`
- `src/pages/plan/shopping.astro:21-66` — page state machine (404 / 500 / no-plan / loaded) to mirror
- `src/pages/plan.astro:168-175` — where the S-09 link sits; the S-10 link goes next to it
- `src/middleware.ts:4-11,25` — prefix-based protection covers `/plan/sessions`
- `supabase/migrations/20261007120000_products_and_recipes.sql:27-28` — `step_timing` enum and its meaning
- `supabase/migrations/20261007120100_seed_products_and_recipes.sql:215-290` — the 33 seed steps (timings, durations, components)
- `supabase/migrations/20261008150000_shared_recipe_library.sql:358-371` — current `recipe_steps` definition
- `supabase/tests/seed_integrity.sql:246-249,330` — timing coverage and the pinned step count
- `scripts/smoke.mjs:225-253` — the `2031-01-20` shared-batch plan; `:978`, `:1027` — order-sensitivity notes
- `docs/app-concept-eng.md:128-136` — the source rules for sessions ("Monday evening … for Tuesday")

## Architecture Insights

- **This is a second deterministic engine, built the way S-09 was built.** A pure builder (testable with vitest and seed fixtures) sits under a thin I/O service and a server-rendered page. Display strings live next to the builder so the smoke test can pin them. Every enum label goes through `recipe-labels.ts`.
- **The dish is the unit of cooking.** S-09 established "the dish is the shopping unit: each is cooked once" (`shopping-list.ts:70`). S-10 is the same statement about steps. Using the plan's `dishId` (not the stored `batch.dishId`) keeps the schedule independent of solving, which matches S-10's S-03-only prerequisite. For solved plans the two ids are the same: `batch.dishId` is the plan's dish id.
- **Library metadata limits the engine.** The engine can only be as smart as `timing` and `duration_minutes`. Three places where better data would help are equipment, active vs passive, and serve-time vs cook-fresh. They are left as open questions rather than schema changes in S-10: the library is read-only for clients, and any column belongs to S-07's write path.

## Historical Context (from prior changes)

- `context/changes/shared-dish-across-days/research.md:169-173` fixes the cook day as the lowest `day_index`, "the cook-ahead intent S-10 will schedule against".
- `context/changes/shared-dish-across-days/plan-brief.md:36-38` sets the cook-day and dedup-key decisions. `plan.md:127` sets "downstream consumers … deduplicate by `batch.dishId`". `plan.md:862` leaves reheating portions on non-cook days to S-11.
- `context/changes/shopping-list-from-plan/research.md:50` says S-09/S-10 consume one plan at a time, and the latest plan is the default (inherited from S-03 research, `context/archive/2026-10-08-plan-three-day-grid/research.md:347`).
- `context/changes/shopping-list-from-plan/plan.md:523` recorded its rules "where the next slices (S-10, S-11, S-14) will look". S-09's impl review asked for a deviations addendum to keep the plan accurate for S-10/S-11 (`reviews/impl-review.md:140`).
- `context/archive/2026-10-07-seed-products-and-recipes/` (F-02) defined `step_timing` and `duration_minutes` specifically for the solver and the schedule (roadmap F-02 outcome, `roadmap.md:92`).

## Related Research

- `context/changes/shopping-list-from-plan/research.md` — S-09, the sibling consumer of the plan and the template for this slice's structure
- `context/changes/shared-dish-across-days/research.md` — S-08, batch semantics and the cook day
- `context/archive/2026-10-08-browse-recipe-library/research.md` — S-05, the step read and the PGRST201 rationale
- `context/archive/2026-10-07-seed-products-and-recipes/research.md` — F-02, the origin of the step metadata

## Open Questions

Each has a recommended default (used above). `/10x-plan` should confirm or overturn it.

1. **Ordering within a session** (roadmap unknown). Recommended: longest remaining duration chain first, with recipe order as a hard constraint, and ties by earliest meal, then recipe name, then dish id. Alternative: contiguous recipe blocks ordered by total duration.
2. **Dinner fresh steps.** Recommended: the evening of the same day ("Tonight" part). Alternative (PRD-literal): the morning of the eating day.
3. **Fresh steps of a shared batch.** Recommended: once, in the session of the batch's earliest meal, with information lines (not steps) for later meals. Alternative: repeat fresh steps per eating day. That is wrong for bake or cook-fresh steps with full batch amounts.
4. **Reheat / serve steps classified `fresh`** (Curry 5, Leczo 5). v1 schedules them as fresh steps. A proper fix (a third `step_timing` value such as `serve`, or a flag) is a library schema change that belongs with S-07, or with S-11 if the cook mode needs it.
5. **Same-recipe dishes in one session part.** Recommended: merged into one entry ("2 batches", listing the meals it feeds). Alternative: one entry per dish.
6. **Untimed passive steps** (overnight soak, thaw). Recommended for v1: priority 0. Optional refinement: hoist them to the session start.
7. **Make-ahead after a fresh step** (not in the seed). Recommended: a recipe-level prefix rule (it becomes fresh). A component-aware variant is possible later.
8. **Smoke pinning.** The step order comes from TS, so there is no SQL oracle for it. Recommended: pin the per-session step **sets and counts** from an independent SQL query over `recipe_steps` for the `2031-01-20` recipes, and pin the **order** of Sunday evening from the hand-derived sequence in §4. Cover the exact ordering in `npm test`.
9. **Route name.** Recommended: `/plan/sessions`. S-11 can add `/plan/sessions/cook?start=…&session=<date>-<part>` or similar.
