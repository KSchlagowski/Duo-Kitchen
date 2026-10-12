# S-08 Shared dish across days — Implementation Plan

## Overview

Let one cooked batch (`plan_dishes` row) cover meals on several days of one 3-day plan, and make the
macro solver treat the days that share a batch as **one coupled solve** so each person's *daily*
totals still land within tolerance (roadmap S-08, PRD US-01 / FR-017).

The unit of work is the **solve group**: the set of days connected (transitively) by a shared dish.
A day that shares nothing is a group of one and solves *exactly* as it does today — that is what
keeps every S-04 unit fixture and every smoke-pinned string intact.

> This plan was written in a non-interactive session. Every decision the research
> (`context/changes/shared-dish-across-days/research.md`) left open is settled inline below under
> **Decisions taken**, with the reasoning and the alternative that was rejected. No question is left
> for the implementer.

## Current State Analysis

**The groundwork is real.** S-03 chose the dish/meal split specifically so S-08 would be additive
(`context/archive/2026-10-08-plan-three-day-grid/research.md:70-76`):

- `plan_dishes` already is the batch entity, with **no quantity column** and **no
  `unique (plan_id, recipe_id)`** (`supabase/migrations/20261008170000_meal_plans.sql:63-80`). Its
  own comment at `:76` says *"S-08 lets several meals share one dish."*
- The schema change is two DDL statements, written out verbatim in the migration header at
  `supabase/migrations/20261008170000_meal_plans.sql:11-16`. Nothing (FK, view, trigger, function)
  depends on `plan_meals_dish_id_key`; the only real dependency is **index coverage**, since the
  unique index on `(dish_id)` is the sole index with `dish_id` leading and serves both the
  `on delete cascade` from `plan_dishes` and step 4d's `not exists` probe.
- `plan_day_solutions` was deliberately built FK-free against meals and dishes, storing an
  un-normalised jsonb result (`supabase/migrations/20261009120000_plan_day_solutions.sql:8-13`).
- The LP's scale variable is **already per `(meal, component, eater)`**
  (`src/lib/services/macro-solver.ts:225`) and bounded **per serving**
  (`:214`), with `batchScale = Σ x` (`:409`). `slotRank()` is already day-aware (`:65-67`).
- Additive growth of the stored jsonb is an established pattern:
  `boundsViolated: z.boolean().default(false)` (`src/lib/services/day-solutions.ts:152-153`).

**What is genuinely missing or wrong today:**

| Gap | Where | Why it blocks S-08 |
| --- | --- | --- |
| The dish is invisible above SQL | `src/lib/services/meal-plans.ts:88`, `:96-97`, `:117-129` | `getMealPlan()` projects the dish id away; there is no `PlanDish` type and no `dishId` on `PlanMealRecord`. A shared batch is unexpressible in `src/`. |
| `save_meal_plan` can only produce 1:1 | `…meal_plans.sql:303-316` (step 4c) | Unconditionally inserts a *fresh* dish per slot. Even with the constraint dropped it could never produce a shared dish. |
| The diff is dish-blind | `…meal_plans.sql:284-292` (step 4a) | Keys on `(day_index, meal_type, recipe_id)` only. A change in *grouping alone* leaves every row untouched, silently un-regrouping nothing. |
| The payload validator tolerates unknown keys | `…meal_plans.sql:217-221` | Checks the four keys are *present*, not that no others exist — a 5th grouping key passes **unvalidated** today. |
| The fingerprint cannot see grouping | `src/lib/services/macro-solver.ts:792-835`, tuple at `:800` | Emits `[mealId, mealType, recipeId, eaterUserId]` — **no `dayIndex`, no dish identity**. Toggling "share this batch" keeps the recipe, the eaters and (via step 4b) every meal id, so a pre-toggle solve reads as **current** and is wrong. This is the one silent-correctness hole. |
| The split model is hard-wired to two shares | `src/lib/services/macro-solver.ts:357-358`, `:387-393`, `:540-545` | `CompState.split` is a scalar and `fractions()` returns `[first, 1 - first]`. A batch feeding 2 days × 2 people has **four** servings. |
| The solve is single-day at two lines | `src/lib/services/day-solutions.ts:42`, `:279` | Both `plan.meals.filter((meal) => meal.dayIndex === dayIndex)`. Encouragingly `getPlanSolveStatuses()` already loads shared inputs **plan-wide** (`:271-275`), so a coupled solve needs no new database read. |
| Blame is per meal | `src/lib/services/macro-solver.ts:670-679` | Removing one meal of a shared dish does not remove the batch, so leave-one-out becomes meaningless for exactly the recipes S-08 is about. |
| One write path per day only | `supabase/migrations/20261009120000_plan_day_solutions.sql:88-169` | `save_day_solution` writes one day. A group's days must be written together: they share one fingerprint and one accepted tolerance, and a half-written group shows one day solved against a batch the other day does not know about. |

**Environment:** this checkout has no `node_modules` and no `.env` / `.dev.vars`. `npm ci` plus the
Supabase secrets are prerequisites for every verification step below.

## Desired End State

On `/plan`, each filled slot has a third select, *"Share a batch with"*, listing the other 14 slots.
Choosing one makes the two slots eat from **one** `plan_dishes` row; the grid shows a batch note on
every member slot. Solving any day of a group solves the whole group in one LP, writes one
`plan_day_solutions` row per day of the group atomically, and both days show the same status. Each
day's page shows its own cook amounts and splits plus *"set aside X for Wednesday"* on the cooking
day and *"from Tuesday's batch"* on the other. Editing either day marks **both** out of date.

Verified by: `npm test` (new cross-day fixtures F5/F6 plus the unchanged F1–F4 assertions),
`npm run test:rls` (shared-dish fixtures, the regrouping diff, the three new SQLSTATEs, the new RPC's
grants), and `npm run smoke` (a new S-08 section at `2031-01-20`).

### Key Discoveries

- **`MAX_SCALE = 1.5` needs no change.** The bound at `src/lib/services/macro-solver.ts:214` is
  **per serving**, and the cook amount is already `batchScale = x.reduce(…)` at `:409`. A dish shared
  by M meals × 2 eaters sums 2M serving variables, each still ≤ 1.5×. This corrects a worry carried
  in the archive. No solver *constant* changes.
- **Every component of a dish has the same serving set**, because a dish is one batch of one recipe
  and every component of that recipe is cooked in it and eaten by every `(meal, eater)` of it. That
  is what lets `CompState` move from "one meal" to "one dish with N servings" cleanly, and lets the
  ratio bound group by **dish** instead of by meal (`:488`).
- **The grouping must be validated in the RPC, not only the route.** `save_meal_plan` is
  `grant execute … to authenticated` (`…meal_plans.sql:328-332`), so any member can hand-build a
  payload. Route checks are UX; the RPC's are the guarantee.
- **The stored jsonb must grow additively at `version: 1`.** `daySolutionSchema` is `z.object`, not
  `.strict()` (unknown keys are *stripped*), and `version: z.literal(1)` is a hard gate whose failure
  reads as **never solved** (`src/lib/services/day-solutions.ts:188-191`, `:288-291`). A `version: 2`
  bump would turn every pre-S-08 row from the kinder *"Out of date"* (which still renders at
  `opacity-50` with "Solve again", `src/pages/plan/day.astro:161`) into *"Not solved"*.
- **A `discriminatedUnion` fails on an unknown discriminator**, unlike an unknown key, which is
  stripped (`src/lib/services/day-solutions.ts:140-151`). A third `explanation.kind` would impose
  reader-before-writer deploy ordering; an optional defaulted *flag* would not.
- **The isolation test's `plan_meals` write-revoke probe needs no restructuring.** It ends with an
  explicit `raise exception` after the insert and catches only `insufficient_privilege`
  (`supabase/tests/household_isolation.sql:596-604`), so a regressed revoke fails **loudly** as
  `P0001` — dropping `plan_meals_dish_id_key` cannot make it pass silently. It also already uses a
  free slot plus an existing dish (A's fixture meals are `(0, breakfast)` and `(1, dinner)` at
  `:168-175`; the probe uses `(2, dinner)`), so only its **comment** goes stale.
- **F3's test already uses `expect([15, 20]).toContain(...)`**
  (`src/lib/services/macro-solver.test.ts:95-99`). That is the repo's established way to pin a tier
  whose exact value is a property of the LP, and the new cross-day fixture reuses it.

## Decisions taken

Settled here so the plan has no open questions. Each maps to a numbered Open Question in
`research.md`.

**D1 — Couple the days; the unit is the solve group.** (research §1, roadmap Unknown.) "Days solved
in order with the batch fixed" fails a sizing paradox: day 0's solve optimises day 0's totals only,
so it has no reason to cook more than day 0 needs, and re-solving day 0 to fix day 1 invalidates
day 1 again — the loop does not converge. *Rejected:* sequential solving.

**D2 — One group write RPC; retire `save_day_solution`.** (research §2.5, Q2.) A group's days share
one fingerprint and one accepted tolerance; calling a per-day RPC three times is not atomic. The new
`public.save_plan_day_solutions(date, jsonb)` writes the whole group in one statement, and the old
function is dropped in the same migration so `plan_day_solutions` keeps exactly **one** write path
(the invariant CLAUDE.md states for every write-revoked table). *Rejected:* keeping both (less churn,
but two write paths into one write-revoked table).

