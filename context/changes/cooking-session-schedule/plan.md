# Cooking-Session Schedule (S-10) Implementation Plan

## Overview

Roadmap S-10 (US-03, FR-022; prerequisite S-03): a signed-in household member opens `/plan/sessions` and sees one 3-day meal plan arranged into **evening and morning cooking sessions**, such as "Sunday evening" or "Monday morning". In each session the steps of several recipes are **merged into one ordered list**. Everything that can be made ahead goes to the evening before. A morning holds only what must be fresh. A shared batch (S-08) is cooked once.

The schedule is a pure, deterministic function of the plan and the library's step metadata (`recipe_steps.timing`, `duration_minutes`). It is derived on every read and never stored. It shows steps, not amounts: per-person portions are S-11's job. So it needs no solve, no migration and no write path.

This plan was written in a non-interactive session. Every open question from the research is decided below as a **[Decision]**, using the research's recommended option. Each decision names its alternative, so a reviewer can overturn it before implementation.

## Current State Analysis

- Nothing schedule-related exists yet: no service, type, label, route, test or smoke step.
- All the inputs already exist (research §2):
  - **Plan.** `getMealPlan(supabase, startDate?)` (`src/lib/services/meal-plans.ts:113`) returns `MealPlan { id, startDate, updatedAt, meals: PlanMealRecord[] }`. Each meal carries `mealId`, `dishId`, `dayIndex`, `mealType`, `recipeId` and `eaterUserId` (`src/types.ts:116-139`). Without a date it returns the most recently saved plan.
  - **Batches.** One `dishId` is one cooked batch. Since S-08 a dish may feed several meals, on one day or across days. Its cook day is the lowest day among its meals (`cookDayIndex()`, `src/lib/services/macro-solver.ts:140`).
  - **Steps.** These live in the public library table `recipe_steps` (`id, recipe_id, position, instruction, timing, component_id, duration_minutes`; `supabase/migrations/20261008150000_shared_recipe_library.sql:358-371`). `timing` is `make_ahead` ("can be done the evening before") or `fresh` ("right before eating").
  - **Existing step read.** The only one is `getRecipeDetail()` (`src/lib/services/recipes.ts:166-207`), which reads one recipe. It uses separate flat queries because embedding steps under `recipes` risks PGRST201. `getIngredientProducts()` (`recipes.ts:285`) shows the multi-recipe `.in("recipe_id", ids)` pattern.
  - **Helpers.** `MEAL_TYPES`, `PLAN_DAYS`, `isIsoDate()`, `addDays()` and `weekdayLabel()` are in `meal-plans.ts:9-34`. `joinList()` is in `src/lib/utils.ts:9`. `MEAL_TYPE_LABELS` and `STEP_TIMING_LABELS` are in `src/lib/recipe-labels.ts:5-21`.
- **Seed shape** (`supabase/migrations/20261007120100_seed_products_and_recipes.sql:215-290`, research §2.3):
  - In all 8 seed recipes the make-ahead steps form a prefix and the fresh steps a tail.
  - Two make-ahead steps are untimed and passive: Owsianka 2 (overnight in the fridge) and Krewetki 1 (thaw).
  - Curry 5 and Leczo 5 are fresh "reheat / serve" steps.
  - No step carries equipment metadata.
