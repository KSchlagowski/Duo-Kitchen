<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Cooking-Session Schedule (S-10) Implementation Plan

- **Plan**: context/changes/cooking-session-schedule/plan.md
- **Research**: context/changes/cooking-session-schedule/research.md
- **Mode**: Deep. The codebase was checked directly rather than by a sub-agent.
- **Date**: 2026-10-13
- **Verdict**: SOUND. Two warnings to fix, both narrowly scoped.
- **Findings**: 0 critical, 2 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | WARNING |
| Architectural Fitness | PASS (one observation, F5) |
| Blind Spots | WARNING |
| Plan Completeness | PASS (two observations, F3 and F4) |

## Grounding

Paths: 13/13 existing paths ✓. The new files (`cooking-sessions.ts`, `cooking.ts`, `sessions.astro`, the fixtures and the test) are correctly absent.

Symbols: 12/12 ✓.
- `getMealPlan` (meal-plans.ts:113), `MEAL_TYPES`/`addDays`/`weekdayLabel` (meal-plans.ts:9-34), `cookDayIndex` (macro-solver.ts:140) and `joinList` (utils.ts:9).
- `StepRow`/`byPosition` (recipes.ts:106,119). Note: `StepRow` has no `recipe_id` (see F4).
- `MEAL_TYPE_LABELS`/`STEP_TIMING_LABELS` (recipe-labels.ts:5-21).
- `testIdText`/`testIdBody` (smoke.mjs:75,116). They match `<p>` only, which the plan respects.
- The smoke anchors at :978, :1027, :1058 ("A re-shares Tuesday's lunch") and :1066 ("A swaps Monday's lunch").
- The `/plan` link anchor (plan.astro:168-175) and the dashboard link anchor (dashboard.astro:~127).

Brief↔plan ✓. Progress↔Phase ✓ (3/3 phase headings; 7 + 12 + 9 criteria map 1:1 to steps 1.1–3.9; no checkboxes in the phase bodies). `docs/reference/contract-surfaces.md` does not exist, so that check was skipped. `context/foundation/lessons.md` does not exist.

Riskiest claims verified:

1. **Worked example**: re-simulated by hand against D5, every section matches the plan exactly.
   - Sunday evening: `601,401,602,603,402,403,404,701,201,702,604,202`, 118 min, 1 untimed step.
   - Monday morning: `101,102,405,103,203,104,703`.
   - Monday evening: Tonight `605`, then For tomorrow `601,602,603,701,201,702,604,202`.
   - Tuesday morning: `101,102,103,203,104,703`.
   - Tuesday evening: `605`.
   - The seed rows were re-read from `20261007120100_seed_products_and_recipes.sql:215-290`. No later migration touches `5eed0005-…` steps.
2. **Smoke state at :1058**: the plan says it is plain shared F1. Confirmed: "A re-shares" posts `shareForm()`, which is F1 on both days with `d1_lunch_batch: "0_lunch"`. The post-swap state described in manual step 3.7 is also correct. Monday has Leczo at lunch and at dinner as two separate dishes, so they merge into "· 2 batches". Tuesday lunch becomes its own curry dish.
3. **Pickers allow off-type recipes** (needed for the manual Krewetki-dinner and Leczo-lunch checks). Confirmed: plan.astro:242-243 lists the "other" recipes too, and F2 already puts Leczo at second breakfast.
4. **Builder purity**: `meal-plans.ts` imports only types from `@supabase/supabase-js`, so importing its helpers keeps the builder pure.

## Findings

### F1 — Sessions with only stepless entries are dropped, and the empty-state message is wrong

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Decisions D1 and D10; Phase 1 §3 (builder contract); Phase 2 §3 (`loaded` with `sessions.length === 0`)
- **Detail**: The rules conflict for recipes with no steps:
  - D1 says "Sessions with neither steps nor notes are omitted".
  - D10 says a recipe with no steps, or one missing from the read, "still appears as an entry, with `hasSteps: false` … It renders 'No steps recorded'".
  - A D10 entry has no steps and no notes. So if it is the only dish of its session, D1 deletes the session and the "No steps recorded" entry is never rendered. That defeats D10.
  - Worse, a plan whose meals all use stepless recipes yields `sessions: []`. The page then shows `SESSIONS_EMPTY` ("Nothing to cook: this plan has no meals yet."), which is false: the plan has meals.
  - The unit test for D10 (Phase 1 §5) does not catch this, because it probably mixes a D10 dish with normal ones.
- **Fix**: Make the rules agree:
  - Restate D1's omission rule as "a section is omitted when it has no entries and no batch notes, and a session when it has no sections".
  - Render `SESSIONS_EMPTY` only when `plan.meals.length === 0`. With the new rule this is equivalent to `sessions.length === 0`, but state it in terms of meals.
  - Add a unit test: a plan whose only meal uses a zero-step recipe yields exactly one session, holding one `hasSteps: false` entry, plus the diagnostic.