**D3 — Sharing is an explicit per-slot choice, not inference.** (research §7.3, Q3.) Cooking the
same recipe in the same slot on two days is usually a *fresh* batch each day (scrambled eggs), so
inference would surprise. The affordance is a third select per slot naming **another slot**, not a
dish id — the app has no dish ids to render, and the grid posts one atomic snapshot against a
slot-level diff, so a slot reference stays valid even for a dish created in the same save. *Rejected:*
auto-sharing identical recipes in identical slots.

**D4 — Keep `version: 1`; grow `meals[]` additively with a nullable, defaulted `batch`.** (research §3.2.)
`DaySolutionIngredient.amountG` keeps meaning exactly what it means today — the **batch** cook amount
(`src/types.ts:207-208`). Both days of a shared dish carry its full component data, so every row
stays self-describing; downstream consumers (S-09 shopping list, S-11 cook mode) **deduplicate by
`batch.dishId`**. The absence of `batch` unambiguously means "cooked for this day alone", so
pre-S-08 rows need no interpretation rules. *Rejected:* a `version: 2` bump; a top-level `batches[]`
array (which would also break the flat render loop at `src/pages/plan/day.astro:214-246`).

**D5 — `requiredTier` is the group's tier; `maxDeviationPct` stays the day's own.** Accepting ±15 %
must apply group-wide, or one day sits at ±15 % while its partner day does not. So every day of a
group stores the same `status`, `accepted_tolerance_pct`, `input_fingerprint` and `requiredTier`
(= the worst tier over the group's days), while `maxDeviationPct` remains that day's own worst
deviation. For a singleton group the two are identical, so nothing changes today.

**D6 — Leave-one-*dish*-out, computed once per group.** (research §4.4, §6.) Strictly fewer
re-solves than leave-one-meal-out, better blame for exactly the recipes S-08 is about, and it
partially mitigates S-04's deferred F6 bias.

**D7 — No third `explanation.kind`.** Keep `kind: "recipe"` and add
`sharedAcrossDays: z.boolean().default(false)`. A new discriminator would need reader-before-writer
deploy ordering; a defaulted flag needs none. *Rejected:* a `kind: "shared_dish"` variant.

**D8 — Pot capacity is a documented limitation, not a bound.** A lunch shared across 3 days for
2 people can reach ~9× a base batch. The PRD has no servings, pantry or equipment model
(`context/foundation/prd.md:158-159`), so no cap is added. (research Q5.)

**D9 — The repair budget scales with the group.** `MAX_REPAIR_MOVES` (50) stays the **per-day**
budget; the group's budget is `MAX_REPAIR_MOVES × dayCount`. Otherwise a 3-day group gets the same
total repair spread over 3× the states and rounds worse per day. Reduces to exactly 50 for a
singleton.

**D10 — F10 (concurrent "Solve again" undoing an acceptance) is explicitly out of scope.** The
obvious SQL fix — `greatest(…)` on `accepted_tolerance_pct` in the upsert — would desynchronise the
stored `status` from the stored tolerance, because `statusFor()` is computed in the app
(`src/lib/services/macro-solver.ts:783-786`). D2's atomic group write already contains the blast
radius. See **What We're NOT Doing**.

**D11 — F8 (the fingerprint omits display names the result copies) is folded in.** `recipeName`,
`component.name` and `productName` are copied into the stored jsonb but not fingerprinted, so a
library rename leaves a stale name displayed on a row that reads as current. The `SOLVER_VERSION`
bump invalidates every stored row anyway, so this is the cheapest possible moment and it is three
lines. (research §4.5.)

## What We're NOT Doing

- **No dish across two plans.** Settled in S-03 and enforced by
  `plan_meals (dish_id, plan_id) → plan_dishes (id, plan_id)`; outside FR-017's scope (research A1).
- **No spoilage, expiry, pantry, servings or pot-capacity model** (PRD Non-Goals, D8).
- **No library schema change.** Solver bounds stay constants, not columns (research A4). No column is
  added to `recipes` / `recipe_components`, and `photo_url` still waits for S-07/S-12.
- **No new `public` table.** The design adds none, so the classification catch-all
  (`supabase/tests/household_isolation.sql:1192-1280`) needs no new entry.
- **No change to any solver constant.** `MIN_SCALE`, `MAX_SCALE`, `MAX_COMPONENT_RATIO`,
  `ZERO_TARGET_REFERENCE_G`, `TIE_BREAK_WEIGHT` and `MAX_REPAIR_MOVES` keep their values (D9 changes
  only how the last one is *budgeted*, not its value).
- **No fix for F10** (D10) and **no fix for F9** (`getPlanSolveStatuses` fetching full jsonb just to
  read `requiredTier`). Both stay deferred S-04 findings.
- **No `plan_meals` payload field other than `share_with`**, and **no dish id in the client payload** —
  the client names slots, never dish uuids.
- **No island on `/plan`.** The grid stays a plain form (research Architecture Insight 7).
- **No change to `npm run test:seed`.** `supabase/tests/seed_integrity.sql` references no plan, dish,
  meal or solution shape, and this slice changes no seed content.

## Implementation Approach

Four phases, in dependency order, each independently verifiable:

1. **The coupled solver, pure.** Everything in `src/lib/services/macro-solver.ts`,
   `macro-solver.fixtures.ts`, `macro-solver.test.ts` and `src/types.ts`. No Supabase, no UI, no
   migration. Its exit criterion includes the CPU measurement that is the slice's top risk — cheap to
   run (`npm test` needs no secrets) and the one finding that could change the design.
2. **Schema and RPCs.** The migration, `npx supabase db push`, then the isolation test.
3. **Services, routes and pages.** Everything from `getMealPlan()` up to the two Astro pages.
4. **Smoke, docs and the full chain.**

The through-line is that **every generalisation must reduce exactly to today's behaviour for a
singleton group** — stated as an assertion in each phase, because that is what protects F1–F4 and the
six existing smoke assertions.

## Critical Implementation Details

**Statement-snapshot ordering in `save_meal_plan` step 4a.** The "has this slot's grouping changed?"
test reads the *existing* grouping of each meal (the set of slots sharing its `dish_id`). That must be
computed inside the **single** `delete` statement (a CTE or a correlated subquery over
`public.plan_meals`), never by deleting iteratively in a loop: a partial delete would change the
groupings the remaining iterations compare against. Postgres evaluates the whole statement against
one snapshot, which is exactly the behaviour this relies on.

**The post-4a invariant the insert step depends on.** Because the grouping comparison is symmetric
(every member of a changed group sees `existing ≠ desired`), after 4a every desired group is either
**all** present or **all** absent. Step 4c therefore inserts one dish + one meal per member *only
when no member of the group has a row*, which is what keeps unchanged slots' meal and dish ids — and
so keeps S-04 solves on untouched days alive.

**Do not put `plan_dishes.id` in the fingerprint.** Step 4c recreates dish rows on any recipe change,
so a fresh uuid would mark untouched days stale for no reason. The fingerprint uses a **canonical
grouping label derived from the dish's sorted member slot ranks** — stable across re-saves, and
different exactly when the grouping differs.

**Ordering within the migration.** `save_meal_plan` is changed with `create or replace` so its
privileges survive and the isolation test's exact-signature assertion at
`supabase/tests/household_isolation.sql:1355` stays valid. `save_day_solution` is **dropped**, which
resets Supabase's default `execute to public` for its replacement — so the new function needs its own
`revoke execute … from public, anon` followed by `grant execute … to authenticated`, and the
isolation test's grant block (`:1392-1397`) and anon probe (`:1113-1125`) must move in the same
change or they *error* rather than fail cleanly.

---

## Phase 1: The coupled solver (pure)

### Overview

Generalise `macro-solver.ts` from "one day" to "one solve group", close the fingerprint hole, and
prove with vitest that a singleton group is byte-identical to today and that the coupled worst case
fits the CPU budget.

### Changes Required

#### 1. Solver-facing types

**File**: `src/types.ts`

**Intent**: Give the app a dish identity and a share reference, and grow the stored solution shape
additively so pre-S-08 rows keep parsing (D4).

**Contract**:
- **`shareWith` is write-side only.** New `PlanMealInput = PlanMeal & { shareWith: { dayIndex:
  PlanDayIndex; mealType: MealType } | null }`, used by `/api/plan`'s build loop and `saveMealPlan()`.
  It must **not** go on `PlanMeal`: `PlanMealRecord extends PlanMeal` (`src/types.ts:124`), and
  `getMealPlan()` has no `share_with` column to read (`src/lib/services/meal-plans.ts:117-129`), so a
  `shareWith` on the read type would be either always-`null` or a second source of truth for a fact
  `dishId` already carries — and every solver fixture record would have to carry a field the solver
  never reads. One source of truth per direction: `dishId` for reads, `shareWith` for writes. This
  mirrors `PlanEater`, which already exists only as a form-level type (`src/types.ts:111`).
- `PlanMealRecord` gains `dishId: string` (the `plan_dishes.id` the meal eats from) — and nothing else.
- New `DaySolutionBatch { dishId: string; cookDayIndex: PlanDayIndex; mealIds: string[] }`;
  `DaySolutionMeal` gains `batch: DaySolutionBatch | null` (null ⇒ cooked for this day alone).
- `DaySplitShare` gains `mealId: string | null` and `dayIndex: PlanDayIndex | null` — a batch feeding
  2 days × 2 people has four shares, and `userId` alone no longer identifies one.
- **The three new fields are nullable, never optional.** `daySolutionSchema` is annotated
  `z.ZodType<DaySolution>` (`src/lib/services/day-solutions.ts:94`), so a `.optional()` would yield
  `mealId?: string | undefined`, which is not assignable to a required field and fails `astro check`.
  Follow the repo's own precedent, `boundsViolated: z.boolean().default(false)` (`:152-153`): model
  each as `.nullable().default(null)`, which keeps the parsed output **required** and nullable. This is
  load-bearing beyond types — `SOLVER_VERSION` 2 → 3 makes every pre-S-08 row stale, and stale rows
  are still rendered (`src/pages/plan/day.astro:161`), so readers genuinely receive legacy shares with
  no `mealId`. The writer always populates all three; `null` means "legacy row".
- `DaySolveExplanation`'s `"recipe"` variant gains `sharedAcrossDays: boolean` (D7).
- `DaySolution` keeps `version: 1`. Document on `requiredTier` that it is the **group's** tier while
  `maxDeviationPct` is **this day's** worst (D5).
- New `SolveGroupResult = { kind: "solution"; days: { dayIndex: PlanDayIndex; solution: DaySolution }[] }
  | ({ kind: "unsolvable" } & UnsolvableReason)`.
- `DayView` gains `groupDayIndexes: PlanDayIndex[]` and
  `groupStored: Partial<Record<PlanDayIndex, StoredDaySolution>>`; `fingerprint` becomes the
  **group's** fingerprint and `stored` stays the viewed day's row.

#### 2. Grouping, as pure exported logic

**File**: `src/lib/services/macro-solver.ts`

**Intent**: Make "which days solve together" a pure, unit-testable function that both the solver and
`day-solutions.ts` call, so the partition is computed once and identically everywhere.

**Contract**: `export function solveGroups(meals: readonly PlanMealRecord[]): PlanMealRecord[][]` —
groups meals by `dishId`, then merges any two dish-groups that share a `dayIndex`, returning the
connected components sorted by their lowest `slotRank`, each component's meals sorted by `slotRank`
then `mealId` (the existing `sortMeals` order). Also
`export function groupDayIndexes(group: readonly PlanMealRecord[]): PlanDayIndex[]` (ascending,
deduplicated) and `export function cookDayIndex(dishMeals: readonly PlanMealRecord[]): PlanDayIndex`
— the **lowest** `dayIndex` among a dish's meals, which is stable under re-solve, needs no new column
and matches the cook-ahead intent S-10 will schedule against.

#### 3. `CompState`: from one meal to one dish with N servings

**File**: `src/lib/services/macro-solver.ts`

**Intent**: Replace the hard-wired two-share model — the one genuine piece of solver surgery.

**Contract**:
- `CompState.mealIndex: number` → `dishIndex: number` plus
  `servings: { mealIndex: number; userId: string }[]`, ordered by `(slotRank of the meal, userId)`.
- `people` (the `per_person` mode matrix) is indexed by **serving**, not by eater.
- `split: number` → `splitUnits: number[]` of length `servings.length − 1`: integer units for every
  serving but the last, which takes the **exact remainder**. This is P7's existing remainder rule
  (`context/archive/2026-10-09-solve-daily-macros/plan.md:77-85`) generalised; for two servings it
  is literally today's scalar.
- `fractions(cs)` returns one fraction per serving — `splitUnits[i] / total` for the first n−1 and
  `1 − Σ` for the last — and keeps returning `null` when any value is negative or the sum exceeds the
  total, which is what `evaluate()` already treats as a rejected candidate.
- `isPerPersonComponent()` rounding generalises to per-**serving** (per `(day, person)`), which is
  physically correct: bread is sliced per meal.
- The ratio-bound grouping test at the current `:488` (`csB.mealIndex !== csA.mealIndex`) becomes
  `csB.dishIndex !== csA.dishIndex`, and the violation is summed over **serving indices** rather than
  eater indices. Valid because every component of a dish has the identical serving list.

#### 4. The LP: a reindex, not a reformulation

**File**: `src/lib/services/macro-solver.ts`

**Intent**: Give each day of the group its own per-person totals constraint while keeping one minimax
`t` for the group, so each day independently aims at its own targets out of a shared supply.

**Contract**: the scale variable stays one per `(dish, component, serving)` — meals already carry
their day, so this is the same variable set as today, re-keyed. The totals/deviation constraints move
from `tot_{pi}_{m}` to `tot_{day}_{pi}_{m}` (and `tu_`/`tv_`, `u_`/`v_` likewise); the per-variable
bound `{ min: lowerScale, max: MAX_SCALE }` and the ratio bound keep their current form. One `t` for
the whole group. A singleton group produces a constraint set isomorphic to today's.

#### 5. Repair, its move set and the scorer

**File**: `src/lib/services/macro-solver.ts`

**Intent**: Extend the split moves from "±1 unit on a scalar" to "move one unit between two servings",
scale the budget with the group (D9), and re-key the scorer so it judges **daily** totals.

**Contract**: `candidateMoves()` keeps its fixed P8 order (batch ingredient amounts, then splits, then
per-person amounts). The split block enumerates ordered pairs `(i, j)`, `i ≠ j`, in lexicographic
index order: move one unit out of serving `i` into serving `j`, where the last serving absorbs or
releases via the remainder. With at most 6 servings that is ≤ 30 moves per state — bounded and
deterministic — and for two servings it reduces to today's ±1. `repair()`'s cap becomes
`MAX_REPAIR_MOVES * dayCount`. `roundingWindow()` is untouched, so repair still cannot rewrite a
recipe's proportions to beat the LP.

**The scorer must be keyed by `(day, person)`, not by person.** `evaluate()` (`:450-506`) accumulates
into `totals: Map<string, MacroTotals>` keyed by **userId only** and scores
`deviationsFor(totals[person], targets[person])`. Left that way, a 2-day group sums both days' intake
for one person against a **single** day's target: `max` lands near 1.0, `tierFor()` returns null and
**every** shared group reports "no fit". So:

- `Evaluation.totals` is keyed by `(dayIndex, userId)`. No new input is needed — `CompState.servings`
  carries the meal index and `DayMeal` already carries `meal.dayIndex`.
- `deviationsFor()` is applied per (day, person): that day's totals against that person's targets.
- `max` and `sum` are taken over **every** (day, person) pair. `sum` stays the plain, un-normalised
  sum of absolute deviations — the L1 tie-break in `improves()` keeps its current meaning, just over
  more entries — and `violation` stays global.
- `improves()` (`:508-517`) and `repair()` (`:562-586`) therefore minimise the same minimax objective
  the LP optimises, which is what makes the Testing Strategy's "rounded worst deviation not
  meaningfully below the LP optimum" a like-for-like comparison against the group's single `t`.
- `solveDayWithDiagnostics` (`:740-757`) reads `evaluation.totals` per `(dayIndex, userId)` to build
  each day's `people[]`, and its `worstDeviation` diagnostic becomes the worst over (day, person).
- **Singleton reduction**: one day ⇒ the map holds exactly one entry per person ⇒ byte-identical to
  today.

#### 6. Result building

**File**: `src/lib/services/macro-solver.ts`

**Intent**: Emit one `DaySolution` per day of the group, each self-describing.

**Contract**: `buildSplit()` emits one share per serving, each carrying `userId`, `mealId` and
`dayIndex`; `kind: "all"` now means `servings.length === 1`. The two-share concepts generalise
explicitly: `evenSplit` (`:624`, today `Math.abs(values[0] - values[1]) < splitUnit`) becomes "the
spread between the largest and smallest serving is below `splitUnit`", and the
`SPLIT_LABELS.splitInHalf` label is emitted **only when `servings.length === 2`** — a 4-serving batch
must never render "· split in half". For more than two even servings the label names the count
(a new entry in `src/lib/recipe-labels.ts`, the map S-14 localises). For each day of the group, `meals[]`
contains that day's meal rows, each with the **full** component data of its dish (so both days'
rows are consistent by construction) and `batch` set when the dish has meals on more than one day.
`people[]` holds that day's own totals and deviations; `maxDeviationPct` is that day's worst;
`requiredTier` is the group's worst tier, identical on every day of the group (D5).

