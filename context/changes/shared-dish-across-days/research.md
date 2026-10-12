---
date: 2026-10-11T00:04:17Z
researcher: Claude (Opus 5) for Kamil Schlagowski
git_commit: 0acf4a4adcf7a732552b0ab99f309cce3009b8ad
branch: claude/relaxed-knuth-ftjgm0
repository: KSchlagowski/Duo-Kitchen
topic: "S-08 shared-dish-across-days: let one cooked dish cover meals on several days and still solve"
tags: [research, codebase, solver, linear-programming, meal-plans, plan-dishes, cross-day, determinism, cloudflare-workers, rls]
status: complete
last_updated: 2026-10-11
last_updated_by: Claude (Opus 5)
---

# Research: S-08 shared-dish-across-days

**Date**: 2026-10-11T00:04:17Z
**Researcher**: Claude (Opus 5) for Kamil Schlagowski
**Git Commit**: 0acf4a4adcf7a732552b0ab99f309cce3009b8ad (pushed to `origin/claude/relaxed-knuth-ftjgm0`, not on `main`)
**Branch**: claude/relaxed-knuth-ftjgm0
**Repository**: KSchlagowski/Duo-Kitchen

> File references are local `path:line` (clickable, and usable by `/10x-plan`). To expand one into a
> permanent link, prefix it with
> `https://github.com/KSchlagowski/Duo-Kitchen/blob/0acf4a4adcf7a732552b0ab99f309cce3009b8ad/`.

---

## Research Question

Ground the work described in `context/changes/shared-dish-across-days/change.md`: slice **S-08**,
*"user can make one cooked dish cover meals on several days, and solving still lands each person's
daily totals within tolerance"* (`context/foundation/roadmap.md:219-230`, PRD **US-01** and
**FR-017**).

The slice carries exactly one open Unknown, owner *team*, non-blocking
(`context/foundation/roadmap.md:228`):

> Does a shared dish couple the days into one solve, or are days solved in order with the batch
> already fixed?

Answering that, and mapping every layer it touches, is the purpose of this document.

### Scoping caveat

`change.md` is bare (`status: new`, notes only `S-08 from @context/foundation/roadmap.md`), so there
is no narrowing beyond the roadmap entry. This session is non-interactive, so the scope assumptions
below are stated rather than asked. There is no `context/foundation/lessons.md`; every archived slice
recorded `Lesson: —`, so there are no known-pattern priors to fold in.

**Assumptions taken (each traceable to a prior decision, not invented here):**

- **A1 — a dish never crosses plans.** Settled in S-03 (`context/archive/2026-10-08-plan-three-day-grid/research.md:78`):
  *"a dish covers meals of one plan only. A dish spanning two 3-day plans is out of FR-017's scope."*
  Enforced by `plan_meals (dish_id, plan_id) → plan_dishes (id, plan_id)`. Not re-litigated.
- **A2 — no spoilage, expiry, pantry or servings model.** PRD Non-Goals (`context/foundation/prd.md:158-159`):
  *"No food shelf-life or expiry tracking. The 3-day cycle covers this."* A batch may span all three
  days with no freshness logic. There is no servings concept
  (`context/archive/2026-10-08-browse-recipe-library/research.md:157-158`).
- **A3 — the canonical case is the same recipe in the same kind of slot on 2–3 days.**
  `docs/app-concept-eng.md:66`: *"One cooked dish can cover meals across several days (e.g. lunch for
  2–3 days)."*
- **A4 — no library schema change.** Bounds stay solver constants, not columns
  (`context/archive/2026-10-09-solve-daily-macros/plan.md:124`). S-08 adds no column to `recipes` /
  `recipe_components`.

**Environment caveat:** this checkout has **no `node_modules`** and no `.env` / `.dev.vars`, so
nothing was executed — every finding is from reading source. `npm ci` plus the Supabase secrets are
prerequisites for the plan's verification phases.

---

## Summary