- **Decision**: FIXED — Fix applied: D1 omission rule restated per section/session; `sessions-empty` keyed on `plan.meals.length === 0`; zero-step-only plan unit test added.

### F2 — The new seed fixtures duplicate `macro-solver.fixtures.ts`, which already holds the worked example

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 1 §4 (`cooking-sessions.fixtures.ts`: `SEED_RECIPE`, `planOf()`) and §5 (worked example, D6 merge, un-shared cases)
- **Detail**: The plan's new fixture file re-creates things that already exist.
  - Phase 1 §4 adds a named recipe-id map (`SEED_RECIPE.curry`) and a `planOf(meals)` helper that builds meals from `(dayIndex, mealType, recipeId, dishId)` tuples.
  - `src/lib/services/macro-solver.fixtures.ts` already exports the recipe ids `JAJECZNICA` … `ZAPIEKANKA` (:152-159) and `day(recipes, eaters, dayIndex)`, which yields `PlanMealRecord[]` with deterministic meal and dish ids (:285).
  - It also exports `shareDish()` (:309). Most importantly, it exports **`F5`** (:330), "F1 on two days with the curry lunch cooked once on day 0 and eaten on both". That is exactly this plan's worked example. `F5_UNSHARED` is the un-share case.
  - A second id map and a second meal factory would be pattern proliferation in test code. They would also produce worked-example dish ids that differ from the S-04/S-08 suites, for no benefit.
- **Fix**: Narrow `cooking-sessions.fixtures.ts`:
  - Export only `SEED_RECIPE_STEPS` (the 33 transcribed steps, keyed by the existing `JAJECZNICA`…`ZAPIEKANKA` constants) and a two-line `planOf(meals: PlanMealRecord[]): MealPlan` wrapper (fixed start `2031-01-20`, like `plan()` in `shopping-list.test.ts:113`).
  - Build the test plans with `day()` / `shareDish()`: the worked example is `F5`, the un-shared case `F5_UNSHARED`, the D6 merge `day([null, null, LECZO, null, LECZO])`, and the dinner rule `day([…, KREWETKI])`.
  - Drop the `SEED_RECIPE` map from the contract.
  - The fixture dish ids (`…0000000{day}02{slot}`) sort by day, then slot, so the D5 dish-id tie-break stays readable.
- **Decision**: FIXED — Fix applied: fixtures narrowed to `SEED_RECIPE_STEPS` + `planOf(PlanMealRecord[])`; tests build plans with `day()`/`shareDish()`/`F5`/`F5_UNSHARED`; `SEED_RECIPE` dropped.

### F3 — The claim that `test:seed` pins the fixtures' timings is overstated

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §4 ("The seed's ids and timings are pinned by `npm run test:seed`, so the fixtures cannot drift silently")
- **Detail**: `supabase/tests/seed_integrity.sql` does not pin individual steps. It pins the step **count** (`['seed_recipe_steps', '33']`, :330) and requires that every `step_timing` value occurs at least once (:246-249). Nothing checks any single step's `timing`, `position` or `duration_minutes`. A seed migration could change a duration, or flip a timing while keeping coverage, without `test:seed` failing. Two things actually guard against drift: the smoke test's SQL-derived per-session step **sets**, and its hand-derived Sunday **order**, which shifts with most duration changes. Manual check 1.5 covers it once, by eye.
- **Fix**: Reword the sentence in Phase 1 §4:

  > `test:seed` pins the step count and timing coverage only. Drift in a single step's timing or duration is caught by the S-10 smoke test (per-session step sets from SQL, plus Sunday's order).

  Also put the oracle query (`select id, recipe_id, position, timing, duration_minutes from public.recipe_steps where id::text like '5eed0005-%' order by id;`) in the fixture file's header comment, so a later seed migration knows how to re-transcribe.
- **Decision**: FIXED — Fix applied: Phase 1 §4 test:seed claim reworded; oracle query required in the fixture header comment.

### F4 — Step id and step-row contract details do not match the existing types

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1 (`ScheduledStep extends RecipeDetailStep`); Phase 2 §1 ("Reuse the existing `StepRow` type"); Phase 2 §3 (`data-step-id={stepId}`); Phase 3 §3 (CLAUDE.md: "steps carry `stepId`")
- **Detail**: Two mismatches:
  - **Step id.** `RecipeDetailStep` (types.ts:78-85) names its id `id`, so `ScheduledStep` has `id`, not `stepId`. The page contract and the CLAUDE.md hand-off text both say `stepId`. S-11 is told to rely on these field names, so the docs must name the real field.
  - **Missing `recipe_id`.** `StepRow` (recipes.ts:106-113) has no `recipe_id`, and `getRecipeDetail()` selects `id, position, instruction, timing, component_id, duration_minutes` (:172) without it. A multi-recipe read must select `recipe_id` and type it, or it cannot group steps by recipe.