#### 7. The no-fit explanation

**File**: `src/lib/services/macro-solver.ts`

**Intent**: Blame a batch, not a meal, and compute it once per group (D6).

**Contract**: `explain()` iterates **dishes**, removing all of a dish's meals together, and is
invoked once for the group (still only when `requiredTier === null`, as at the current `:766`). The
same explanation object is stored on every day of the group, with `sharedAcrossDays: true` when the
blamed dish spans more than one day.

#### 8. The fingerprint

**File**: `src/lib/services/macro-solver.ts`

**Intent**: Close the silent-correctness hole — today, toggling "share this batch" changes **no**
fingerprint input, so a pre-toggle solve reads as current.

**Contract**: rename `dayFingerprint` → `solveFingerprint` (one unit of work, now a group). `SOLVER_VERSION`
goes `2 → 3`. The per-meal tuple becomes
`[mealId, dayIndex, mealType, recipeId, eaterUserId, groupLabel]`, where `groupLabel` is the dish's
member **slot ranks** (`dayIndex * 5 + mealTypeIndex`) sorted ascending and joined by `","` — never
the `plan_dishes.id` uuid, which step 4c regenerates on any recipe change. The recipe tuple also gains
`recipe.name`, each `component.name` and each `ingredient.productName` (D11). Every day of a group
stores this one group fingerprint, which is what makes cross-day staleness work for free.