- **Template to copy.** S-09's split: pure builder `shopping-list.ts`, I/O wrapper `shopping.ts`, page `src/pages/plan/shopping.astro` with a `not-found` / `unavailable` / `no-plan` / `loaded` state machine, vitest suite `shopping-list.test.ts`.
- **Routing.** `/plan/sessions` is protected for free by the `/plan` prefix in `PROTECTED_ROUTES` (`src/middleware.ts:4-11,25`).
- **Smoke.** `testIdText()` / `testIdBody()` (`scripts/smoke.mjs:75`, `:116`) match `<p>` elements only. The shared-batch plan `2031-01-20` (F1 on Monday and Tuesday, Tuesday lunch sharing Monday's curry batch) is driven through an order-sensitive S-08 sequence (`smoke.mjs:888-1079`). "A re-shares Tuesday's lunch" (`:1058`) restores exactly the shared F1 state just before the lead-slot swap (`:1066`).

## Desired End State

- `/plan/sessions?start=<YYYY-MM-DD>` shows the plan's cooking sessions in chronological order. `/plan/sessions` alone uses the most recently saved plan. Each session has:
  - a title such as `Sunday evening` and its date;
  - a duration line, `About 118 min of steps · 1 untimed step`;
  - its sections. An evening has up to two: **Tonight** (fresh steps for that day's dinner) and **For tomorrow** (make-ahead steps for the next day). A morning has one unlabelled section.
- Each section lists:
  - the dishes cooked in it, each with the meals it feeds (`For Monday Lunch and Tuesday Lunch`, plus `· 2 batches` when two dishes of one recipe are merged);
  - any **batch notes** for later meals of a shared batch (`Lunch: from the same batch as Monday Lunch — nothing new to cook.`);
  - one **merged, numbered step list**. Each step shows the recipe name, the component (if any), the instruction and the duration (`15 min`, or `no set time`).
- A shared batch's steps appear exactly once across the whole schedule.
- Malformed `start` → 404. A date with no plan → `No plan for that date.` A failed read → 500, never "no plan". A plan with no meals → `Nothing to cook: this plan has no meals yet.`
- `/plan` (outside the grid form) and the dashboard link to the page next to "Shopping list".
- These all pass: `npm test` (new `cooking-sessions.test.ts`), lint, `astro check`, build and `npm run smoke` (new S-10 section). `npm run test:rls`, `test:seed` and `check:migrations` are untouched. CLAUDE.md and README describe the slice.

### Key Discoveries:

- **The dish is the unit of cooking.** S-09 already groups meals by `dishId` (`src/lib/services/shopping-list.ts:70-74`). Using the plan's `dishId`, not the stored `batch.dishId`, keeps the schedule independent of solving. For solved plans the two ids are equal (CLAUDE.md, S-08 bullet).
- **The cook day equals the earliest meal's day.** The lowest day of a dish's meals is by definition the day of its earliest meal. So the builder can derive both from one "earliest meal" helper, and it never imports `macro-solver.ts`. A unit test asserts agreement with `cookDayIndex()` so the two can never drift.
- **Seed recipe ids and step ids are stable** (`5eed0002-…` recipes, `5eed0005-…` steps). The smoke test can pin step ids from an independent SQL query. Instructions contain Polish characters, so they make poor test keys.
- **Hand-derived worked example** (research §4, re-derived for this plan; recipes 1 Jajecznica, 2 Owsianka, 4 Curry, 6 Leczo, 7 Twarożek). Sunday evening's merged order by step id suffix is `601, 401, 602, 603, 402, 403, 404, 701, 201, 702, 604, 202`: known minutes 118, 1 untimed. Monday morning is `101, 102, 405, 103, 203, 104, 703`. Monday evening is Tonight `605`, then For tomorrow `601, 602, 603, 701, 201, 702, 604, 202` (Leczo's 60 leads until its chain drops to 5; Twarożek's 8 goes next; then the three-way tie at 5 goes to second breakfast, then afternoon snack, then dinner). Tuesday morning is `101, 102, 103, 203, 104, 703` plus the Tuesday Lunch batch note. Tuesday evening is Tonight `605`. The implementer must re-check these sequences against the algorithm below when writing the unit test. If they disagree, the algorithm as specified wins, and the smoke constants follow the unit test.

## What We're NOT Doing

- **No step-by-step cook mode, no per-step "done" state, no amounts or portions** (S-11). No island: the page has no client state.
- **No storage.** No table, migration, RPC, KD code or isolation-test change. The schedule is derived on read.
- **No solve dependency.** No read of `plan_day_solutions` and no currency or staleness logic. The schedule changes on the next read after any plan edit.
- **No library schema change.** No equipment, active/passive or "serve" timing values (research Open Questions 4, 6). Those belong with S-07 / S-11.
- **No clock times, timeline or parallel lanes.** The order is a priority order, and the minute total is a sequential upper bound.
- **No per-person view.** Both partners see the same household schedule, and eaters are ignored.
- **No multi-plan schedule.** A plan's day-0 dinner fresh steps stay in that plan's day-0 evening, even when a previous plan's day 2 overlaps.
- **No roadmap / archive housekeeping** outside S-10.

## Implementation Approach

The slice follows S-09's pure-core / thin-shell split:

1. **Pure engine** (Phase 1). Add the types, labels, the pure builder `buildCookingSessions()` with its display strings, a seed-step fixture file and a vitest suite. Nothing user-visible changes yet.
2. **Read + page + navigation** (Phase 2). Add `getRecipeSteps()`, the I/O wrapper `getCookingSchedule()`, the protected `/plan/sessions` page, and links from `/plan` and the dashboard. The slice is complete and usable after this phase.
3. **Smoke + docs** (Phase 3). Cover the slice end to end over HTTP on the shared plan `2031-01-20`, and update CLAUDE.md and README.

### Decisions taken in place of questions

Each decision uses the research's recommended option.

- **[Decision] D1 — Session identity.** A session is `(calendar date, part)`, with part ∈ {`morning`, `evening`}. Its key is `<YYYY-MM-DD>-<part>`, which is URL-safe and used as the section anchor and S-11's future handle. It is titled `<Weekday> <part>`. Up to 7 sessions exist: the evening before day 0, then the morning and evening of days 0–2. A section is omitted when it has no entries and no batch notes, and a session when it has no sections (so a D10 entry with no steps still keeps its section and session). *Alternative:* sessions named relative to plan days ("Day 1 evening"). Rejected: the concept doc names sessions by their own weekday ("Monday evening … for Tuesday").
- **[Decision] D2 — Make-ahead steps** of a dish go to the **evening before its cook day** (`addDays(startDate, cookDay − 1)`), in that evening's **For tomorrow** section. This is the PRD's literal rule.
- **[Decision] D3 — Fresh steps go once per dish**, to the session of its **earliest meal** ((day, `MEAL_TYPES` order)). For breakfast, second breakfast, lunch or afternoon snack that is the morning of that day (the morning's only section). For **dinner** it is the **evening of the same day** (**Tonight** section). *Alternative (PRD-literal):* every fresh step in the morning, which would cook a fresh dinner at breakfast time. Rejected: FR-022 says the morning holds *only* what must be fresh, not *all* of it.
- **[Decision] D4 — Shared batches (S-08)** contribute every step once, deduplicated by the plan's `dishId`. Each **later meal** of a dish gets a **batch note**, not steps, in the section where its own fresh steps would have gone (D3 applied to that meal): `<Meal>: from the same batch as <Weekday> <Meal> — nothing new to cook.` The note names the batch's earliest meal. A note is emitted only when that section differs from the section holding the dish's fresh-steps entry: a same-section share (e.g. Monday Lunch and Monday Afternoon snack) is already named by the entry's meal list. Dishes with no fresh steps keep every note. *Alternative:* repeat fresh steps per eating day. Rejected: that would bake a shared Zapiekanka twice with full batch amounts. *Known cost:* the reheat step (Curry 5) is not repeated for the later meal. That is consistent with "reheating happens during the day". S-11 owns serving.
- **[Decision] D5 — Ordering within a section: longest remaining chain first.** This answers the roadmap's open question and confirms change.md.
  - Each entry is a queue of its steps for that section, in `position` order. That order is a hard constraint.
  - An entry's priority is the sum of `durationMinutes` of its remaining steps in the section, where null counts as 0.
  - At each pick, the head step of the highest-priority entry goes next.
  - Ties go to the entry's earliest meal (day, then `MEAL_TYPES` index), then the recipe name (`localeCompare(…, "pl")`), then the entry key (its smallest `dishId`).
  - *Alternatives:* contiguous recipe blocks (not really "merged"); by equipment (no data).
- **[Decision] D6 — Same-recipe dishes in one section merge into one entry.** Their steps are listed once, `dishIds` holds all of them and the meta line says `· N batches`. *Alternative:* one entry per dish, which would repeat "Preheat the oven". Merging never crosses sections (Tonight vs For tomorrow) or sessions.
- **[Decision] D7 — Untimed steps** count 0 for priority. They count as "untimed" in the session's duration line. No hoisting of passive steps in v1.
- **[Decision] D8 — Defensive prefix rule.** A `make_ahead` step is scheduled ahead only if every earlier step of its recipe (lower `position`) is also `make_ahead`. Otherwise it is treated as fresh and recorded in `diagnostics.makeAheadDemoted`. The seed never triggers this. It protects future S-07 / S-12 recipes.
- **[Decision] D9 — Evening sections.** An evening has an ordered **Tonight** section first, then **For tomorrow**. The merge runs per section, so tomorrow's 60-minute leczo never pushes tonight's dinner down. The evening before day 0 has only For tomorrow. Day 2's evening has only Tonight.
- **[Decision] D10 — A recipe with no steps, or a recipe missing from the read**, still appears as an entry, with `hasSteps: false`, in the section its fresh steps would use (D3). It renders "No steps recorded". It is logged with `console.error` like S-09's diagnostics, and never fails the page.
- **[Decision] D11 — Route and default.** The route is `/plan/sessions?start=…`, and the latest saved plan is the default, as on `/plan/shopping`. S-11 can add a per-session route later, keyed by the D1 session key.
- **[Decision] D12 — Smoke pinning.** Pin the session keys in order, each session's step-id **set** (from an independent SQL query over `recipe_steps`), Sunday evening's exact **order** (hand-derived from D5), the dedup (curry steps appear only on Sunday evening and Monday morning) and the Tuesday batch note. The exact orderings of every case are covered by `npm test`.

## Critical Implementation Details

- **Smoke ordering.** The S-10 smoke steps need the `2031-01-20` plan in its plain shared F1 state. Insert them right after "A re-shares Tuesday's lunch" (`scripts/smoke.mjs:1058`) and before "A swaps Monday's lunch" (`:1066`). Add a comment like the S-09 ones at `:978` / `:1027`, warning that they depend on that state. They do not depend on any solve.
- **No apostrophes in pinned strings.** Astro escapes `'` as `&#39;` in text (`smoke.mjs:213-214`). Every string the smoke test pins (session titles, duration line, batch note, empty / no-plan messages) is worded without apostrophes.

## Phase 1: Pure scheduling engine

### Overview

Add the types, labels, the pure builder with its display strings, the seed-step fixtures and a vitest suite that pins the rules D1–D10 and the worked example. Nothing is wired into a page yet.

### Changes Required:

#### 1. Types

**File**: `src/types.ts`

**Intent**: Add an `--- S-10 ---` block with the schedule's input and output types, shaped for the S-11 hand-off (every step and entry carries its ids).

**Contract**: Reuse `RecipeDetailStep` for library steps. S-11 depends on the field names below, so keep them.

```ts
// Input: one recipe's ordered steps, as read for the plan's recipes.
export interface RecipeSteps { recipeId: string; recipeName: string; steps: RecipeDetailStep[] }

export type SessionPart = "morning" | "evening";
// now: fresh steps for meals of the session's own day; ahead: make-ahead for the next day.
export type SessionSectionKind = "now" | "ahead";

export interface SessionMealRef { mealId: string; dishId: string; dayIndex: PlanDayIndex; mealType: MealType }
export interface ScheduledStep extends RecipeDetailStep { recipeId: string; recipeName: string; entryKey: string }
export interface CookingSessionEntry {
  key: string;            // stable within the schedule (section key + smallest dishId)
  recipeId: string;
  recipeName: string | null; // null when the recipe was missing from the read
  dishIds: string[];      // sorted; length > 1 means merged same-recipe batches (D6)
  meals: SessionMealRef[]; // every meal those dishes feed, (day, meal type) order
  hasSteps: boolean;
}
export interface SessionBatchNote { meal: SessionMealRef; recipeName: string | null; leadMeal: SessionMealRef }
export interface CookingSessionSection {
  kind: SessionSectionKind; entries: CookingSessionEntry[]; steps: ScheduledStep[]; batchNotes: SessionBatchNote[];
}
export interface CookingSession {
  key: string; date: string; part: SessionPart; sections: CookingSessionSection[]; // "now" before "ahead"
  stepCount: number; knownMinutes: number; untimedCount: number;
}
export interface CookingSchedule {
  planId: string; startDate: string; sessions: CookingSession[]; // chronological
  diagnostics: { missingRecipeIds: string[]; recipesWithoutSteps: string[]; makeAheadDemoted: string[] /* step ids */ };
}
```

#### 2. Labels

**File**: `src/lib/recipe-labels.ts`

**Intent**: Add an `--- S-10: cooking sessions ---` block, so S-14 localises one file.

**Contract**: `SESSION_PART_LABELS: Record<SessionPart, string>` = `{ morning: "morning", evening: "evening" }`. `SESSION_SECTION_LABELS: Record<SessionSectionKind, string>` = `{ now: "Tonight", ahead: "For tomorrow" }`. The `now` label is rendered only in evenings.

#### 3. Pure builder and display strings

**File**: `src/lib/services/cooking-sessions.ts` (new)

**Intent**: Write the deterministic schedule engine (D1–D10) and the strings the page renders and the smoke test pins. Keep it pure: no Supabase, no zod, no `macro-solver.ts` import. Mirror `shopping-list.ts`'s header comment and layout (builder, then a `--- display text ---` block).

**Contract**:

- `buildCookingSessions(input: { plan: MealPlan; recipeSteps: Record<string, RecipeSteps> }): CookingSchedule`.
  1. Group `plan.meals` by `dishId`. For each dish, take its **earliest meal** by (dayIndex, `MEAL_TYPES` index, mealId). That meal's day is the cook day.
  2. Split the recipe's steps (sorted by `position`) with the D8 prefix rule.
  3. Place the make-ahead part (D2) and the fresh part (D3). Add a batch note (D4) for every non-earliest meal of a dish with more than one meal, unless the note's section is the one that holds the dish's fresh-steps entry.
  4. Within each section, merge dishes of the same recipe into one entry (D6).
  5. Order each section's steps by D5.
  6. Compute the session totals.
  - **Output must not depend on input order**: shuffled `plan.meals` or `steps` give an identical result. Sort entries in a section by the D5 tie-break keys. Sort batch notes by `MEAL_TYPES` index.
- A dish whose recipe has no steps, or is missing from `recipeSteps`, follows D10.
- Display text, all apostrophe-free:
  - `SESSIONS_UNAVAILABLE = "Cooking sessions are unavailable right now."`
  - `SESSIONS_NO_PLAN = "No plan yet — start one to get cooking sessions."`
  - `SESSIONS_NO_PLAN_FOR_DATE = "No plan for that date."`
  - `SESSIONS_EMPTY = "Nothing to cook: this plan has no meals yet."`
  - `SESSIONS_NO_STEPS = "No steps recorded"`
  - `formatSessionTitle(date, part)` → `"Sunday evening"` (`weekdayLabel()` + `SESSION_PART_LABELS`).
  - `formatSessionMinutes({ knownMinutes, untimedCount })` → `"About 118 min of steps · 1 untimed step"`. Without the untimed suffix when 0, plural `steps`. `"No timed steps · 2 untimed steps"` when knownMinutes is 0.
  - `formatStepDuration(minutes | null)` → `"15 min"` / `"no set time"`.
  - `formatEntryMeals(entry, startDate)` → `"For Monday Lunch and Tuesday Lunch"` (`joinList`, `MEAL_TYPE_LABELS`), with `" · 2 batches"` appended when `dishIds.length > 1`.
  - `formatBatchNote(note, startDate)` → `"Lunch: from the same batch as Monday Lunch — nothing new to cook."`

#### 4. Seed-step fixtures

**File**: `src/lib/services/cooking-sessions.fixtures.ts` (new)

**Intent**: Transcribe the 33 seed steps (`seed_products_and_recipes.sql:215-290`) into a `Record<recipeId, RecipeSteps>`, keyed by the existing recipe-id constants `JAJECZNICA` … `ZAPIEKANKA` from `src/lib/services/macro-solver.fixtures.ts:152-159`. Keep ids, recipe ids, positions, timings, durations and component names. Instructions may be shortened. Add a two-line `planOf(meals: PlanMealRecord[]): MealPlan` wrapper (fixed start `2031-01-20`, like `plan()` in `shopping-list.test.ts:113`). Test meals are built with the existing `day()` / `shareDish()` helpers of `macro-solver.fixtures.ts`, not a second meal factory, so dish ids match the S-04/S-08 suites (`…0000000{day}02{slot}`, sorting by day then slot, which keeps the D5 dish-id tie-break readable). `test:seed` pins the step count and timing coverage only. Drift in a single step's timing or duration is caught by the S-10 smoke test (per-session step sets from SQL, plus Sunday's order).

**Contract**: Exports only `SEED_RECIPE_STEPS` and `planOf()`. Component names must match `recipe_components.name` for the referenced component ids. The file's header comment holds the oracle query a later seed migration uses to re-transcribe: `select id, recipe_id, position, timing, duration_minutes from public.recipe_steps where id::text like '5eed0005-%' order by id;`.

#### 5. Unit tests

**File**: `src/lib/services/cooking-sessions.test.ts` (new)

**Intent**: Pin every rule and the worked example, in the style of `shopping-list.test.ts`.

**Contract** (one `it` each, at minimum):

- **Worked example** (`planOf(F5)`: F1 on days 0 and 1, Tuesday lunch sharing Monday's curry dish):
  - The session keys in order: `2031-01-19-evening`, `2031-01-20-morning`, `2031-01-20-evening`, `2031-01-21-morning`, `2031-01-21-evening`.
  - The exact step-id order of every section, as in Key Discoveries, re-derived.
  - Sunday evening's `knownMinutes` 118 and `untimedCount` 1.
  - The Tuesday-morning batch note for lunch, whose lead meal is Monday lunch.
- **Dedup:** across the whole schedule every curry step id occurs exactly once, and the curry entry's `meals` lists both lunches. With `planOf(F5_UNSHARED)` the curry steps appear once per dish instead.
- **Dinner rule:** a day-0 Krewetki dinner (`day([…, KREWETKI])`) has its thaw step in the evening before day 0 (For tomorrow) and its fresh steps in day 0's evening Tonight section. A day-2 dinner creates the day-2 evening session.
- **Make-ahead-only and fresh-only recipes:** Ciastka appears only in the evening before, Jajecznica only in its morning.
- **D6 merge:** two separate Leczo dishes (day 0 lunch and dinner, `day([null, null, LECZO, null, LECZO])`) share one For-tomorrow entry, with `dishIds.length === 2` and each Leczo step id once. Their fresh steps land in different sections (morning vs Tonight), so they stay separate there.
- **D4 same-section share:** a batch shared by Monday lunch and Monday afternoon snack gives one morning entry `For Monday Lunch and Monday Afternoon snack` and no batch note. The same batch shared by Monday lunch and Monday dinner keeps a note in Monday evening's Tonight section.
- **D8:** a synthetic recipe `MA, F, MA` schedules its third step as fresh and lists it in `makeAheadDemoted`.
- **D10:** a recipe with zero steps, and a dish whose recipe is absent from `recipeSteps`, each yield an entry with `hasSteps: false` and a diagnostic. A plan whose only meal uses a zero-step recipe yields exactly one session, holding one `hasSteps: false` entry, plus the diagnostic (the D1 omission rule must not drop it).
- **Tie-breaks:** equal remaining chains fall back to earliest meal, then recipe name with Polish collation (use two synthetic recipes whose names differ only by a Polish letter), then dish id.
- **Determinism:** shuffling `plan.meals` and each recipe's `steps` yields a deep-equal schedule.
- **Cross-check:** for every dish of the fixture plans, the session date of its make-ahead entry equals `addDays(startDate, cookDayIndex(dishMeals) − 1)`. This imports `cookDayIndex` from `macro-solver.ts`, in the test only.
- **Empty plan** → `sessions: []`.
- **Formatters:** singular/plural and the zero-minute variant of `formatSessionMinutes`, `formatStepDuration(null)`, `formatEntryMeals` with 2 batches, and `formatBatchNote`.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`

#### Manual Verification:

- Start `npm run dev`, sign in and open `/recipes`. Open **Kurczak curry z ryżem**, **Leczo z kiełbasą** and **Owsianka proteinowa (overnight)**. Confirm each recipe's make-ahead / fresh split and step durations match the fixture file (curry: 4 make-ahead steps of 15/5/10/15 min, then 1 fresh step of 5 min; Owsianka step 2 has no time). This confirms the fixtures the tests rely on match what the app reads.
- With the dev server still running, open `/plan` and `/plan/shopping` for any existing plan. Both render exactly as before (no regressions; no user-visible change is expected in this phase).
- Read the "worked example" test in `cooking-sessions.test.ts`. Confirm its Sunday-evening order reads as a sensible cooking order: the leczo prep and its 30-min simmer start first, the curry rice and sauce follow, and short tasks and the overnight fridge step come last.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Steps read, sessions page and navigation

### Overview

Wire the engine to the database and render `/plan/sessions`, with links from `/plan` and the dashboard. After this phase the slice is usable end to end.

### Changes Required:

#### 1. Multi-recipe steps read

**File**: `src/lib/services/recipes.ts`

**Intent**: Add an `--- S-10 ---` block with `getRecipeSteps()`, which reads the ordered steps of any number of recipes. It uses three parallel flat queries (`recipes` id/name `.in("id")`, `recipe_components` id/name `.in("recipe_id")`, `recipe_steps` `.in("recipe_id")`) and no embed, for the PGRST201 reason already documented at `recipes.ts:163-165`.

**Contract**: `getRecipeSteps(supabase, recipeIds: string[]): Promise<Record<string, RecipeSteps>>`.

- Ids are deduplicated, and an empty input returns `{}` with no query.
- Steps are sorted by `position`, and `componentName` is mapped as in `getRecipeDetail()`.
- A recipe that does not exist is absent from the result. A recipe with no steps is present with `steps: []`.
- Any query error throws.
- The steps query selects `id, recipe_id, position, instruction, timing, component_id, duration_minutes` (`getRecipeDetail()`'s select omits `recipe_id`, which grouping by recipe needs). Type its rows as `StepRow & { recipe_id: string }`, and reuse the existing `byPosition` helper.

#### 2. I/O wrapper

**File**: `src/lib/services/cooking.ts` (new)

**Intent**: Load the plan and its recipes' steps, run the builder and log diagnostics. This mirrors `getShoppingList()` (`src/lib/services/shopping.ts:15-50`).

**Contract**: `getCookingSchedule(supabase, startDate?: string): Promise<{ plan: MealPlan; schedule: CookingSchedule } | null>`.

- It returns `null` only when `getMealPlan()` finds no plan. A failed read throws.
- When any diagnostics array is non-empty, it calls `console.error("buildCookingSessions worked around inconsistent inputs", plan.id, schedule.diagnostics)`, with the same eslint-disable comment as `shopping.ts:46`.

#### 3. Sessions page

**File**: `src/pages/plan/sessions.astro` (new)

**Intent**: Render the schedule server-side, with no island. Copy `shopping.astro`'s state machine and layout shell (`not-found` 404 for a malformed `start`, `unavailable` 500, `no-plan`, `loaded`).

**Contract**:

- Title `Cooking sessions`, and `Plan from <startDate>` under it.
- `loaded` with `plan.meals.length === 0` → `<p data-testid="sessions-empty">{SESSIONS_EMPTY}</p>`. (Under the D1 omission rule this is equivalent to `sessions.length === 0`, but the condition is stated in terms of meals so the message is never shown for a plan that has meals.)
- One `<section id={key} data-testid={`session-${key}`}>` per session, never nested. It contains:
  - an `<h2>` with `formatSessionTitle()` and the date in smaller text;
  - `<p data-testid={`session-minutes-${key}`}>`.
- Per section:
  - an `<h3>` with `SESSION_SECTION_LABELS[kind]`, in evenings only;
  - a `<ul>` of entries: the recipe name linking to `/recipes/<recipeId>` (plain text when `recipeName` is null, shown as "Unknown recipe"), `formatEntryMeals()`, and `SESSIONS_NO_STEPS` when `!hasSteps`;
  - each batch note as `<p data-testid={`session-note-${day}_${mealType}`}>`;
  - an `<ol>` of steps, each `<li data-step-id={step.id}>` showing the recipe name, ` · componentName` if present, the instruction, a `STEP_TIMING_LABELS` badge and `formatStepDuration()`.
- Use `cn()` for any conditional classes.
- Footer links: `Back to plan` (`/plan?start=…`), `Shopping list` (`/plan/shopping?start=…`), `Back to dashboard`.
- No-plan state: `SESSIONS_NO_PLAN_FOR_DATE` when `start` was given, else `SESSIONS_NO_PLAN`, as `<p data-testid="sessions-no-plan">`, plus an "Open plan" link. Other test ids: `sessions-not-found`, `sessions-unavailable`.

#### 4. Navigation

**Files**: `src/pages/plan.astro`, `src/pages/dashboard.astro`

**Intent**: Link to the schedule wherever the shopping list is linked.

**Contract**:

- `/plan`: a `Cooking sessions` link to `/plan/sessions?start=${plan.startDate}` next to the S-09 "Shopping list" link (`plan.astro:168-175`). It stays **outside** the grid form, and gets `data-testid="plan-sessions-link"`.
- Dashboard: a `Cooking sessions` link to `/plan/sessions` after the "Shopping list" link (`dashboard.astro:125-130`), under the same `!planFailed && plan` guard.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`
- Existing smoke still passes against the dev server: `npm run smoke`

#### Manual Verification:

- **Sign-in guard:** in a private window, open `http://localhost:4321/plan/sessions`. You are redirected to `/auth/signin`.
- **Worked example:** signed in, open `/plan?start=2031-02-03` (a Monday). Fill Monday and Tuesday each with Jajecznica (breakfast), Owsianka (second breakfast), Kurczak curry (lunch), Twarożek (afternoon snack) and Leczo (dinner). In Tuesday lunch's batch-sharing selector, pick Monday Lunch, and save. Click **Cooking sessions** under the summary line. Expect:
  - exactly five sessions in this order: Sunday evening, Monday morning, Monday evening, Tuesday morning, Tuesday evening;
  - Sunday evening reads `About 118 min of steps · 1 untimed step`, has only a **For tomorrow** section whose curry entry says `For Monday Lunch and Tuesday Lunch`, and lists 12 steps starting with the leczo chopping step, then the rice;
  - Monday morning holds the fresh steps (scrambled eggs, curry "weigh portions, reheat and serve", oats topping, rolls);
  - Monday evening has **Tonight** (leczo reheat) before **For tomorrow** (oats, twarożek and leczo prep for Tuesday, with **no curry steps**);
  - Tuesday morning shows `Lunch: from the same batch as Monday Lunch — nothing new to cook.` and no curry step;
  - Tuesday evening has only Tonight's leczo reheat.
- **Un-share:** back on `/plan`, clear Tuesday lunch's batch choice and save. Reopen Cooking sessions. Monday evening's For tomorrow now includes the curry make-ahead steps (Tuesday's own batch), the curry entry on Sunday evening says only `For Monday Lunch`, and Tuesday morning has a curry fresh step and no batch note.
- **Dinner rule:** change Monday's dinner to Makaron z krewetkami and save. Sunday evening lists "thaw the shrimp" with `no set time`, and Monday evening's **Tonight** section holds the pasta-cooking steps, not Monday morning.
- **Merge (D6):** on a fresh date, put Leczo at Monday lunch and Monday dinner (no sharing). Sunday evening shows one Leczo entry with `· 2 batches` and each Leczo step once.
- **Edge states:** `/plan/sessions?start=2031-13-01` shows "Plan not found" (404 in devtools Network). `/plan/sessions?start=2040-01-01` shows `No plan for that date.` with an Open plan link. The dashboard shows a **Cooking sessions** link next to Shopping list that opens the latest plan's sessions.
- **Partner view:** signed in as the linked partner, the same URL shows the identical schedule.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Smoke coverage and documentation

### Overview

Pin the slice end to end over HTTP against the production preview, and describe it in CLAUDE.md and README.

### Changes Required:

#### 1. Smoke fixtures and helpers

**File**: `scripts/smoke.mjs`

**Intent**: Add S-10 fixtures next to the S-09 ones, documented with the SQL oracle they come from, plus small parsing helpers. Add a header line `// S-10: …` to the file's slice list (`smoke.mjs:6-7`).

**Contract**:

- A comment with the oracle query, run with `npx supabase db query --linked`:
  `select id, recipe_id, position, timing, duration_minutes from public.recipe_steps where recipe_id in (<recipes 1,2,4,6,7>) order by recipe_id, position;`
- Constants:
  - `S10_SESSION_KEYS` (the five keys for `2031-01-20`);
  - `S10_SESSION_STEPS`, a per-key **set** of step ids derived by the D2/D3/D4 rules from that query: Sunday evening = make-ahead steps of 2, 4, 6, 7; Monday morning = fresh steps of 1, 2, 4, 7; Monday evening = fresh of 6 + make-ahead of 2, 6, 7; Tuesday morning = fresh of 1, 2, 7; Tuesday evening = fresh of 6;
  - `S10_SUNDAY_ORDER` (the 12 ids in D5 order);
  - `S10_SUNDAY_MINUTES = "About 118 min of steps · 1 untimed step"`;
  - `S10_BATCH_NOTE = "Lunch: from the same batch as Monday Lunch — nothing new to cook."`.
- Helpers:
  - `sessionKeys(body)`: every `data-testid="session-<key>"` in document order, excluding `session-minutes-*` and `session-note-*`;
  - `sessionSection(body, key)`: the slice from the section's test id to its `</section>`;
  - `stepIds(html)`: `data-step-id` values in order;
  - `sessionsProblem(body)`: compares keys, per-session sets (sorted) and Sunday's exact order, and returns a descriptive message or null.

#### 2. Smoke steps

**File**: `scripts/smoke.mjs`

**Intent**: Add the S-10 sequence at two places: anonymous and edge cases with the S-09 anonymous checks, and the shared-plan checks inside the S-08 sequence (see Critical Implementation Details).

**Contract**:

- In the S-08 sequence, right after "A re-shares Tuesday's lunch" (`smoke.mjs:1058`), with an order-sensitivity comment:
  1. `A cooking sessions of the shared plan follow the schedule rules`: `GET /plan/sessions?start=2031-01-20` gives 200, `check: sessionsProblem`.
  2. `the shared curry batch is scheduled once`: every curry step id (`5eed0005-…-00000000040[1-5]`) occurs exactly once in the page, and the Tuesday-morning section has the note `testIdBody("session-note-1_lunch", S10_BATCH_NOTE)`.
  3. `Sunday evening shows its minutes`: `testIdBody("session-minutes-2031-01-19-evening", S10_SUNDAY_MINUTES)`.
  4. `B sees the same sessions`: the same check as step 1, with client `b`.
  5. `the plan page links to cooking sessions`: `/plan?start=2031-01-20` contains `data-testid="plan-sessions-link"` with `href="/plan/sessions?start=2031-01-20"`.
- With the S-09 anonymous checks:
  - `sessions page redirects anonymous user` (302 → `/auth/signin`);
  - `a malformed sessions date is 404` (`testIdBody("sessions-not-found", "Plan not found")`);
  - `a sessions date with no plan says so` (`?start=2032-01-05`, `testIdBody("sessions-no-plan", "No plan for that date.")`).
- Register the new test ids in the debug-print lists the failure printer uses (`smoke.mjs:1291-1300` pattern), so a failing step prints the relevant lines.

#### 3. Documentation

**Files**: `CLAUDE.md`, `README.md`

**Intent**: Describe the slice where every earlier slice is described.

**Contract**:

- **CLAUDE.md:**
  - Add a "Cooking sessions (S-10)" bullet under Auth flow / architecture, after the S-09 bullet. It covers:
    - derived on read, no table, no solve dependency;
    - the session model and the D2/D3/D4/D5/D6/D8/D9 rules in one paragraph each at most;
    - the dedup by the plan's `dishId`;
    - the files (`cooking-sessions.ts` pure, `cooking.ts`, `getRecipeSteps()`, `src/pages/plan/sessions.astro`, the labels);
    - the S-11 hand-off: the session key `<date>-<part>`; steps carry `id` (the library step id), `recipeId` and `entryKey`; entries carry `dishIds`. S-11 attaches amounts from `getDaySolutions()` by matching stored `meals[].mealId` to an entry's `meals[].mealId`, resolving each to the plan's `dishId` as `buildShoppingList()` does (`batch.dishId` is null for unshared dishes). It counts each `dishId` once and never re-derives quantities.
  - Add the new suite to the `npm test` list.
- **README:**
  - Add a routes-table row: `/plan/sessions` — the plan's evening/morning cooking sessions with merged steps (`?start=<date>`, else the latest plan).
  - Add `cooking sessions` to the `npm test` description.
  - Add an S-10 smoke paragraph after the S-09 one, describing what is pinned and that the order oracle is the D5 rule (no SQL oracle for order; sets come from SQL).
  - Add a note in "Cleaning up after smoke runs" that S-10 stores nothing.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`
- Smoke passes against the production preview: `npm run build && npm run preview`, then `BASE_URL=http://localhost:4321 npm run smoke`
- Migration gate unchanged: `npm run check:migrations` passes (no new migration files)

#### Manual Verification:

- After the smoke run, sign in as the smoke account `smoke-<timestamp>@example.com` (password from the script) or any linked account. Open `/plan/sessions?start=2031-01-20`. Note that the smoke run leaves this plan with Monday's lunch swapped to Leczo (the last S-08 step), so the shared curry batch is gone. Expect Sunday evening to show two Leczo batches merged into one entry (`· 2 batches`), and Tuesday lunch to be a curry batch of its own whose make-ahead steps sit in Monday evening's For tomorrow section.
- Temporarily edit `S10_SUNDAY_ORDER` in `scripts/smoke.mjs` to swap two ids. Run the smoke against the preview and confirm it fails with a message naming the expected and actual Sunday-evening order. Then revert the edit.
- Read the new CLAUDE.md bullet and README paragraphs. Check that each claim matches the running app: open `/plan/sessions` from the dashboard link and from `/plan`, and confirm the routes-table description is accurate.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- All scheduling rules D2–D10 on seed fixtures and synthetic recipes (Phase 1 §5).
- The exact merged order for every section of the worked example.
- Determinism under shuffled inputs.
- Agreement with `cookDayIndex()`.
- Display formatters, including singular, plural and zero cases.

### Integration Tests:

- Smoke on the shared plan `2031-01-20`, covering: session keys and order, per-session step sets from a SQL oracle, Sunday-evening order, shared-batch dedup, the batch note, partner symmetry and the `/plan` link.
- Smoke edge cases: an anonymous visitor is redirected, a malformed date is 404, a date with no plan says so.
- No RLS or seed test changes. The steps read goes through the existing select-only library policy.

### Manual Testing Steps:

1. Build the worked-example plan on a fresh Monday and check all five sessions (Phase 2).
2. Un-share the curry and watch its steps move to Monday evening (Phase 2).
3. Put a fresh-only dinner on day 0 and check it lands in Tonight (Phase 2).
4. Put the same recipe in two slots and check the `· 2 batches` merge (Phase 2).
5. Check the 404, no-plan, anonymous and partner cases (Phase 2).

## Performance Considerations

One page load runs `getMealPlan()` plus three parallel flat library queries over at most 15 recipes (about 33 seed steps today). The builder is O(steps²) in the worst case per section, because each pick scans the entry heads. At this size that is negligible. There is no caching and no stored output.

## Migration Notes

None. S-10 adds no migration, table or function. `check:migrations`, `test:rls` and `test:seed` are unaffected.

## References

- Research: `context/changes/cooking-session-schedule/research.md`
- Change identity: `context/changes/cooking-session-schedule/change.md`
- Sibling slice to mirror: `context/changes/shopping-list-from-plan/plan.md`, `src/lib/services/shopping-list.ts`, `src/lib/services/shopping.ts`, `src/pages/plan/shopping.astro`
- Batch semantics: CLAUDE.md "Shared dish across days (S-08)"; `src/lib/services/macro-solver.ts:140`
- Step metadata: `supabase/migrations/20261007120100_seed_products_and_recipes.sql:215-290`
- Source rules: `context/foundation/prd.md:67-70,115,146`; `docs/app-concept-eng.md:128-136`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Pure scheduling engine

#### Automated

- [x] 1.1 Unit tests pass: `npm test` — feecde6
- [x] 1.2 Lint passes: `npm run lint` — feecde6
- [x] 1.3 Type check passes: `npx astro check` — feecde6
- [x] 1.4 Build passes: `npm run build` — feecde6

#### Manual

- [ ] 1.5 Recipe detail pages match the step fixtures (curry, leczo, owsianka)
- [ ] 1.6 `/plan` and `/plan/shopping` render as before
- [ ] 1.7 Worked-example test order reads as a sensible cooking order

### Phase 2: Steps read, sessions page and navigation

#### Automated

- [x] 2.1 Unit tests pass: `npm test`
- [x] 2.2 Lint passes: `npm run lint`
- [x] 2.3 Type check passes: `npx astro check`
- [x] 2.4 Build passes: `npm run build`
- [x] 2.5 Existing smoke still passes against the dev server: `npm run smoke`

#### Manual

- [ ] 2.6 Anonymous visitor is redirected from `/plan/sessions`
- [ ] 2.7 Worked-example plan shows the five expected sessions with dedup and batch note
- [ ] 2.8 Un-sharing moves the curry make-ahead steps to Monday evening
- [ ] 2.9 A fresh-only day-0 dinner lands in Monday evening's Tonight section
- [ ] 2.10 Two same-recipe dishes merge into one `· 2 batches` entry
- [ ] 2.11 Malformed date 404, no-plan message, dashboard link work
- [ ] 2.12 Partner sees the identical schedule

### Phase 3: Smoke coverage and documentation

#### Automated

- [ ] 3.1 Unit tests pass: `npm test`
- [ ] 3.2 Lint passes: `npm run lint`
- [ ] 3.3 Type check passes: `npx astro check`
- [ ] 3.4 Build passes: `npm run build`
- [ ] 3.5 Smoke passes against the production preview
- [ ] 3.6 Migration gate unchanged: `npm run check:migrations`

#### Manual

- [ ] 3.7 Post-smoke `2031-01-20` sessions show the swapped-lead state as described
- [ ] 3.8 A deliberately wrong `S10_SUNDAY_ORDER` makes smoke fail with a clear message
- [ ] 3.9 CLAUDE.md and README claims match the running app