- **Fix**:
  - Phase 2 §3: write `data-step-id={step.id}`. Phase 3 §3: write "steps carry `id` (the library step id), `recipeId` and `entryKey`".
  - Phase 2 §1: specify the select `id, recipe_id, position, instruction, timing, component_id, duration_minutes` and the row type `StepRow & { recipe_id: string }`.
- **Decision**: FIXED — Fix applied: `data-step-id={step.id}`; steps select includes `recipe_id`, typed `StepRow & { recipe_id: string }`; CLAUDE.md hand-off names `id`.

### F5 — The S-11 hand-off says to attach amounts "by `dishId`", but stored meals carry no dish id when a batch is not shared

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 §3, CLAUDE.md bullet ("S-11 attaches amounts through `getDaySolutions()` by `dishId` and never re-derives them")
- **Detail**: In the stored solve, `DaySolutionMeal` (types.ts:245-255) has `mealId` but no `dishId`. Its `batch` is `null` "when the meal's batch is cooked for this meal alone". So a stored solve cannot be looked up by the plan's `dishId` for an ordinary unshared dish. S-09 handles this by mapping `mealId → plan dishId` first and using `meal.batch?.dishId ?? dishOfMeal.get(meal.mealId)` (shopping-list.ts:54-58). Documenting the hand-off as "by `dishId`" would point S-11 at a lookup that misses every unshared dish. S-10's own contract already supplies what S-11 needs (`entry.meals[].mealId` plus `dishIds`), so only the documentation is wrong.
- **Fix**: Word the CLAUDE.md hand-off as:

  > S-11 attaches amounts from `getDaySolutions()` by matching stored `meals[].mealId` to an entry's `meals[].mealId`, resolving each to the plan's `dishId` as `buildShoppingList()` does (`batch.dishId` is null for unshared dishes). It counts each `dishId` once and never re-derives quantities.
- **Decision**: FIXED — Fix applied: CLAUDE.md S-11 hand-off reworded to match by `mealId` and resolve to the plan `dishId` as `buildShoppingList()` does.

### F6 — A redundant batch note when two meals of one batch land in the same section

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Decision D4; Phase 1 §3 step 3 ("Add a batch note … for every non-earliest meal of a dish with more than one meal"); Phase 1 §5 (no same-section share test)
- **Detail**: S-08 allows sharing on one day, for example Monday Lunch with Monday Afternoon snack (both morning sections), or Monday Lunch with Monday Dinner. In the same-morning case, D4 puts the later meal's note in the very section that already holds the dish's fresh entry. The entry says `For Monday Lunch and Monday Afternoon snack`, and directly below it a note says `Afternoon snack: from the same batch as Monday Lunch — nothing new to cook.` The line is redundant and slightly confusing ("nothing new to cook" sitting next to the steps that cook it). The worked example never hits this case, and no unit test covers it, so the behaviour would ship unexamined.
- **Fix A ⭐ Recommended**: Suppress a note whose section is the one that holds the dish's fresh entry.
  - Only emit a batch note when the later meal's D3 section differs from the section that holds the dish's fresh-steps entry. Dishes with no fresh steps keep every note.
  - Add a unit test: a batch shared by Monday lunch and Monday afternoon snack gives one morning entry `For Monday Lunch and Monday Afternoon snack` and no note. The same batch shared by Monday lunch and Monday dinner keeps a note in Monday evening's Tonight section.
  - Strength: no duplicate lines; the entry's meal list already says the same thing; the change is one condition plus one test.
  - Tradeoff: the note rule is no longer a uniform "every later meal gets a note", which adds a branch to the builder and to the CLAUDE.md description.
  - Confidence: HIGH. Same-section notes add no information that the entry's meal list does not already carry.
  - Blind spot: not checked whether S-11's cook mode wants a per-meal marker inside the cooking session (it can derive one from `entry.meals`).
- **Fix B**: Keep the uniform rule, but pin it in a test.
  - Leave D4 as is and add the same-morning share unit test asserting the note *is* emitted, so the behaviour is deliberate.
  - Strength: simplest rule to document and to reason about. Every later meal always has exactly one note.
  - Tradeoff: the page shows a redundant line for same-section shares.
  - Confidence: MED. It is acceptable UX, but slightly noisy.
  - Blind spot: none significant.
- **Decision**: FIXED — Fix A (Recommended): same-section batch notes suppressed in D4 and Phase 1 §3; same-section / cross-section share unit test added.