#### 9. Entry points

**File**: `src/lib/services/macro-solver.ts`

**Intent**: Add the group entry point and keep `solveDay` as the singleton wrapper, so the existing
call sites and the whole F1–F4 suite keep compiling and keep acting as the regression net.

**Contract**: `export function solveGroup(input: SolveDayInput): SolveGroupResult` where
`input.meals` is the group's meals across its days. `solveDay(input)` delegates to `solveGroup` and
returns the single day's solution; `solveDayWithDiagnostics` likewise, keeping `lpOptimum`,
`worstDeviation` and `boundsViolation` for the unit tests. `checkSolvable()` is unchanged except that
it now runs over the group's meals.

#### 10. Cross-day fixtures

**File**: `src/lib/services/macro-solver.fixtures.ts`

**Intent**: Let a fixture express two days, which `day()` cannot today — it hard-codes
`dayIndex: 0 as const` and derives `mealId` from the slot alone, so two days' breakfasts would
**collide on meal id**.

**Contract**: `day(recipes, eaters?, dayIndex: PlanDayIndex = 0)` folds `dayIndex` into the generated
`mealId` and sets it on every record; defaulting to 0 keeps F1–F4's expansions byte-identical. Every
record gains a `dishId`, distinct per meal. Sharing is expressed as a **post-step over the
concatenated days**, not a `day()` parameter — `day()` is per-day and therefore cannot name a slot on
another day at all: `shareDish(meals, slotA, slotB)` rewrites both records' `dishId` to one value
(each slot given as `(dayIndex, mealType)`). That keeps F5/F6 buildable from unmodified `day()` calls
and leaves `shareWith` — a write-side concept the solver never reads (§1) — out of the fixtures
entirely. Add:
- `F5` — F1 on day 0 and F1 on day 1 with **lunch (curry) shared**: the canonical A3 case.
- `F6` — the all-whole-dish F2 on days 0, 1 and 2 with **two dishes shared** (so all three days are
  one group), as the worst-case no-fit group for the performance budget.

#### 11. Unit tests

**File**: `src/lib/services/macro-solver.test.ts`

**Intent**: Prove the singleton reduction, the cross-day behaviour, the fingerprint fix and the CPU
budget.

**Contract**: the `{ F1, F2, F3, F4 }` loops in `determinism`, `invariants` and `rounding` extend to
`{ …, F5 }` for free, because `input()` / `solved()` / `shuffledInput()` are parameterised on `meals`
only. Two mechanical edits are required and are the ones most likely to be missed:
- the four `find()`s that assume one meal per recipe per day (`:104`, `:142`, `:148`, `:158`, plus
  `baseOf()` at `:71-74`) must key on `mealId`;
- the `invariants` totals check at `:261-280` does
  `component.split.shares.find((s) => s.userId === person.userId)`, which picks the **wrong** share
  once a component has two shares for the same person on different days — it must match on
  `(userId, mealId)`.

New assertions:
- F1–F4 keep their exact current expectations, including the F2 blame object at `:86-92` (now with
  `sharedAcrossDays: false`) and `toStrictEqual` on shuffled input at `:117`.
- `solveGroups()` on an unshared day returns one group per day; on F5 returns one group of days 0–1.
- F5 solves with `expect([10, 15]).toContain(solution.requiredTier)` — the same pattern F3 already
  uses at `:95-99` for a tier that is a property of the LP — and **both** days carry the identical
  `requiredTier`, `explanation` and `batch.dishId` for the shared lunch.
- F5's shared lunch appears in both days' `meals[]` with equal `amountG` on every ingredient, four
  `split.shares`, and `batch.cookDayIndex === 0`.
- The fingerprint **changes** when only the grouping changes (F5 vs. the same meals unshared) and is
  **equal** for both days of a group; it stays `/^[0-9a-f]{64}$/`.
- A new, separate `performance` test for F6, with its own budget — do **not** loosen the existing
  1-second budget at `:412`. This test is a **regression guard on dev/CI hardware, not the edge CPU
  gate**: the real constraint is a Cloudflare Workers CPU limit, which only workerd can measure, so
  that measurement moves to Phase 4 §3. Budget, derived from the plan's own arithmetic in
  **Performance Considerations** (~3× LP × ~3× states × ~3× move budget for the repair search, plus
  several-fold `explain()` growth): a coupled 3-day no-fit solve costs at most **60×** a single-day
  F2 solve measured in the same run. The relative budget is the gate; record the first measured
  absolute value in this bullet as a comment and set the absolute assertion to **3× that recorded
  value**, so it catches a blow-up without being a second copy of the ratio (at today's ~10 ms per F2
  solve, a 250 ms absolute budget and 25× are the *same* number, which is why the original pairing
  was vacuous as well as too tight).

### Success Criteria

#### Automated Verification

- Type check passes: `npx astro check`
- Lint passes: `npm run lint`
- Unit tests pass, F1–F4 expectations unchanged: `npm test`
- The F6 coupled-worst-case regression guard passes its relative (≤ 60×) budget and the absolute
  budget pinned from its first measured value: `npm test`

#### Manual Verification

- Read the F5 diff: confirm the shared lunch's `amountG` values are identical in both days'
  `meals[]` and that `split.shares` has four entries with distinct `(mealId, userId)` pairs.
- If the F6 budget fails, climb the pre-committed ladder in **Performance Considerations** in order
  and stop at the first rung that passes: (3) memoise `componentBatchMacros()` / `baseMass()` per
  component for the whole solve and make `evaluate()` incremental (recompute only the changed state's
  contribution) — both pure performance changes, proven behaviour-neutral by F1–F4's `toStrictEqual`
  assertions; then (4) skip `explain()` for multi-day groups and store `explanation: null`, adjusting
  the F5/F6 explanation assertions accordingly. No rung caps group size or changes a quantity.

**Implementation Note**: after this phase and all automated verification passes, pause for manual
confirmation before Phase 2. This phase is the one that can still change the design.

---

## Phase 2: Schema and the two RPCs

### Overview

Drop the 1:1 constraint, teach `save_meal_plan` to produce and diff shared dishes, replace
`save_day_solution` with an atomic group writer, and move every isolation-test assertion the change
touches.

### Changes Required

#### 1. The migration

**File**: `supabase/migrations/20261011120000_shared_dishes.sql`

**Intent**: The whole database side of S-08 in one migration, with no data migration.

**Contract**, in order:

1. `alter table public.plan_meals drop constraint plan_meals_dish_id_key;`
2. `create index plan_meals_dish_plan_idx on public.plan_meals (dish_id, plan_id);` — the dropped
   unique index was the sole index with `dish_id` leading and served both the `on delete cascade`
   from `plan_dishes` and step 4d's `not exists` probe.
3. `create or replace function public.save_meal_plan(date, jsonb)` — **replace**, not drop, so the
   existing grants and the isolation test's exact-signature assertion survive.
4. `drop function public.save_day_solution(date, int, text, int, text, jsonb);`
5. `create function public.save_plan_day_solutions(date, jsonb)` + its `revoke`/`grant`/`comment`.
6. Updated `comment on table` for `plan_meals` and `plan_dishes`, and a header documenting the new
   SQLSTATEs and the rollback.

New SQLSTATEs in class `KD` (KD001–KD014 claimed, KD006 retired):
- **KD015** — `share_with` is present but malformed: not a string of the form
  `<0-2>_<meal_type label>`, or it names the element's own slot.
- **KD016** — `share_with` names a slot that is not in the payload.
- **KD017** — `share_with` names a slot holding a **different** `recipe_id`.

#### 2. `save_meal_plan`: payload, validation, grouping

**File**: `supabase/migrations/20261011120000_shared_dishes.sql`

**Intent**: Accept a grouping key, validate it in the RPC (route checks are UX; this is the
guarantee), and resolve it into exactly one dish per group.

**Contract**: the payload element becomes
`{ day_index, meal_type, recipe_id, eater_user_id, share_with? }`. `share_with` is **optional** —
absent or JSON `null` means a fresh batch — so the existing four-key presence check at the current
`:217-221` is unchanged and an older client keeps working. When present it must be a JSON string
matching `^[0-2]_` + one of `enum_range(null::public.meal_type)`; everything is read as text and
checked before any cast, exactly as the existing validator does, so a bad value raises KD015 rather
than a bare `22P02`.