**The answer to the Unknown: couple the days into one solve.** "Days solved in order with the batch
already fixed" is self-defeating, and the reason is concrete rather than aesthetic — see
[§1](#1-the-central-decision-couple-the-days). The recommended unit of work is the **solve group**:
the set of days connected (transitively) by a shared dish. A day that shares nothing is a group of
one and solves *exactly* as it does today, which is what keeps every pinned fixture and smoke string
intact.

**The good news — the groundwork S-03 and S-04 laid is real, and more of it holds than expected:**

- `plan_dishes` already exists as the batch entity with no quantity column and no
  `unique (plan_id, recipe_id)`; its own table comment already says *"S-08 lets several meals share
  one dish"* (`supabase/migrations/20261008170000_meal_plans.sql:76`).
- The schema change is **one `drop constraint` plus one `create index`**, spelled out verbatim in the
  migration header at `supabase/migrations/20261008170000_meal_plans.sql:11-16`. Nothing — no FK,
  view, matview, trigger or function — depends on `plan_meals_dish_id_key`.
- `plan_day_solutions` was deliberately built to survive this exact change: jsonb result, no FK to
  meals or dishes (`supabase/migrations/20261009120000_plan_day_solutions.sql:8-13`).
- The LP's scale variable is **already indexed per `(meal, component, eater)`**
  (`src/lib/services/macro-solver.ts:225`), and `slotRank()` is already day-aware
  (`src/lib/services/macro-solver.ts:65-67`). A multi-day LP is a reindex of the *totals* constraint,
  not a new formulation. **`MAX_SCALE = 1.5` needs no change** — see [§4.1](#41-max_scale-needs-no-change),
  which corrects a worry recorded in the archive.
- Growing the stored jsonb is a solved pattern: `boundsViolated: z.boolean().default(false)`
  (`src/lib/services/day-solutions.ts:153`) is the precedent for additive fields that let old rows
  keep parsing.

**The three things that will actually hurt:**

1. **CPU on the edge.** The vitest budget today is *100 no-fit single-day solves under 1 s*
   (`src/lib/services/macro-solver.test.ts:412`) — i.e. already ~10 ms each, at the Workers Free
   plan's 10 ms CPU limit. A coupled 3-day no-fit solve multiplies the LP, the repair search *and*
   the leave-one-out count. S-04 explicitly deferred measuring this on workerd
   (`context/archive/2026-10-09-solve-daily-macros/reviews/impl-review.md:182`). This is the top risk
   and must be measured before the design is locked. [§6](#6-the-cpu-risk-measure-this-first)
2. **Staleness goes blind, silently.** Toggling "share this batch" changes no fingerprint input
   today — `dayFingerprint` emits `[mealId, mealType, recipeId, eaterUserId]` per meal
   (`src/lib/services/macro-solver.ts:800`), with **no `dayIndex` and no dish identity**, and
   `save_meal_plan`'s slot diff keeps meal ids. A pre-toggle solve would read as *current* and be
   wrong. [§5](#5-the-fingerprint-the-silent-correctness-hole)
3. **The split model is hard-wired to two shares.** `CompState.split` is a single scalar and
   `fractions()` returns `[first, 1 - first]` (`src/lib/services/macro-solver.ts:387-393`). A batch
   feeding 2 days × 2 people has four servings. This is the one genuine piece of solver surgery.
   [§4.3](#43-the-split-model-is-the-real-surgery)

The dish is **invisible above SQL**: there is no `PlanDish` type, and `getMealPlan()`'s select
projects the dish id away (`src/lib/services/meal-plans.ts:97`). Nothing in `src/` can express a
shared batch today.

---

## 1. The central decision: couple the days

### 1.1 Why "solve days in order with the batch fixed" cannot work

The sequential reading fails on a sizing paradox:

- Day 0's lunch and day 1's lunch share one batch. Under the sequential reading, day 0 is solved
  first and fixes the batch.
- But day 0's solve optimises **day 0's** totals only. It has no reason to cook more than day 0
  needs, so day 1 inherits a batch with nothing left for it — or an arbitrary multiplier nobody
  chose.
- To size the batch correctly, day 0's solve must know day 1's targets, day 1's other meals, and how
  much of day 1's gap this dish should close. That *is* coupling, arriving through the back door.
- And the user-facing failure mode is worse: day 1 would have strictly less freedom than day 0, so it
  would routinely miss ±10%, and the only remedy — re-solving day 0 — invalidates day 1 again. The
  loop does not converge, which breaks the slice's own outcome ("solving still lands each person's
  daily totals within tolerance") and reads as the app blocking the user, against
  `context/foundation/prd.md:45`.

A middle variant — "the owning day's solve sizes the batch for all of its servings, later days just
read their share" — is a coupled solve with a per-day storage convention. That is the recommendation
below, so the two branches of the Unknown converge once the sizing paradox is taken seriously.

### 1.2 The recommended unit: the solve group

Define the **solve group** as a connected component of the graph *days ← linked by a shared dish →
days*, computed over one plan (A1 keeps it inside one plan):

- a day sharing nothing is a **group of one**;
- a dish shared by day 0's lunch and day 2's lunch puts days 0 and 2 in one group; a second dish
  shared by day 1 and day 2 merges all three.

Why this is the right unit:

- **Zero regression for unshared plans.** For a singleton group the LP, the rounding, the repair and
  the result are identical to today — the totals constraint simply has a constant day index. That
  preserves the unit fixtures F1–F4 (`src/lib/services/macro-solver.test.ts:77-112`) and every pinned
  smoke string (`scripts/smoke.mjs:658`, `:689`, `:699`, `:715`, `:730`).
- **It bounds the cost.** The CPU risk in [§6](#6-the-cpu-risk-measure-this-first) scales with group
  size, and A3's realistic case ("lunch for 2–3 days") is a 2-day group, not the whole plan.
- **It matches the PRD exactly.** Each day in the group still gets its own per-person totals
  constraint, so *"individual meals do not need to hit macros; only the daily sum does"*
  (`context/foundation/prd.md:142-144`) survives untouched: the shared batch is a shared *supply*,
  and each day's draw from it is a separate decision.

### 1.3 Which day owns the cooking

Deterministic rule: **the lowest `day_index` among the dish's meals**. It is stable under
re-solve, needs no new column, and matches the cook-ahead intent (*"whatever possible is cooked in
the evening (ahead of time)"*, `docs/app-concept-eng.md:134`) that S-10 will schedule against.

---

## 2. The database layer

### 2.1 The three tables, as built

`public.meal_plans` (`supabase/migrations/20261008170000_meal_plans.sql:46-58`) — one row per
`(household_id, start_date)`, with `meal_plans_id_household_key unique (id, household_id)` as the
composite FK target.

`public.plan_dishes` (`:63-80`) — **the batch entity**:

```sql
create table public.plan_dishes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  plan_id uuid not null,
  recipe_id uuid not null references public.recipes on delete restrict,
  created_at timestamptz not null default now(),
  constraint plan_dishes_plan_fkey foreign key (plan_id, household_id)
    references public.meal_plans (id, household_id) on delete cascade,
  constraint plan_dishes_id_plan_key unique (id, plan_id)
);
```

Two properties matter for S-08: **no quantity/batch column** (quantities live only in the solved
jsonb), and **no `unique (plan_id, recipe_id)`** — several dishes of one recipe in one plan are
already legal, which is exactly what S-03 produces when the same recipe fills two slots. The table
comment at `:76` already reads *"S-08 lets several meals share one dish."*

`public.plan_meals` (`:82-108`) — one filled slot, with the constraint S-08 drops at `:100-101`:

```sql
  -- S-03 only -- S-08 drops this (one dish shared by meals on several days).
  constraint plan_meals_dish_id_key unique (dish_id)
```

`plan_meals_slot_key unique (plan_id, day_index, meal_type)` and `check (day_index between 0 and 2)`
both **stay**.

### 2.2 The schema change is two statements

Verbatim from the migration header (`supabase/migrations/20261008170000_meal_plans.sql:11-16`):

```sql
alter table public.plan_meals drop constraint plan_meals_dish_id_key;
create index on public.plan_meals (dish_id, plan_id);  -- the unique index currently covers that FK
```

Verified: **nothing depends on that constraint.** No FK references it (`plan_meals_dish_fkey` points
*from* `plan_meals` *to* `plan_dishes_id_plan_key`; nothing references `plan_meals` at all, and
`plan_day_solutions` deliberately has no FK to it —
`supabase/migrations/20261009120000_plan_day_solutions.sql:11-13`). No view, matview or trigger
exists on any plan table. The only real dependency is **index coverage**: the unique index on
`(dish_id)` is the sole index with `dish_id` leading, so it serves both the `on delete cascade`
lookup from `plan_dishes` and step 4d's `not exists` probe. Hence the replacement index — this is
also recorded as a deliberate hand-off in
`context/archive/2026-10-08-plan-three-day-grid/plan.md:411`.

### 2.3 `save_meal_plan` — where 1:1 actually lives

Body at `supabase/migrations/20261008170000_meal_plans.sql:176-326`. Payload today (`:171-172`): a
jsonb array of at most 15 objects `{ day_index, meal_type, recipe_id, eater_user_id }`.

The four diff steps, and how each fares under sharing:

| Step | Lines | Status under S-08 |
| --- | --- | --- |
| 4a — delete meals whose slot is gone or recipe changed | `:284-292` | **Must be rewritten.** Keys on `(day_index, meal_type, recipe_id)` only; dish *identity* is never compared, so a change in grouping alone leaves rows untouched and the plan silently un-regrouped. |
| 4b — eater-only update keeps the meal id | `:294-301` | Already share-safe (slot-keyed, dish-agnostic). |
| 4c — insert a new dish + meal per new/changed slot | `:303-316` | **The hard 1:1 producer.** Unconditionally inserts a *fresh* `plan_dishes` row per slot, with no lookup or reuse. Even with the constraint dropped, the function could never produce a shared dish. This is the block S-08 rewrites. |
| 4d — delete dishes no meal eats from | `:318-322` | Already share-safe by `not exists`, and commented for S-08 at `:318-319`. Keep it last — that ordering was chosen for this slice (`context/archive/2026-10-08-plan-three-day-grid/plan.md:75`). |

**The validator is tolerant of a new key.** The per-element check at `:217-221` verifies the four
required keys are *present*, not that no others exist — so a 5th grouping key passes today's
validation unvalidated. That is convenient for rollout and dangerous for correctness: it must be
explicitly validated when present.

### 2.4 Trust boundary: grouping must be validated in the RPC

`save_meal_plan` is `grant execute … to authenticated` (`:328-332`), so any household member can call
it directly with a hand-built payload. Grouping rules therefore cannot live only in
`src/pages/api/plan.ts`; the route's checks are UX, the RPC's are the guarantee. New SQLSTATEs start
at **KD015** (KD001–KD014 claimed, KD006 retired —
`supabase/migrations/20261008170000_meal_plans.sql:32-38`,
`supabase/migrations/20261009120000_plan_day_solutions.sql:25-30`). At minimum:

- a grouping key naming meals with **different `recipe_id`s** → its own KD;
- a grouping key referencing a slot that is **not in the payload** → its own KD (distinct, so the UI
  can say which).

### 2.5 `plan_day_solutions` and the write path

Table at `supabase/migrations/20261009120000_plan_day_solutions.sql:39-60`:
`unique (plan_id, day_index)`, `check (day_index between 0 and 2)`, `result jsonb not null check
(jsonb_typeof(result) = 'object')`, `input_fingerprint text ~ '^[0-9a-f]{64}$'`, 64 KB cap enforced
in the RPC at `:134-136`. `save_day_solution` validates **nothing** about the day's contents, so a
cross-day-shaped result passes today's shape checks unchanged.

**The one real gap: atomicity across a group.** A group's days must be written together — they share
one fingerprint and one accepted tolerance, and a half-written group would show one day solved
against a batch the other day does not know about. Calling `save_day_solution` once per day is not
atomic and should be rejected on those grounds.

Recommended: **one new definer RPC that writes a whole group** (e.g.
`public.save_plan_day_solutions(p_start_date date, p_solutions jsonb)`), and **retire
`save_day_solution` in the same migration**, keeping the project's "one write path per table"
invariant that CLAUDE.md states for every write-revoked table. Costs to budget, all mechanical:

- the isolation test asserts function grants by **exact signature string**
  (`supabase/tests/household_isolation.sql:1392-1397`), so dropping the old function makes that
  assertion *error* rather than fail cleanly — it must be replaced in the same change;
- `drop function` / `create function` resets Supabase's default `execute to public`, so the
  `revoke … from public, anon` + `grant … to authenticated` pair must be re-issued;
- the anon-executability probe (`:1113-1125`) and the rejection table (`:877-889`) move with it.

Keeping both functions would work and is less churn, but leaves two write paths into one
write-revoked table — worth a one-line decision in the plan rather than drifting into it.

---

## 3. The stored jsonb: grow it additively

### 3.1 The contract as it stands

`daySolutionSchema` at `src/lib/services/day-solutions.ts:85-154`, consumed only through the
module-private `parseStoredSolution()` (`:157-166`), called from `getDaySolution()` (`:188`) and
`getPlanSolveStatuses()` (`:288`). CLAUDE.md names these as the mandated door for S-08/S-09/S-11.
Three behaviours decide the migration strategy:

- it is **`z.object`, not `.strict()`** — unknown keys are *stripped*, so a new field written by a
  newer writer is silently dropped by an older reader (quiet loss, not a loud failure);
- **`version: z.literal(1)`** is a hard gate: a `version: 2` row fails the parse, and a failed parse
  reads as **never solved** (`:188-191`, `:288-291`);
- `boundsViolated: z.boolean().default(false)` at `:153` with the comment at `:152` is the
  **established precedent** for growing the shape without breaking old rows.

### 3.2 Recommended shape change

**Keep `version: 1` and grow additively.** Add to each `meals[]` element an optional batch
reference, e.g.:

```ts
batch?: { dishId: string; cookDayIndex: 0 | 1 | 2; mealIds: string[] }
```

and keep `DaySolutionIngredient.amountG` meaning exactly what it means today — *"the batch cook
amount"* (`src/types.ts:207-208`). Both days' rows carry the shared dish's full component data, so
every row stays self-describing (which the per-day page needs anyway) and the two rows are consistent
by construction. **Downstream consumers deduplicate by `batch.dishId`**: count each `dishId` once
across the plan. The absence of `batch` unambiguously means "cooked for this day alone", so
pre-S-08 rows need no interpretation rules.

Why not a `version: 2` bump or a top-level `batches[]` array: either makes every pre-S-08 row read as
*"Not solved"* rather than *"Out of date"*. A stale row still renders (at `opacity-50`, with "Solve
again" — `src/pages/plan/day.astro:161`, `:128-143`), which is strictly kinder, and `SOLVER_VERSION`
already marks them stale. A top-level batch array would also break the flat render loop at
`src/pages/plan/day.astro:214-246`.

For the split, `DaySplitShare` (`src/types.ts:193-197`) gains an optional `dayIndex` (or `mealId`), so
the owning day's split can name all four servings of a 2-day × 2-person batch. `DaySplit.shares` is
already an array, so the *type* accommodates this; only the solver's scalar does not
([§4.3](#43-the-split-model-is-the-real-surgery)).

**Write this invariant into CLAUDE.md** alongside the existing S-04 hand-off line, because S-09's
shopping list and S-11's cook mode are the consumers that would double-count a shared batch.

---

## 4. The solver

### 4.1 `MAX_SCALE` needs no change

The archive records a worry that *"a single shared batch cannot exceed 1.5× under today's reading"*
(derived from `context/archive/2026-10-09-solve-daily-macros/plan.md:70-74`). Reading the shipped
code, that worry does not apply to the recommended design:

`solveLp()` creates one variable `x_{k}_{c}_{pi}` per **(meal `k`, component `c`, eater `pi`)**
(`src/lib/services/macro-solver.ts:225`) and bounds *each* at `{ min: lowerScale, max: MAX_SCALE }`
(`:214`). The bound is therefore **per serving**, not per batch. The batch cook amount is already a
*sum* of those variables — `batchScale = x.reduce((s, v) => s + v, 0)` at `:409`.

So a dish shared by M meals with 2 eaters each simply sums 2M serving variables into one cook amount,
each still ≤ 1.5× and ≥ 0.2×. `MIN_SCALE`, `MAX_SCALE`, `MAX_COMPONENT_RATIO` and
`ZERO_TARGET_REFERENCE_G` all stay as they are. The cap would only bind if a shared dish were modelled
with a single scale per `(component, eater)` across all days — which would also destroy the per-day
freedom that makes each day hit ±10%, so it is the wrong model for independent reasons.

Residual, worth stating and accepting: a lunch shared across 3 days for 2 people can reach ~9× a base
batch. There is no pot-capacity model and the PRD requires none (A2/A4). Flag as a known limitation,
not a bound to add.

### 4.2 What the LP change actually is

| Element | Today | Coupled group |
| --- | --- | --- |
| Scale variables | `x_{k}_{c}_{pi}` per (meal, component, eater), `:225` | **Unchanged** — meals already carry their day |
| Totals constraints | `tot_{pi}_{m}` per (person, macro), `:200` | `tot_{day}_{pi}_{m}` per (day, person, macro) — a reindex |
| Deviation vars `u`/`v`, minimax `t` | per (person, macro), `:235-253` | per (day, person, macro); one `t` for the group |
| Per-variable bound | `b_{k}_{c}_{pi}`, `:214` | Unchanged |
| Ratio bound | `r_…` within one meal, `:217-224` | Unchanged in form; must be evaluated **per serving** (see below) |
| Input sorting | `slotRank = dayIndex * MEAL_TYPES.length + …`, `:65-67` | **Already day-aware** |

Two internal consequences:

- `CompState.mealIndex: number` (`:349`) is a *single* meal — a shared dish's component spans several
  meals, so this becomes a list of `(meal, eater)` servings. `evaluate()`'s ratio-bound grouping test
  `csB.mealIndex !== csA.mealIndex` (`:488`) must become "same meal-serving".
- Rounding (`initialState`, `:402-439`) rounds the cook amount once from `batchScale`; for a shared
  dish that sum spans days. `isPerPersonComponent()` (`:341`, components with half-piece ingredients)
  generalises *naturally* to per-`(day, person)` rounding — slicing bread per meal is physically
  correct, not a workaround.

`repair()`'s rounding windows (`roundingWindow`, `:309-321`) keep their guarantee: repair can only
choose between the two cookable amounts bracketing the exact one, so it still cannot rewrite a
recipe's proportions to beat the LP.

### 4.3 The split model is the real surgery

The hard two-share assumption:

```ts
// src/lib/services/macro-solver.ts:387-393
function fractions(cs: CompState): number[] | null {
  if (cs.mode === "all" || cs.mode === "per_person") return cs.eaters.map(() => 1);
  const total = splitTotal(cs);
  if (total <= 0 || cs.split < 0 || cs.split > total) return null;
  const first = cs.split / total;
  return [first, 1 - first];
}
```

`CompState.split` is one scalar (`:357-358`), `splitUnit()` is 10 g or 1 % (`:378-384`), and
`candidateMoves()` steps it by ±1 unit (`:540-545`). A batch feeding 2 days × 2 people has four
servings.

Recommended generalisation, chosen to keep the existing rules intact: make `split` a **vector of
integer units over the servings, with the last serving taking the exact remainder** — which is
precisely the P7 remainder rule already in force (*"the second eater takes the exact remainder"*,
`context/archive/2026-10-09-solve-daily-macros/plan.md:77-85`), just generalised. Candidate moves
become "move one unit from serving *i* to serving *j*", enumerated in a fixed order by
`(dayIndex, userId)`; with at most 6 servings that is ≤ 30 moves, bounded and deterministic. For a
singleton group with two eaters this reduces to today's ±1-unit move on a 2-vector, so F1–F4 are
unperturbed.

### 4.4 The no-fit explanation

`explain()` does leave-one-out over **meals** (`:670-679`). With a shared dish those diverge:
removing one meal of a shared dish does not remove the batch, so the blame ranking becomes
meaningless for exactly the recipes S-08 is about. Recommended: **leave-one-dish-out** (remove all of
a dish's meals together). Two bonuses — it is also strictly fewer re-solves (helping §6), and it
partially mitigates S-04's deferred **F6** bias (*"Removing a meal that is someone's only meal of the
day drops that person from the minimax entirely"*,
`context/archive/2026-10-09-solve-daily-macros/reviews/impl-review.md:132-147`).

Note the wording: `formatDaySolveSummary()` emits `No fit within ±20% · Most obstructive recipe: …`
(`src/lib/services/day-solutions.ts:418`), pinned by smoke at `scripts/smoke.mjs:689`. For a blamed
*shared* dish the recipe is not really the problem — sharing it across days is. Adding a third
`explanation.kind` is possible but note that a `discriminatedUnion` **fails** on an unknown
discriminator (unlike an unknown key, which is stripped), so a new kind requires reader-before-writer
ordering. Cheaper: keep `kind: "recipe"` and add an optional defaulted flag.

### 4.5 `SOLVER_VERSION`

Bump **2 → 3** (`src/lib/services/macro-solver.ts:36`). This is the documented one-line mechanism for
making every pre-S-08 stored row read "Out of date" without a data migration
(`context/archive/2026-10-09-solve-daily-macros/plan.md:170`). Since the bump invalidates everything
anyway, it is also the cheapest moment to close deferred **F8** (*"the fingerprint omits display names
that the stored result copies"*, `.../reviews/impl-review.md:163-171`).

---

## 5. The fingerprint: the silent correctness hole

`dayFingerprint()` (`src/lib/services/macro-solver.ts:792-835`) emits per meal:

```ts
meals: meals.map((m) => [m.mealId, m.mealType, m.recipeId, m.eaterUserId]),
```

Two gaps, both load-bearing:

1. **No `dayIndex`.** `sortMeals()` orders by `slotRank` (which includes the day), but the emitted
   tuple omits it. That is sound today only because every fingerprint covers a single day
   (`.filter((meal) => meal.dayIndex === dayIndex)` —
   `src/lib/services/day-solutions.ts:42`, `:279`). The moment a fingerprint spans days, two
   differently-arranged plans could hash identically. **`dayIndex` must join the tuple.**
2. **No dish identity — and the app layer has none to give.** Toggling "share this batch" keeps the
   recipe, the eaters and (thanks to `save_meal_plan`'s slot diff, 4b) **every meal id**. So every
   fingerprint input is unchanged and a pre-toggle stored solve reads as **current**, silently
   describing a batch that no longer matches the plan. This is precisely the failure mode fingerprints
   were introduced to prevent (`context/archive/2026-10-09-solve-daily-macros/plan.md:59`:
   *"Staleness must come from a fingerprint, not from FKs."*).

**Do not put the raw `plan_dishes.id` uuid in the fingerprint.** `save_meal_plan` recreates dish rows
on any recipe change (step 4c), so a fresh uuid would mark untouched days stale for no reason. Use a
**canonical grouping label derived from the sorted member slot ranks** of the dish — stable across
re-saves, and different exactly when the grouping differs.

Finally: **every day in a group stores the same group fingerprint.** That single choice makes
cross-day staleness work for free (an edit to day 1 marks day 0 "Out of date"), and makes the Accept
flow's fingerprint check (`src/pages/api/plan/solve.ts:105-107`, hidden field at
`src/pages/plan/day.astro:182`) cover the group. Accepting a tier should therefore apply group-wide —
otherwise one day sits at ±15% while its partner day does not.

---

## 6. The CPU risk: measure this first

The numbers, from the repo:

- `src/lib/services/macro-solver.test.ts:409-415` — *"100 solves of the no-fit day, leave-one-out
  included, take under a second"*, i.e. **under ~10 ms each** for a single 5-meal day.
- The Cloudflare Workers Free plan allows **10 ms CPU** per request. `wrangler.jsonc` sets no limits
  block; which plan the account is on is not visible in the repo.
- S-04 already deferred exactly this measurement:
  `context/archive/2026-10-09-solve-daily-macros/reviews/impl-review.md:182` — *"A no-fit solve … on a
  cold isolate has not been measured on workerd against the Free plan's 10 ms limit."* The warm
  figures that *were* measured are ~0.3–0.6 ms per day (`.../research.md:37`).

A coupled 3-day group multiplies three things at once: the LP size (~3×, still trivial in absolute
terms — roughly 100 variables and 150 constraints, which `yalps` handles easily), the repair search
(~3× the states and ~3× the candidate moves per accepted move, plus O(servings²) split moves), and
the leave-one-out count (15 re-solves instead of 5, each on the larger LP). A worst-case coupled
no-fit solve could plausibly land an order of magnitude above the single-day figure — i.e. **well past
10 ms**.

Mitigations already available in the design, in order of value:

1. **Groups, not plans** ([§1.2](#12-the-recommended-unit-the-solve-group)) — the realistic case (A3)
   is a 2-day group, and unshared days keep today's cost exactly.
2. **Leave-one-*dish*-out** ([§4.4](#44-the-no-fit-explanation)) — fewer re-solves, and better blame.
3. `explain()` already runs only when `requiredTier === null`
   (`src/lib/services/macro-solver.ts:766`), so the expensive path is the no-fit path only.
4. If measurement still fails: cap a group at 2 days, or compute the explanation at group level once
   rather than per day.

**Recommendation for the plan: make a benchmark of a coupled worst case (3-day group, all whole-dish,
no fit) the first phase's exit criterion**, before the storage and UI work is committed. It is cheap
to measure (`npm test` needs no secrets) and it is the one finding that could change the design.

---

## 7. The application layer

### 7.1 The dish is invisible above SQL

There is no `PlanDish` interface anywhere in `src/types.ts`, and no `dishId` on `PlanMeal` /
`PlanMealRecord` (`src/types.ts:116-126`). `getMealPlan()` selects only the dish's recipe:

```ts
// src/lib/services/meal-plans.ts:96-97
const select =
  "id, start_date, updated_at, plan_meals!plan_meals_plan_fkey(id, day_index, meal_type, eater_user_id, plan_dishes!plan_meals_dish_fkey(recipe_id))";
```

and flattens it to `recipeId` at `:117-129`, with `MealPlanRow.plan_dishes` declared as
`{ recipe_id: string } | null` (`:88`). The save payload likewise carries no dish identity
(`:143-148`). So the app model is **slot → recipe**, and a shared batch is simply unexpressible.

One caveat flagged by the DB research and worth verifying during implementation: PostgREST infers
to-one vs to-many embeds partly from uniqueness on the FK columns, so the *shape* of the
`plan_dishes!plan_meals_dish_fkey(...)` embed should be re-checked after `plan_meals_dish_id_key` is
dropped — the file already notes that without a generated `Database` type the client guesses every
embed is an array (`src/lib/services/meal-plans.ts:110-111`).

### 7.2 The per-day filter is the single chokepoint

Two lines make a solve single-day:

- `src/lib/services/day-solutions.ts:42` — `loadDaySolveInputs`
- `src/lib/services/day-solutions.ts:279` — `getPlanSolveStatuses`

both `plan.meals.filter((meal) => meal.dayIndex === dayIndex)`. Encouragingly,
`getPlanSolveStatuses()` **already loads shared inputs plan-wide**
(`loadSharedInputs(supabase, plan.meals.map((meal) => meal.recipeId))`, `:271-275`), so a coupled
solve needs **no new database read** — only a different partition of meals.

### 7.3 The grid is a plain form, and that is fine

`src/pages/plan.astro` has no `client:*` directive and no `.tsx` import. The field grammar is 34
named fields: `start_date`, `day{0..2}_eater`, and
`d{0..2}_{breakfast|second_breakfast|lunch|afternoon_snack|dinner}_{recipe,eater}`, with the zod
schema **generated** by looping `PLAN_DAYS × MEAL_TYPES` (`src/pages/api/plan.ts:23-31`). The route
reads only known keys (`form.get(key) ?? undefined`, `:63`), so any field S-08 adds must be added to
`slotFields` or it never arrives.

Recommended affordance: a **third select per slot**, `d{day}_{mealType}_batch`, with
`value=""` = "Cook a fresh batch" plus one option per *other* slot. Name **slots, not dish ids**,
because (a) the app has no dish ids to render, and (b) the grid posts one atomic snapshot against a
slot-level diff, so a slot reference stays valid even for a dish created in the same save.

This dissolves the apparent "no island" problem: because the reference names a slot and the payload is
atomic, the server can offer *every* other slot as an option and validate the pair **against the
submitted payload** (same recipe, target slot filled) rather than against the saved plan. No live
client-side filtering is needed. The existing precedents are `PARTNER_NOT_LINKED`
(`src/pages/api/plan.ts:16`, route-level) and `PLAN_ERRORS` (`src/lib/services/meal-plans.ts:55-60`,
KD-mapped) — use both layers, per [§2.4](#24-trust-boundary-grouping-must-be-validated-in-the-rpc).

**Hard layout constraint to respect:** the per-day solve forms are siblings *after* the grid form,
never nested (`src/pages/plan.astro:244-245`, *"Forms cannot nest, and a formaction button in the grid
would post unsaved grid edits that the solve route ignores"*), and the solve-status read sits in its
own `try/catch` outside `canEdit` so a failing solve read can never hide the grid (FR-020, stated
three times in `context/archive/2026-10-09-solve-daily-macros/plan.md:168`).

### 7.4 Routes and display strings

`/plan/day?start=&day=` and `POST /api/plan/solve` with `day_index` need **no shape change**: solving
any day in a group solves the group, and the route can resolve the group from the plan.
`src/middleware.ts:4-11` matches `/plan` by prefix, so any new `/plan/*` route is already protected.

Smoke-pinned strings and whether they must move:

| Function | Location | Verdict |
| --- | --- | --- |
| `formatPlanSummary()` | `src/lib/services/meal-plans.ts:47-50` | **Leave alone.** It counts filled slots, which is still correct. Pinned at `scripts/smoke.mjs:369`, `:404`, `:520`, `:545`. |
| `formatPlanDayStatus()` | `src/lib/services/day-solutions.ts:312-330` | **No new `kind` needed** if a group solves as a unit — every day in the group gets the group's status, and "Out of date" propagates via the shared fingerprint. Keeping these strings keeps `scripts/smoke.mjs:653`, `:717`, `:730` intact. |
| `formatDaySolveSummary()` | `src/lib/services/day-solutions.ts:402-421` | Only the no-fit sentence is doubtful for a shared dish ([§4.4](#44-the-no-fit-explanation)). Pinned at `scripts/smoke.mjs:689`, `:699`, `:712`. |
| `DAY_SOLVE_STALE` | `src/lib/services/day-solutions.ts:340` | **Needs widening** — it names "the plan, targets or recipes", which does not cover "the day sharing this batch changed". |
| `needsSolvePrompt()` | `src/lib/services/day-solutions.ts:301-305` | Fires per day at 5 meals. For a group, prompt **once** (on the lowest day) or the user sees two or three prompts for one solve. |

Any new enum label belongs in `src/lib/recipe-labels.ts` — the single map S-14 localises — not in a
page.

### 7.5 Day page rendering

`src/pages/plan/day.astro:213-240` walks `solution.meals → components → ingredients` flat. Without a
batch affordance a shared dish renders as two identical ingredient lists on two days. With the
`batch` field from [§3.2](#32-recommended-shape-change): the owning day shows the cook amounts plus
"set aside *X* for \<weekday\>", and a non-owning day shows only its own servings plus "from
\<weekday\>'s batch". All rendering is inline in the two pages — there is no `src/components/plan/`
and no component renders plan or solution data.

---

## 8. Verification path and test surface

### 8.1 The chain a schema + solver change must pass

`npm test` (vitest, `src/**/*.test.ts`, no secrets) runs **only** in the `ci` job
(`.github/workflows/ci.yml:21`). `npm run test:rls` and `npm run test:seed` run in the `smoke` job
(`:42`, `:46`) **against the deployed schema, not the branch's migrations**; `npm run check:migrations`
gates `deploy` (`:100`). Hence the mandated order, per CLAUDE.md:

```
write migration → npx supabase db push → npm run test:rls → npm test
→ npm run build && npm run preview → npm run smoke → push
```

`npm run test:seed` should be untouched: `supabase/tests/seed_integrity.sql` references no plan,
dish, meal or solution shape, and its pinned per-table counts (`:328-331`) only matter if seed content
changes. Pre-commit (husky + lint-staged) runs eslint/prettier only — **no test hook**.

### 8.2 `household_isolation.sql` — the concentrated work

Dropping `plan_meals_dish_id_key` touches more of this file than of any other, even though no
catch-all inspects constraints:

- `:151-153` — the fixture comment *"plan_meals_dish_id_key allows one meal per dish, so A's two
  meals need two dishes"* becomes wrong. The natural addition is a **shared-dish fixture** (one dish,
  two meals on different days), which then moves the exact counts at `:551-563` (`plan_dishes` = 2,
  `plan_meals` = 2) and the dish count at `:2113-2116`.
- `:596-604` — the `plan_meals` write-revoke probe deliberately leans on the constraint: *"if the
  revoke is gone this fails on plan_meals_dish_id_key, unhandled."* After the drop, a regressed
  revoke would make that insert **succeed silently**. The probe must be re-reasoned — note
  `plan_meals_slot_key` survives, so reusing an occupied slot is not a substitute; keep a free slot
  plus an existing dish and rely purely on the revoke.
- `:634-733` — every *"expected 2 dishes"* assertion encodes one-dish-per-meal and must be re-pinned,
  plus new assertions for the shared path (create, regroup, split apart, orphan cleanup).
- `:735-786` — the rejection table needs cases for the new grouping SQLSTATEs. Because the current
  validator only checks key *presence* (`:217-221`), a regression that drops the new validation
  would otherwise be silent.
- `:179-217` — the "a meal cannot eat from a dish of another plan" probe (`:207-213`) stays valid and
  is the proof A1 still holds. **Add its mirror**: an insert proving *same-plan, different-day*
  sharing is now allowed — the direct regression guard for the dropped constraint.
- `:1319-1359` / `:1361-1399` — the grant blocks, by exact function signature; see
  [§2.5](#25-plan_day_solutions-and-the-write-path) if `save_day_solution` is retired.
- `:2147`, `:2151` — the closing summary strings, updated by every slice.

If S-08 adds any new `public` table, the classification catch-all (`:1192-1280`, `library_tables` at
`:1205`) demands it be household-scoped or declared a library table, plus its own grants block — the
catch-alls never inspect grants. The recommended design adds **no new table**.

### 8.3 The vitest suite extends cleanly, with two edits

`src/lib/services/macro-solver.test.ts` iterates `{ F1, F2, F3, F4 }` in all four main `describe`
blocks, and `input()` / `solved()` / `shuffledInput()` are parameterised on `meals` only — so adding
an `F5` cross-day fixture extends `determinism`, `invariants` and most of `rounding` for free.

The two genuine edits:

1. **`day()` hard-codes the day.** `src/lib/services/macro-solver.fixtures.ts:276-290` sets
   `dayIndex: 0 as const` and derives `mealId` from the slot alone — so two days' breakfasts would
   **collide on meal id**. It must take a `dayIndex` (defaulting to 0 keeps F1–F4's expansions
   byte-identical) and fold it into the id.
2. **Four `find()`s assume one meal per recipe per day** (`test.ts:104`, `:142`, `:148`, `:158`,
   plus `baseOf()` at `:71-74`); they must key on `mealId` once a dish is shared.

Assertions most likely to break and worth watching: the exact F2 blame object
(`test.ts:86-92`, including `macro: "carbsG"`, `direction: "under"`) if the leave-one-out ranking
changes to dish granularity; the `ROUNDING_ALLOWANCE` of 0.01 at `:247`; `toStrictEqual` on the whole
solution at `:117` (any new field must be produced deterministically on shuffled input too); and the
1-second budget at `:412`. A **new, separate** cross-day performance test with its own budget is
better than loosening that one.

### 8.4 What a smoke section must do

Existing fixtures: `planStart = "2031-01-06"` (S-03, `scripts/smoke.mjs:116`) and
`solveStart = "2031-01-13"` (S-04, `:130`), both with literal meal counts asserted. **Use a fresh
date** (e.g. `2031-01-20`) — the convention is stated at `:135`. Then:

1. post a shared-dish plan through S-08's new field grammar (and pin the new field names);
2. prove it is *one* batch, not two — over HTTP that is only observable if the grid or day page labels
   the shared dish, so the markup needs a `data-testid`;
3. solve and assert **both** sharing days land in tolerance — that is the slice's actual claim;
4. assert cross-day staleness: editing one sharing day marks **both** `Out of date`
   (`day-status-0` *and* `day-status-1`) — the direct regression test for
   [§5](#5-the-fingerprint-the-silent-correctness-hole);
5. add an `S08_TEST_IDS` array with its own debug loop, following the comment at `:800-811` so the
   shared id list stays untouched for parallel slices.

Brittleness to respect: `testIdText()` / `testIdBody()` match only `<p …>` elements (`:71-74`,
`:112-114`), so moving a pinned `data-testid` onto a `<span>` or `<div>` fails silently; `:525` and
`:551` parse raw `<option …>`/`<select name=…>` markup; `:704` requires the accept form's hidden
input to keep `name="fingerprint"`. Also note `day{n}_eater` (`src/pages/api/plan.ts:93`, `:99`) is
**never exercised by smoke** — an S-08 regression there would be invisible. And because
`src/pages/api/plan.ts:63` treats a missing recipe field as an empty slot, *adding* fields is
backward compatible, but any field that becomes **required** would silently empty the plan, caught
only by the `N of 15 meals` counts at `:404` / `:545`.

---

## Code References

**Schema and RPCs**
- `supabase/migrations/20261008170000_meal_plans.sql:11-16` — the S-08 hand-off recipe, verbatim
- `supabase/migrations/20261008170000_meal_plans.sql:63-80` — `plan_dishes`, the batch entity
- `supabase/migrations/20261008170000_meal_plans.sql:100-101` — `plan_meals_dish_id_key`, the one constraint to drop
- `supabase/migrations/20261008170000_meal_plans.sql:284-292` — step 4a, the recipe-keyed diff to rewrite
- `supabase/migrations/20261008170000_meal_plans.sql:303-316` — step 4c, the hard 1:1 dish producer
- `supabase/migrations/20261008170000_meal_plans.sql:318-322` — step 4d, already share-safe
- `supabase/migrations/20261008170000_meal_plans.sql:217-221` — the key-presence validator (tolerates a 5th key)
- `supabase/migrations/20261009120000_plan_day_solutions.sql:8-13` — why the result is un-normalised jsonb
- `supabase/migrations/20261009120000_plan_day_solutions.sql:39-60` — `plan_day_solutions`, `unique (plan_id, day_index)`

**Solver**
- `src/lib/services/macro-solver.ts:36` — `SOLVER_VERSION = 2`, to bump
- `src/lib/services/macro-solver.ts:39-47` — the solver constants
- `src/lib/services/macro-solver.ts:65-67` — `slotRank`, already day-aware
- `src/lib/services/macro-solver.ts:200`, `:214`, `:225` — the LP's totals row, per-serving bound and scale variable
- `src/lib/services/macro-solver.ts:341`, `:402-439` — per-person vs batch rounding
- `src/lib/services/macro-solver.ts:349`, `:387-393` — `CompState.mealIndex` and the two-share `fractions()`
- `src/lib/services/macro-solver.ts:488` — the ratio bound's meal grouping
- `src/lib/services/macro-solver.ts:670-679` — leave-one-out over meals
- `src/lib/services/macro-solver.ts:792-835` — `dayFingerprint()`; `:800` is the tuple missing `dayIndex` and dish identity

**Services, routes, pages**
- `src/lib/services/meal-plans.ts:88`, `:96-97`, `:117-129` — the dish id projected away
- `src/lib/services/meal-plans.ts:143-148` — the save payload, no dish identity
- `src/lib/services/day-solutions.ts:42`, `:279` — the two per-day filters
- `src/lib/services/day-solutions.ts:85-154`, `:157-166` — `daySolutionSchema` and `parseStoredSolution()`; `:153` is the additive precedent
- `src/lib/services/day-solutions.ts:271-275` — shared inputs already loaded plan-wide
- `src/lib/services/day-solutions.ts:312-330`, `:402-421`, `:340` — the smoke-pinned strings
- `src/pages/api/plan.ts:23-31`, `:63`, `:90-111` — the generated field schema and the slot build loop
- `src/pages/api/plan/solve.ts:21-31`, `:105-107` — the solve schema and the accept fingerprint check
- `src/pages/plan.astro:244-245` — forms cannot nest (FR-020 layout rule)
- `src/pages/plan/day.astro:213-240` — the flat meal render loop
- `src/types.ts:116-126`, `:168-173`, `:193-197`, `:205-256` — plan, solver-input and solution types
- `src/middleware.ts:4-11` — `/plan` protected by prefix

**Tests**
- `supabase/tests/household_isolation.sql:151-153`, `:551-563`, `:596-604`, `:634-733`, `:735-786` — the plan assertions S-08 moves
- `supabase/tests/household_isolation.sql:1192-1280` — the classification catch-all (`library_tables` at `:1205`)
- `supabase/tests/household_isolation.sql:1319-1359`, `:1361-1399` — grant blocks, by exact signature
- `src/lib/services/macro-solver.fixtures.ts:276-290` — `day()`, `dayIndex: 0 as const`
- `src/lib/services/macro-solver.test.ts:86-92`, `:247`, `:412` — the most breakage-prone assertions
- `scripts/smoke.mjs:116-199` — S-03/S-04 fixtures; `:629-739` — the S-04 steps

---

## Architecture Insights

1. **The dish/meal split was the right bet, and it paid off.** S-03 weighed three shapes and chose
   "dish + meal with `unique (dish_id)` for S-03 only"
   (`context/archive/2026-10-08-plan-three-day-grid/research.md:70-76`) specifically so S-08 would be
   additive. Three slices later the claim holds: the schema change is two DDL statements and no data
   migration.
2. **The expensive part migrated upward, not away.** Because `plan_dishes` carries no quantities and
   `plan_day_solutions` stores un-normalised jsonb, there is nothing to migrate in the database — and
   correspondingly *all* the difficulty sits in the solver's split model, the fingerprint, and the
   jsonb contract. That is a good trade, but the plan should not read the small migration as a small
   slice.
3. **"Grouping" is the abstraction that keeps the blast radius small.** Making the solve unit a group
   of days (singleton by default) is what lets every existing fixture, pinned string and stored-row
   shape survive. Any design that solves "the plan" unconditionally would perturb F1–F4 and six smoke
   assertions for no benefit.
4. **Additive jsonb growth is an established, deliberate pattern.** `boundsViolated` with
   `.default(false)` plus a `SOLVER_VERSION` bump is how S-04 already evolved the stored shape. Reusing
   it (rather than bumping `version`) is what keeps pre-S-08 rows rendering as "Out of date" instead of
   "Not solved".
5. **Policies and grants are independent levers, and both are asserted.** The isolation test checks
   revokes directly, and the catch-alls inspect tables only — so a new function needs its own grant
   assertions, and dropping a function breaks an assertion by *erroring*, not failing.
6. **Two trust boundaries, both already modelled.** The stored jsonb is client-assertable (hence
   `parseStoredSolution`) and `save_meal_plan` is directly callable by any member (hence KD codes
   rather than route-only checks). S-08 crosses both and should follow both precedents.
7. **No island is not a constraint here.** Because the grid posts one atomic snapshot and
   `save_meal_plan` applies a slot-level diff, a *slot-named* share reference can be validated against
   the submitted payload — so the plain form loses nothing.

---

## Historical Context (from prior changes)

- `context/archive/2026-10-08-plan-three-day-grid/research.md:70-76` — the Option A/B/C decision
  table. A ("meal holds recipe") and B ("nullable `batch_id`") were rejected as *"exactly the rework
  the roadmap warns against"*; C was chosen because *"S-08 runs `alter table plan_meals drop
  constraint plan_meals_dish_id_key` and widens the RPC payload … No data migration."*
- `context/archive/2026-10-08-plan-three-day-grid/research.md:78` — **A1**: a dish covers one plan
  only; cross-plan dishes are outside FR-017.
- `context/archive/2026-10-08-plan-three-day-grid/plan.md:75` — deleting orphan dishes **last** was
  chosen *"to keep the step correct once S-08 lets several meals share one dish."*
- `context/archive/2026-10-08-plan-three-day-grid/plan.md:43` — the scope statement S-08 reverses:
  *"No shared dish across slots (S-08). The RPC payload has no dish key, and `unique (dish_id)`
  enforces 1:1."*
- `context/archive/2026-10-09-solve-daily-macros/research.md:48` — *"One dish ⇒ one meal ⇒ one day,
  for S-04 only … S-08 drops that constraint later, and then a shared dish couples days."* The
  single-day scope was a consequence of the constraint, nothing more.
- `context/archive/2026-10-09-solve-daily-macros/plan.md:67` — **P1**: results are per day and *"not
  normalised into `plan_dishes`/`plan_meals` columns, because S-08 changes dish→day cardinality
  anyway."* And `.../research.md:153`: *"One row per day keeps S-08 open, since a shared dish later
  becomes a multi-day row or a coupling decision."*
- `context/archive/2026-10-09-solve-daily-macros/plan.md:122` — S-04's explicit non-goal: *"No solving
  across days or for shared dishes. That is S-08."* And `:127`: *"No change to `save_meal_plan`,
  `meal_plans`, `plan_dishes` or `plan_meals`"* — so **S-08 is the first slice to touch
  `save_meal_plan` since S-03.**
- `context/archive/2026-10-09-solve-daily-macros/plan.md:258` — *"Everything downstream (S-09 shopping
  sums, S-11 portions) should consume the solver's per-component scale plus the rounded ingredient
  amounts, never re-derive them."* This is why the `batch.dishId` dedup key matters.
- `context/archive/2026-10-09-solve-daily-macros/reviews/impl-review.md:132-147` (**F6**, deferred) —
  leave-one-out blame is biased toward a person's only meal, *"so the flaw is in the plan."*
  Relevant because S-08 changes what "removing a meal" means.
- `context/archive/2026-10-09-solve-daily-macros/reviews/impl-review.md:163-171` (**F8**, deferred) —
  the fingerprint omits display names the stored result copies. Cheap to fix alongside a
  `SOLVER_VERSION` bump.
- `context/archive/2026-10-09-solve-daily-macros/reviews/impl-review.md:173-197` (**F9**, **F10**,
  deferred) — `getPlanSolveStatuses` fetches full jsonb just to read `requiredTier`; a concurrent
  plain "Solve again" can silently undo a partner's acceptance. **F10 gets worse with groups** (a
  group-wide accept is more to lose), so the proposed `greatest(...)` on `accepted_tolerance_pct` is
  worth folding in.
- `context/foundation/shape-notes.md:41-43` — the original intent: *"They cook in bulk in the morning
  and evening, and during the day they only reheat or eat from a box … one large batch can be split
  deterministically between two people."*

---

## Related Research

- `context/archive/2026-10-08-plan-three-day-grid/research.md` — where `plan_dishes` came from (S-03)
- `context/archive/2026-10-09-solve-daily-macros/research.md` — the LP, rounding, repair and
  fingerprint design S-08 extends (S-04)
- `context/archive/2026-10-08-shared-recipe-library/research.md` — why recipes are referenced by plain
  FK (F-04)
- `context/archive/2026-10-08-browse-recipe-library/research.md:157-158` — "whole batch", not "per
  serving"; there is no servings concept

---

## Open Questions

Carried into `/10x-plan` as decisions to make, not blockers:

1. **Does the coupled worst case fit the edge CPU budget?** The one question that could change the
   design. Measure a 3-day, all-whole-dish, no-fit group in `npm test` first, and confirm which
   Cloudflare plan the account is on (the repo does not say). Fallbacks in
   [§6](#6-the-cpu-risk-measure-this-first). *(Supersedes the roadmap's Unknown as the real risk;
   the Unknown itself is answered in [§1](#1-the-central-decision-couple-the-days).)*
2. **One group write RPC replacing `save_day_solution`, or two coexisting write paths?**
   Recommendation and costs in [§2.5](#25-plan_day_solutions-and-the-write-path). This is a
   10-minute decision with a day of test churn behind it, so decide it before writing the migration.
3. **Does the user choose "share this batch", or does the app infer it?** This research assumes an
   explicit per-slot choice (A3's "lunch for 2–3 days" is deliberate behaviour, and inference would
   surprise). Auto-sharing identical recipes in identical slots would need no new field at all —
   worth one sentence of confirmation, since it changes the UI work substantially.
4. **Does a shared dish need a user-visible label on `/plan`?** Needed for smoke step 2 in
   [§8.4](#84-what-a-smoke-section-must-do) (over HTTP, "one batch not two" is otherwise
   unobservable), and it interacts with S-10's cooking-session view.
5. **How much of a batch may be set aside?** `MAX_SCALE` needs no change
   ([§4.1](#41-max_scale-needs-no-change)), but a 3-day shared lunch can reach ~9× a base batch and
   there is no pot-capacity model. Recommended: accept and document as a limitation; revisit only if
   the couple reports it.
6. **Should the no-fit explanation gain a third `explanation.kind` for a shared dish?**
   [§4.4](#44-the-no-fit-explanation) — note the reader-before-writer ordering a `discriminatedUnion`
   imposes.