Grouping is resolved **after** the existing KD010/KD011/KD012 checks and **before** any write:
build the edge list from the resolved `share_with` indexes, then union-find over it. Cycles need no
special handling — a mutual pair simply unions into one group. Transitivity of the KD017 equality
check guarantees every member of a group holds the same `recipe_id`. Each group becomes exactly one
`plan_dishes` row.

#### 3. `save_meal_plan`: the diff

**File**: `supabase/migrations/20261011120000_shared_dishes.sql`

**Intent**: Make the slot-level diff dish-identity aware, so a change in grouping alone is noticed —
today it is not, since step 4a keys on `(day_index, meal_type, recipe_id)` only.

**Contract**:
- **4a** deletes a meal when its slot is absent from the payload, **or** its dish's `recipe_id`
  differs, **or** its *existing grouping* differs from the desired one. Existing grouping = the
  sorted set of `(day_index, meal_type)` of all meals sharing that meal's `dish_id`, computed in a
  subquery **inside the one delete statement** (see **Critical Implementation Details**).
- **4b** (eater-only update, keeps the meal id) is unchanged — slot-keyed and dish-agnostic.
- **4c** iterates **groups**, not slots: when no member slot of a group has a surviving meal row,
  insert one `plan_dishes` row and one `plan_meals` row per member. The post-4a invariant makes
  "no member has a row" equivalent to "the whole group is new or changed".
- **4d** (delete dishes no meal eats from, by `not exists`) is unchanged and **stays last** — that
  ordering was chosen in S-03 for this slice
  (`context/archive/2026-10-08-plan-three-day-grid/plan.md:75`).

#### 4. `save_plan_day_solutions`: the atomic group writer

**File**: `supabase/migrations/20261011120000_shared_dishes.sql`

**Intent**: Write a whole group's days in one statement, so a group can never be half-solved (D2).

**Contract**: `public.save_plan_day_solutions(p_start_date date, p_solutions jsonb) returns uuid`
(the plan id), `security definer`, `set search_path = ''`, every name fully qualified, followed by
`revoke execute … from public, anon;` then `grant execute … to authenticated;`.

`p_solutions` is a jsonb array of 1–3 objects
`{ day_index, status, accepted_tolerance_pct, input_fingerprint, result }` with distinct `day_index`.
Validation reuses **KD013** (malformed argument) with the same per-field rules as today, including
`octet_length(result::text) > 65536` **per element**, plus array-shape and distinctness checks; and
**KD014** (the caller's household has no plan for `p_start_date`). KD007 is reused for no
caller/household. The upsert is a single
`insert … select from jsonb_to_recordset(…) … on conflict (plan_id, day_index) do update …` — the
distinct-`day_index` check is what makes that conflict target safe.

#### 5. Isolation test: fixtures and counts

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Encode the new cardinality in the fixtures, and pin the shared path.

**Contract**:
- The fixture comment at `:151-153` ("`plan_meals_dish_id_key` allows one meal per dish, so A's two
  meals need two dishes") becomes wrong. Replace it and add a **shared-dish fixture**: one dish, two
  meals on different days of A's plan.
- The exact read counts at `:551-563` (`plan_dishes` = 2, `plan_meals` = 2) and the dish count at
  `:2113-2116` move with the new fixture.
- Add the mirror of the "a meal cannot eat from a dish of another plan" probe (`:207-213`, which
  stays valid and is the proof A1 still holds): an insert proving **same-plan, different-day**
  sharing is now allowed — the direct regression guard for the dropped constraint.

#### 6. Isolation test: the write-revoke probe

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Refresh a stale comment — the probe itself stays exactly as it is.

**Contract**: keep the probe at `:596-604` unchanged. It already inserts into a free slot `(2, dinner)`
with an existing dish, and its trailing `raise exception` is uncaught by the
`when insufficient_privilege` handler, so a regressed revoke still fails loudly as `P0001`. Replace
only the comment at `:597-598`: the dropped constraint no longer precedes the privilege check, so the
probe now rests on the revoke alone. While re-pinning the §5 fixtures, confirm the new shared-dish
fixture does **not** occupy `(2, dinner)` on A's plan — that is the slot this probe relies on being
free.

#### 7. Isolation test: the RPC blocks

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Follow the function rename and pin the new validation, which would otherwise be silently
droppable (the payload validator only checks key *presence*).

**Contract**:
- Every *"expected 2 dishes"* assertion in `:634-733` is re-pinned, plus new sub-cases for the shared
  path: **create** a shared dish (2 meals, 1 dish), **regroup** (split a shared dish apart → 2 dishes,
  meal ids replaced), **merge** two separate dishes into one (→ 1 dish), and **orphan cleanup** after
  regrouping.
- The **create** case doubles as the `share_with` **round-trip** pin: a payload whose `share_with`
  names the *other* slot yields exactly one `plan_dishes` row shared by both `plan_meals` rows. The
  route's regex cannot catch a correctly-formatted wrong slot, so this is the only assertion that
  proves the target slot — not the element's own slot — reaches the RPC (Phase 3 §1).
- The rejection table at `:735-786` gains one row each for **KD015**, **KD016** and **KD017**.
- The anon-executability probe at `:1113-1125` and the grant block at `:1361-1399` move from
  `save_day_solution(date, int, text, int, text, jsonb)` to
  `save_plan_day_solutions(date, jsonb)` — by **exact signature string**, so leaving the old name
  makes the assertion *error* rather than fail cleanly.
- The S-04 RPC behaviour block at `:788` onward is rewritten against the new function: a group write
  of two days in one call, and a second call updating both rows in place.
- The closing summary strings at `:2147` and `:2151` are updated, as every slice does.

### Success Criteria

#### Automated Verification

- The migration applies to the hosted project: `npx supabase db push`
- Every migration file is recorded as applied: `npm run check:migrations`
- Household isolation passes, including the new shared-dish fixtures, the regrouping diff cases and
  KD015/KD016/KD017: `npm run test:rls`
- Seed integrity is untouched: `npm run test:seed`

#### Manual Verification

- `npx supabase db query --linked` confirms `plan_meals_dish_id_key` is gone and
  `plan_meals_dish_plan_idx` exists.
- `npx supabase db query --linked` confirms `public.save_day_solution` no longer exists and that
  `anon` holds no `execute` on `public.save_plan_day_solutions`.
- A hand-built `save_meal_plan` call with a `share_with` naming a slot of a different recipe is
  rejected with KD017, not with a generic KD010.

**Implementation Note**: **phases 2–4 are completed and merged in one working block** — do not leave
Phase 2 overnight for review. Criterion 2.1 applies this migration to the **hosted** project (there is
no other), so from that moment the already-deployed Worker — which still calls the dropped
`save_day_solution` (`src/lib/services/day-solutions.ts:211`) — fails every solve, caught by
`/api/plan/solve` as the "Macros could not be solved right now" redirect
(`src/pages/api/plan/solve.ts:130-133`). Plan reads and the `/plan` grid are unaffected; the window
closes when `main` deploys. See **Migration Notes → Deploy order**.

---

## Phase 3: Services, routes and pages

### Overview

Carry the dish identity up through the read path, make the solve group the app's unit of work, and
give the user the affordance and the explanation.

### Changes Required

#### 1. Plan reads and writes

**File**: `src/lib/services/meal-plans.ts`

**Intent**: Stop projecting the dish id away, and carry the share reference down into the RPC.

**Contract**: the select at `:96-97` adds `id` to the `plan_dishes!plan_meals_dish_fkey(...)` embed;
`MealPlanRow.plan_dishes` becomes `{ id: string; recipe_id: string } | null`, and the flatten at
`:117-129` sets `dishId`. **Re-verify the embed's shape after the unique constraint is dropped**:
PostgREST infers to-one vs to-many partly from uniqueness on the FK columns, and without a generated
`Database` type the client guesses every embed is an array (the caveat is already noted at
`:110-111`). `saveMealPlan()` takes `PlanMealInput[]` (Phase 1 §1) and its payload at `:143-148` gains
the **target** slot's coordinates, not the current slot's:

```ts
share_with: meal.shareWith ? `${meal.shareWith.dayIndex}_${meal.shareWith.mealType}` : null,
```

Inside that map there is no bare `dayIndex` / `mealType` in scope, and the current element's own
coordinates would make every shared slot self-reference — which KD015 is specified to reject, so no
share could ever be saved. Because a correctly-formatted *wrong* slot is invisible to the route's
regex, Phase 2 §7 adds a round-trip case (two meals, one dish) that pins the saved share.
`PLAN_ERRORS` gains KD015, KD016 and KD017 with their own messages, so the UI can say which rule was
broken.

#### 2. Group-aware solve service

**File**: `src/lib/services/day-solutions.ts`

**Intent**: Replace the two per-day filters with a group partition — the single chokepoint that makes
a solve single-day.

**Contract**:
- `loadDaySolveInputs()` becomes `loadGroupSolveInputs(supabase, startDate, dayIndex)`, returning the
  plan plus the `SolveDayInput` whose `meals` are **the group containing `dayIndex`** (via
  `solveGroups()`), replacing the filter at `:42`. No new database read is needed — `loadSharedInputs`
  already loads targets and recipes for the recipe ids it is handed.
- `getDayView()` computes the group's `solveFingerprint`, reads **every** group day's stored row, and
  sets `stale` by comparing the viewed day's stored fingerprint to the group's. Cross-day staleness
  then works for free. It also fills `groupDayIndexes` and `groupStored`.
- `saveDaySolution()` becomes `savePlanDaySolutions(supabase, startDate, solutions[])`, calling the
  new RPC once.
- `getPlanSolveStatuses()` partitions `plan.meals` with `solveGroups()` (replacing the filter at
  `:279`), fingerprints **once per group**, and gives every day of a group the group's status.
  `PlanDaySolveStatus` gains `groupDayIndexes: PlanDayIndex[]`, `isGroupLead: boolean` (the group's
  **lowest** day) and `groupMaxMealCount: number` — **the most meals any single day of the group
  holds**.
- `needsSolvePrompt()` becomes `status.isGroupLead && status.groupMaxMealCount === MEAL_TYPES.length
  && (status.kind === "unsolved" || status.kind === "stale")`, so a group prompts **once**, on its
  lowest day, instead of two or three times for one solve. For a singleton group
  `groupMaxMealCount === mealCount` and `isGroupLead` is true, so this is exactly today's rule.
- **The prompt sentence must be group-aware.** `formatSolvePrompt(weekday)` →
  `` `${weekday} has all 5 meals. Solve its macros?` `` (`:332-334`) is false for a group whose lead
  day holds 3 meals and whose partner day holds 5 — which the `groupMaxMealCount` rule deliberately
  still prompts for — and "its macros" is wrong for any group. Add
  `formatGroupSolvePrompt(weekdays)` beside it (e.g. *"Monday and Tuesday share a batch and have all
  5 meals. Solve them together?"*) and use it when `groupDayIndexes.length > 1`. Leave
  `formatSolvePrompt()` **untouched** for singletons, so the existing smoke assertion stays
  byte-identical. *Rejected:* requiring every day of the group to be full — FR-018's prompt would
  then vanish for exactly the mixed plans a cook-ahead batch produces.
- `daySolutionSchema` grows **nullable-with-default, never optional** (Phase 1 §1): `meals[].batch`
  as `.nullable().default(null)`, `split.shares[].mealId` / `.dayIndex` likewise, and
  `explanation.sharedAcrossDays: z.boolean().default(false)`. `.optional()` would break the
  `z.ZodType<DaySolution>` annotation at `:94`; `.default()` keeps the output required, exactly as
  `boundsViolated` does at `:152-153`. `version` stays `z.literal(1)`, so pre-S-08 rows keep parsing
  and read as *"Out of date"* rather than *"Not solved"*.
- `DAY_SOLVE_STALE` is widened — it currently names only "the plan, targets or recipes", which does
  not cover "the day that shares this batch changed".
- New sentences, all here (never in a page): the cook-day note (*"Cook the whole batch today — set
  aside … for \<weekday\>"*), the other-day note (*"From \<weekday\>'s batch"*), the group-solve
  note (*"Solving this day also re-solves \<weekday\>"*), and the `/plan` card's group line.
  `formatDaySolveSummary()` appends a shared-batch clause to the no-fit sentence when
  `explanation.sharedAcrossDays` is true; the unshared sentence pinned at `scripts/smoke.mjs:689` is
  unchanged.
- `formatSplitLine()` takes an optional `(dayIndex) => weekday` resolver and the viewed day, and
  suffixes a share's label with its weekday **only when `share.dayIndex !== null && share.dayIndex
  !== viewedDay`**. For a singleton group every share is on the viewed day, and for a legacy
  (pre-S-08) row every `dayIndex` is `null`, so both render byte-identically to today.
- Any new enum-keyed label goes in `src/lib/recipe-labels.ts` — the single map S-14 localises.

#### 3. The plan save route

**File**: `src/pages/api/plan.ts`

**Intent**: Accept the new field and reject an impossible share before the RPC does, with a clearer
message.

**Contract**: the generated `slotFields` loop at `:23-31` gains
`d{day}_{mealType}_batch`, a `z.union([z.literal(""), z.string().regex(/^[0-2]_(…meal types…)$/)])`
with `.default("")`. The regex alternation is built from `MEAL_TYPES`, so it cannot drift. Because the
route reads only known keys (`form.get(key) ?? undefined`, `:63`), a field absent from `slotFields`
never arrives — and because a missing recipe field already means "empty slot", *adding* fields is
backward compatible. The build loop at `:90-111` now builds `PlanMealInput` (Phase 1 §1) rather than
`PlanMeal`, sets `shareWith` and rejects, with its own message
in the `PARTNER_NOT_LINKED` style: a self-reference, a reference to an empty slot, or a reference to a
slot holding a different recipe. These are UX; the RPC's KD015–KD017 remain the guarantee.

#### 4. The solve route

**File**: `src/pages/api/plan/solve.ts`

**Intent**: Solve and store the whole group, and make an acceptance group-wide.

**Contract**: the posted schema at `:21-31` is unchanged — `day_index` still names *a* day, and the
route resolves its group. `solveDay` becomes `solveGroup`, and the single `saveDaySolution` call
becomes one `savePlanDaySolutions` call carrying every day of the group with the **same** status,
tolerance and fingerprint. The accept guard at `:105-107` now compares against the **group's**
fingerprint. "A plain Solve again keeps an earlier acceptance" (`:110-113`) generalises: reuse the
stored tolerance only when **every** group day has a stored row whose fingerprint equals the current
group fingerprint; otherwise 10.

#### 5. The grid

**File**: `src/pages/plan.astro`

**Intent**: The affordance, rendered canonically, with no island.

**Contract**: a third select per slot, `d{day}_{mealType}_batch`, with `value=""` labelled *"Cook a
fresh batch"* plus one option per **other slot**, grouped by day with `<optgroup>` and labelled
`"<Weekday> <Meal type>"`. A saved group is rendered in **canonical star form**: every member except
the group's lowest slot selects the lowest slot; the lowest selects `""`. That round-trips through
union-find and is stable across saves. Each member slot also renders
`<p data-testid="batch-{day}_{mealType}">` with the cook-day or from-batch note — a `<p>` deliberately,
because the smoke helpers `testIdText()` / `testIdBody()` match only `<p …>` elements
(`scripts/smoke.mjs:71-74`, `:112-114`) and a `data-testid` moved onto a `<span>` or `<div>` fails
silently. The per-day status cards gain `<p data-testid="day-group-{day}">` naming the days a group
covers. The solve forms stay **siblings after** the grid form and the solve-status read stays in its
own `try/catch` outside `canEdit` (forms cannot nest, and a failing solve read must never hide the
grid — FR-020, `src/pages/plan.astro:244-245`).

#### 6. The day page

**File**: `src/pages/plan/day.astro`

**Intent**: Make a shared batch legible instead of rendering two identical ingredient lists.

**Contract**: inside the flat meal loop at `:214-246`, a meal with `batch` renders
`<p data-testid="day-batch-{mealType}">` — on the cook day, the batch amounts plus *"set aside … for
\<weekday\>"*; on the other day, *"from \<weekday\>'s batch"*.

**The non-cook day must not repeat the batch ingredient list.** D4 stores the dish's full component
data on *both* days with the batch `amountG`, so the loop as it stands would render the whole batch
again on a day the user cooks nothing — "Ryż 900 g" on Wednesday. So the loop gains one branch: when
`batch !== null && batch.cookDayIndex !== viewedDay`, render the batch note and the viewer's **own
portion** and **skip the batch ingredient list**; the full list renders on the cook day only. This is
what delivers the Intent and FR-017's cook-ahead story — amounts appear on the day they are cooked.
(Whether the non-cook day should also show reheating grams is left to S-11; it shows the portion and
the note.) The stored jsonb is unchanged either way, so every downstream consumer is unaffected.

`formatSplitLine()` is called with the
weekday resolver so cross-day shares are labelled. The "Solve again" / "Accept" block renders the
group-solve note when `groupDayIndexes.length > 1`, so the user knows the button moves more than one
day. All rendering stays inline in the page — there is no `src/components/plan/`.

### Success Criteria

#### Automated Verification

- Type check passes: `npx astro check`
- Lint passes: `npm run lint`
- Unit tests still pass: `npm test`
- Production build succeeds: `npm run build`

#### Manual Verification

- On `npm run preview`: save a plan where day 0 and day 1 lunch share a batch; confirm the grid
  re-renders in canonical star form (day 1 selects day 0, day 0 selects "fresh") after the reload.
- Confirm only **one** solve prompt appears for the group, on day 0.
- Solve from day 1 and confirm both days show the same status, the same tier and the same solved-at.
- Change day 1's eater and confirm **both** days flip to "Out of date".
- Confirm the day pages show the set-aside note on day 0 and the from-batch note on day 1, that the
  batch ingredient list appears on day 0 **only**, and that day 1 shows the from-batch note plus the
  viewer's own portion and no batch amounts.
- Break the share deliberately (share with a slot holding another recipe via a hand-built POST) and
  confirm the KD017 message, not a generic failure.

**Implementation Note**: pause for manual confirmation before Phase 4.

---

## Phase 4: Smoke, documentation and the full chain

### Overview

Pin the slice's actual claim end to end over HTTP, and record the new invariants for the slices that
consume them.

### Changes Required

#### 1. The S-08 smoke section

**File**: `scripts/smoke.mjs`

**Intent**: Prove over HTTP what only an end-to-end run can prove — that it is **one** batch, that
**both** sharing days land in tolerance, and that editing one marks both stale.

**Contract**: a fresh fixture date `shareStart = "2031-01-20"`, so the S-03 (`2031-01-06`) and S-04
(`2031-01-13`) plans and their literal meal counts are untouched — the convention stated at
`scripts/smoke.mjs:135`. New steps, after the S-04 block:

1. A saves a plan mirroring Phase 1's F5 — the F1 mix on days 0 and 1 — with
   `d1_lunch_batch = "0_lunch"`; the new field name is thereby pinned.
2. `/plan` shows the batch note (`batch-1_lunch`) and **one** prompt for the group
   (`day-prompt-0` present, `day-prompt-1` absent), carrying the group sentence from
   `formatGroupSolvePrompt()` rather than the singleton one. Because both days of this fixture hold
   5 meals, add the **mixed group** case too: drop one of day 0's meals and re-check that the prompt
   still appears on day 0 and still reads as a group sentence — the case where the old
   `formatSolvePrompt()` would have claimed "all 5 meals" about a 4-meal day (Phase 3 §2).
3. A solves day 0; `day-status-0` and `day-status-1` are **byte-identical** and match
   `/^Solved within ±(10|15|20)%$/` — the slice's actual claim, asserted the way F5's unit test
   asserts it, since the exact tier is a property of the LP.
4. The day pages show `day-batch-lunch` on both days, and the batch's ingredient lines appear on
   **day 0 only** — day 1 carries the from-batch note and the viewer's portion, no batch amounts
   (Phase 3 §6). The "one batch, not two" proof is re-pointed at that asymmetry plus the batch note's
   amounts appearing on exactly one day; the equality of the stored amounts across both days is
   proven by F5's unit assertions, which read the jsonb directly.
5. B marks day 1's lunch for A only; **both** `day-status-0` and `day-status-1` read "Out of date" —
   the direct regression test for the fingerprint hole.
6. A re-saves with `d1_lunch_batch = ""`; the day 1 batch note is gone and both days are stale again.
7. A posts `d1_lunch_batch = "0_breakfast"` (a different recipe) and is redirected with the KD017
   message.
8. An `S08_TEST_IDS` array with **its own** debug loop in the failure block, following the comment at
   `:800-811`, so the shared id list stays untouched for parallel slices.

Brittleness to respect while writing these: `testIdText()` / `testIdBody()` match only `<p …>`
elements; `:525` and `:551` parse raw `<option …>` / `<select name=…>` markup; `:704` requires the
accept form's hidden input to keep `name="fingerprint"`. Note also that `day{n}_eater`
(`src/pages/api/plan.ts:93`, `:99`) is **never exercised by smoke**, so an S-08 regression there would
be invisible — step 1 should set one `day{n}_eater` to close that gap cheaply.

#### 2. Project rules

**File**: `CLAUDE.md`

**Intent**: Record the invariants the next slices depend on; S-09 and S-11 would otherwise
double-count a shared batch.

**Contract**: update the meal-plans bullet (`plan_meals_dish_id_key` is dropped; `save_meal_plan`
takes `share_with` and raises KD015/KD016/KD017), the S-04 bullet (`SOLVER_VERSION` is 3; the solve
unit is the group; `save_day_solution` is replaced by `save_plan_day_solutions`, which is now the
single write path for `plan_day_solutions`), and the write-revoked-tables hard rule's list of write
paths. Add an S-08 bullet stating: the solve group is the unit of work; every day of a group stores
the same fingerprint, status and tolerance; `requiredTier` is the group's and `maxDeviationPct` the
day's; and **downstream consumers deduplicate a shared batch by `meals[].batch.dishId`, counting each
`dishId` once across the plan, and never re-derive quantities**.

**File**: `README.md`

**Contract**: note the shared-batch field in the `/plan` route row and extend the smoke-test section
with the S-08 paragraph (one batch across two days, both days solved together, cross-day staleness).
The cleanup queries need no change: dishes and solutions already cascade with their plan and
household.

**File**: `context/changes/shared-dish-across-days/change.md`

**Contract**: `status: planned`, `updated: 2026-10-11`.

#### 3. The edge CPU measurement

**Intent**: Measure the constraint that actually exists — a Cloudflare Workers CPU limit — on the
runtime that enforces it, and close research Open Question 1 instead of restating it. Phase 1's vitest
budget is a regression guard on dev hardware and cannot see this (see **Performance Considerations**).

**Contract**: on `npm run preview`, which already serves the Cloudflare `workerd` runtime, save an
F6-shaped group (three days joined by two shared dishes, the all-whole-dish no-fit mix) and time one
`POST /api/plan/solve` against it. Record the elapsed figure in this section of the plan, noting that
it is an **upper bound** — it includes the Supabase round-trips — and that cold-isolate cost stays
unmeasured, as S-04 deferred it. Also record which Workers plan the account is on
(`npx wrangler whoami`, or the Cloudflare dashboard → Workers & Pages → the Worker's settings), since
the Free plan's limit is 10 ms CPU and the paid plans' is far higher: the recorded plan is what makes
the recorded figure interpretable. If the figure exceeds the account's limit, climb the mitigation
ladder in **Performance Considerations** from rung 3.

#### 4. The full verification chain

**Intent**: Run the mandated order, which CI cannot substitute for — `npm run test:rls` and
`npm run test:seed` run against the **already-deployed** schema, not the branch's migrations
(`.github/workflows/ci.yml:42`, `:46`), and CI has no database password, so it cannot `db push`.

**Contract**:
`npx supabase db push` → `npm run test:rls` → `npm run test:seed` → `npm test` → `npm run lint` →
`npx astro check` → `npm run build && npm run preview` → `BASE_URL=http://localhost:4321 npm run smoke`
→ push.

### Success Criteria

#### Automated Verification

- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Unit tests pass: `npm test`
- Isolation test passes: `npm run test:rls`
- Seed integrity passes: `npm run test:seed`
- Migrations are all applied: `npm run check:migrations`
- Build succeeds: `npm run build`
- The full smoke run passes, including the new S-08 section:
  `BASE_URL=http://localhost:4321 npm run smoke`

#### Manual Verification

- Clean up the smoke accounts with the README's two queries, running the second until it deletes
  0 rows.
- Read the CLAUDE.md diff and confirm the `batch.dishId` deduplication invariant is stated plainly
  enough that S-09 cannot miss it.
- The F6-shaped group's `POST /api/plan/solve` time on `npm run preview` (workerd) and the account's
  Workers plan are both recorded in Phase 4 §3.
- After the `main` deploy, a real solve on production succeeds — this is what closes the window the
  Phase 2 `db push` opens (see **Migration Notes → Deploy order**).

---

## Testing Strategy

### Unit tests (`npm test`, no secrets)

- **Singleton reduction** — F1–F4 keep their exact current expectations. This is the primary
  regression net for the whole solver surgery.
- **Grouping** — `solveGroups()` on unshared meals, on one shared pair, and on a transitive merge
  (dish A joins days 0–1, dish B joins days 1–2 ⇒ one group of three).
- **Cross-day solve (F5)** — both days in tolerance, identical `requiredTier`, identical ingredient
  amounts for the shared dish, four distinct `(mealId, userId)` shares, `batch.cookDayIndex === 0`.
- **Fingerprint** — changes on a grouping-only change; equal across a group's days; changes on a
  recipe rename (D11); still 64 lowercase hex.
- **Determinism** — shuffled input gives deep-equal output for F5 as it does for F1–F4.
- **Invariants on F5** — rounded worst deviation not meaningfully below the LP optimum; no hard bound
  violated; totals recomputed from the displayed amounts and shares match (with the
  `(userId, mealId)` share lookup fix).
- **Performance (F6)** — the coupled 3-day no-fit worst case, with its own budget, separate from the
  existing 1-second test.

### Integration tests (`npm run test:rls`, hosted project, rolled back)

Shared-dish fixtures and counts; same-plan different-day sharing allowed while cross-plan sharing
stays rejected; the four diff cases (create, regroup, merge, orphan cleanup), the first of which
doubles as the `share_with` round-trip pin; the write-revoke probe's refreshed comment (the probe
itself is unchanged); KD015/KD016/KD017; the new RPC's grants by exact signature plus its anon probe;
the household cascade.

### End-to-end (`npm run smoke`, against the production preview)

The eight S-08 steps above.

### Manual testing steps

1. `npm run build && npm run preview`, sign in with two linked accounts.
2. Save a plan with day 0 and day 1 lunch sharing a batch; reload and confirm the canonical star form.
3. Confirm exactly one solve prompt for the group.
4. Solve from day 1; confirm both days show the same tier and the same solved-at.
5. Open both day pages; confirm the set-aside and from-batch notes and identical shared amounts.
6. Edit day 1's eater; confirm both days flip to "Out of date".
7. Accept a looser tier from one day; confirm both days show it.
8. Un-share; confirm two dishes, two independent statuses.

## Performance Considerations

The coupled worst case multiplies three things at once: the LP (~3×, still trivial in absolute
terms — roughly 100 variables and 150 constraints, which `yalps` handles easily), the repair search
(~3× the states, ~3× the candidate moves per accepted move, plus O(servings²) split moves, and 3× the
move budget under D9), and leave-one-out (now per dish, so **fewer** re-solves than per meal, each on
the larger LP). The vitest budget today is *100 no-fit single-day solves under 1 s*
(`src/lib/services/macro-solver.test.ts:412`) — about 10 ms each, which is already at the Cloudflare
Workers **Free** plan's 10 ms CPU limit; `wrangler.jsonc` sets no limits block and the repository does
not record which plan the account is on. S-04 explicitly deferred measuring this on workerd
(`context/archive/2026-10-09-solve-daily-macros/reviews/impl-review.md:182`).

**Measurement is split from gating.** The vitest F6 test (Phase 1 §11) is a regression guard on
dev/CI hardware, budgeted at ≤ 60× an F2 solve to match the multiplication above. The decisive
measurement is Phase 4 §3: one timed POST to `/api/plan/solve` for an F6-shaped 3-day group on
`npm run preview` (which already serves the Cloudflare runtime), plus recording which Workers plan
the account is on — closing research Open Question 1 instead of restating it. That figure is an upper
bound (it includes Supabase round-trips), and cold-isolate cost stays unmeasured, as in S-04.

The design's mitigations, in the order they apply:

1. **Groups, not plans.** An unshared day keeps today's cost exactly, and A3's realistic case
   ("lunch for 2–3 days") is a 2-day group.
2. **Leave-one-dish-out, once per group** (D6), and `explain()` still runs only on the no-fit path.
3. If the F6 budget still fails: memoise `componentBatchMacros()` / `baseMass()` per component and
   make `evaluate()` incremental. Both are behaviour-neutral, which F1–F4's `toStrictEqual`
   assertions prove.
4. If rung 3 is applied and the budget **still** fails: skip `explain()` for multi-day groups and
   store `explanation: null`. `explain()` is the dominant cost (13 leave-one-dish-out LP re-solves for
   F6) and already runs only on the no-fit path (`src/lib/services/macro-solver.ts:766`);
   `explanation: null` is an existing supported state that `formatDaySolveSummary()` already handles
   by falling back to "No fit within ±20%" (`src/lib/services/day-solutions.ts:411-420`), so no reader
   changes and no deploy ordering. The cost: an unsolvable multi-day group loses the "Most obstructive
   recipe" sentence, and D7's `sharedAcrossDays` flag then only ever fires on a blamed single-day dish.
   This rung is pre-committed here so the implementer never has to improvise a scope decision
   mid-phase; nothing beyond it is in scope for this slice.

Rungs 1–3 are behaviour-neutral: they cannot change a single computed quantity, only the speed. Rung 4
degrades **only** the no-fit explanation text for multi-day groups — never an amount, a split, a tier
or a group size. Capping a group's day count (research's own fourth option) is **not** adopted: it
would cut the 3-day case the Desired End State and F6 are written around and make the user hit a wall.

## Migration Notes

- **No data migration.** No row is rewritten; the only DDL on existing data is a dropped constraint.
- **Every stored solve goes stale**, because `SOLVER_VERSION` moves 2 → 3. That is the documented
  one-line mechanism (`context/archive/2026-10-09-solve-daily-macros/plan.md:170`). Stale rows still
  render at `opacity-50` with "Solve again"; keeping `version: 1` is what prevents them reading as
  "Not solved" instead.
- **Rollback**: `drop function public.save_plan_day_solutions(date, jsonb);` then recreate
  `public.save_day_solution(date, int, text, int, text, jsonb)` from
  `20261009120000_plan_day_solutions.sql` with its revoke/grant pair; `create or replace
  public.save_meal_plan` from `20261008170000_meal_plans.sql`; delete every `plan_meals` row whose
  `dish_id` is shared (or re-point each to a fresh dish) before
  `alter table public.plan_meals add constraint plan_meals_dish_id_key unique (dish_id);` — the
  constraint cannot be restored while a shared dish exists.
- **Deploy order**: this is the first slice whose `db push` is a **breaking production change** — every
  prior migration was additive. There is one hosted Supabase project and CI cannot `db push`
  (no database password), so the migration necessarily reaches production before the branch merges.
  Between `npx supabase db push` (criterion 2.1) and the `main` deploy, production's **Solve** and
  **Accept** buttons fail gracefully with "Macros could not be solved right now"
  (`DAY_SOLVE_FAILED`); plan reads, the `/plan` grid, targets and recipe pages are unaffected. Keep
  the window short by completing and merging phases 2–4 in one working block, and verify a real solve
  against production after the deploy (Progress 4.11). *Rejected:* keeping `save_day_solution` as a
  deprecated wrapper — it would put two client-callable write paths into a write-revoked table,
  contradicting D2 and CLAUDE.md's one-write-path rule, plus a deferred cleanup that can be forgotten.

## References

- Research: `context/changes/shared-dish-across-days/research.md`
- Change identity: `context/changes/shared-dish-across-days/change.md`
- Roadmap entry: `context/foundation/roadmap.md:219-230`
- The S-08 hand-off recipe, verbatim: `supabase/migrations/20261008170000_meal_plans.sql:11-16`
- The 1:1 producer this slice rewrites: `supabase/migrations/20261008170000_meal_plans.sql:303-316`
- The fingerprint hole: `src/lib/services/macro-solver.ts:792-835`, tuple at `:800`
- The two-share split model: `src/lib/services/macro-solver.ts:387-393`
- The per-day filters: `src/lib/services/day-solutions.ts:42`, `:279`
- Prior art for additive jsonb growth: `src/lib/services/day-solutions.ts:152-153`
- S-03's design rationale: `context/archive/2026-10-08-plan-three-day-grid/research.md:70-78`
- S-04's solver plan: `context/archive/2026-10-09-solve-daily-macros/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not
> rename step titles. See `references/progress-format.md`.

### Phase 1: The coupled solver (pure)

#### Automated

- [x] 1.1 Type check passes: `npx astro check` — 7422277
- [x] 1.2 Lint passes: `npm run lint` — 7422277
- [x] 1.3 Unit tests pass, F1–F4 expectations unchanged: `npm test` — 7422277
- [x] 1.4 The F6 coupled-worst-case regression guard passes its relative (≤ 60×) budget and the absolute budget pinned from its first measured value — 7422277

#### Manual

- [ ] 1.5 F5's shared lunch has identical `amountG` on both days and four distinct `(mealId, userId)` shares
- [ ] 1.6 If the F6 budget failed, the pre-committed mitigation ladder was climbed in order (rung 3, then rung 4) and F1–F4 still pass

### Phase 2: Schema and the two RPCs

#### Automated

- [ ] 2.1 The migration applies to the hosted project: `npx supabase db push`
- [ ] 2.2 Every migration file is recorded as applied: `npm run check:migrations`
- [ ] 2.3 Household isolation passes, including shared-dish fixtures, regrouping and KD015–KD017: `npm run test:rls`
- [ ] 2.4 Seed integrity is untouched: `npm run test:seed`

#### Manual

- [ ] 2.5 `plan_meals_dish_id_key` is gone and `plan_meals_dish_plan_idx` exists
- [ ] 2.6 `public.save_day_solution` no longer exists and `anon` holds no execute on `save_plan_day_solutions`
- [ ] 2.7 A `share_with` naming a slot of a different recipe is rejected with KD017

### Phase 3: Services, routes and pages

#### Automated

- [ ] 3.1 Type check passes: `npx astro check`
- [ ] 3.2 Lint passes: `npm run lint`
- [ ] 3.3 Unit tests still pass: `npm test`
- [ ] 3.4 Production build succeeds: `npm run build`

#### Manual

- [ ] 3.5 A saved shared batch re-renders in canonical star form
- [ ] 3.6 A group shows exactly one solve prompt, on its lowest day
- [ ] 3.7 Solving from either day gives both days the same status, tier and solved-at
- [ ] 3.8 Editing one sharing day flips both days to "Out of date"
- [ ] 3.9 The set-aside and from-batch notes render, with the batch ingredient list on the cook day only
- [ ] 3.10 A share naming a slot of a different recipe shows the KD017 message

### Phase 4: Smoke, documentation and the full chain

#### Automated

- [ ] 4.1 Lint passes: `npm run lint`
- [ ] 4.2 Type check passes: `npx astro check`
- [ ] 4.3 Unit tests pass: `npm test`
- [ ] 4.4 Isolation test passes: `npm run test:rls`
- [ ] 4.5 Seed integrity passes: `npm run test:seed`
- [ ] 4.6 Migrations are all applied: `npm run check:migrations`
- [ ] 4.7 Build succeeds: `npm run build`
- [ ] 4.8 The full smoke run passes, including the new S-08 section: `npm run smoke`

#### Manual

- [ ] 4.9 Smoke accounts and households cleaned up with the README's two queries
- [ ] 4.10 CLAUDE.md states the `batch.dishId` deduplication invariant for S-09 / S-11
- [ ] 4.11 Production solve verified after the `main` deploy, closing the Phase 2 `db push` window
- [ ] 4.12 The workerd solve time for an F6-shaped group and the account's Workers plan are recorded in Phase 4 §3
