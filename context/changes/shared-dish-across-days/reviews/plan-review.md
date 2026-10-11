<!-- PLAN-REVIEW-REPORT -->
# Plan Review: S-08 Shared dish across days

- **Plan**: `context/changes/shared-dish-across-days/plan.md`
- **Mode**: Deep (no sub-agents; verification done inline against the checked-out source)
- **Date**: 2026-10-11
- **Verdict**: REVISE
- **Findings**: 1 critical, 8 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | FAIL |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | FAIL |
| Plan Completeness | WARNING |

**Why REVISE and not RETHINK**: both FAILs are localised omissions, not a wrong approach. The core
design decisions — couple the days (D1), the solve group as the unit, keep `version: 1` (D4), fix the
fingerprint, drop `plan_meals_dish_id_key` with a replacement index, union-find in the RPC — all hold
up against the code. Every finding below is a targeted edit to the plan, not a redesign.

## Grounding

Grounding: 16/16 paths ✓ (every file the plan names exists; `docs/reference/contract-surfaces.md` and
`context/foundation/lessons.md` absent, so those scans were skipped), 19/19 symbols ✓, brief↔plan ✓,
Progress↔Phase contract ✓ (one `## Progress` after `## References`; 4 phase subsections matching the
4 `## Phase N:` headers; 11 automated + 11 manual rows covering every Success Criteria bullet; no
stray checkboxes in phase bodies).

Spot-checked claims that are **correct**: the per-serving `MAX_SCALE` bound
(`macro-solver.ts:213-214` keys the bound on `b_{meal}_{component}_{eater}`) and `batchScale = Σ x`
(`:409`); `slotRank()` already day-aware (`:65-67`); the two-share split model (`:357-358`,
`:387-393`, `:540-545`); the dish-blind diff (`meal_plans.sql:284-292`) and the 1:1 producer
(`:303-316`); the key-presence-only validator (`:217-221`); the fingerprint tuple missing `dayIndex`
and dish identity (`:800`); `plan_dishes` carrying no quantity column and no `unique (plan_id,
recipe_id)`; the per-day filters (`day-solutions.ts:42`, `:279`); `boundsViolated:
z.boolean().default(false)` as the additive-growth precedent (`:152-153`); the `discriminatedUnion`
at `:140-151`; `opacity-50` on stale (`day.astro:161`); `expect([15, 20]).toContain(...)`
(`macro-solver.test.ts:97`); the smoke `<p …>`-only helpers (`smoke.mjs:71-74`, `:112-114`) and the
per-slice debug loops (`:800-811`). Two reference drifts of a few lines only
(`household_isolation.sql:2113-2116` is a variable, not a literal count; the pinned no-fit sentence
is at `smoke.mjs:695`, not `:689`) — not worth findings.

## Findings

### F1 — The coupled objective is missing: `evaluate()` / `repair()` still score per person, not per (day, person)

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phase 1 §3–§6 (`src/lib/services/macro-solver.ts`)
- **Detail**: Phase 1 generalises the LP's constraints to `tot_{day}_{pi}_{m}` (§4) and says each day's
  `people[]` holds "that day's own totals and deviations" (§6), but **no contract touches the repair
  loop's scorer**. `evaluate()` (`macro-solver.ts:450-506`) accumulates into
  `totals: Map<string, MacroTotals>` keyed by **userId only**, computes `deviationsFor(totals[person],
  targets[person])`, and returns one `max`/`sum` that `improves()` (`:508-517`) and `repair()`
  (`:562-586`) minimise; `solveDayWithDiagnostics` then reads `evaluation.totals.get(userId)` (`:743`)
  to build `people[]`. Follow the plan's contracts literally and a 2-day group sums both days' intake
  for one person against a **single day's** target: `max` lands near 1.0, `tierFor()` returns null, and
  **every shared group reports "no fit"** — the exact opposite of the slice's claim. There is also no
  way to emit per-day `people[]` from a userId-keyed map at all, and the F5 invariant the Testing
  Strategy pins ("rounded worst deviation not meaningfully below the LP optimum") compares
  `evaluation.max` against the group's single minimax `t`, which only type-checks as a comparison once
  `max` is the worst over (day, person). `DayMeal` already carries `meal.dayIndex`, so the information
  is present — it is the contract that is missing.
- **Fix A ⭐ Recommended**: Add an explicit Phase 1 contract for the scorer: `Evaluation.totals` becomes
  keyed by `(dayIndex, userId)` (`CompState.servings` already carries the meal, and `DayMeal` the day),
  `violation` stays global, `max`/`sum` are taken over every (day, person) pair, and `peopleOut` for
  each day reads that day's slice. State the singleton reduction as the assertion ("one day ⇒ the map
  has one entry per person ⇒ byte-identical to today").
  - Strength: Keeps the minimax semantics the LP already has (one `t` over per-day deviations), so the
    repair optimises the same objective the LP does — which is what makes the F5 "rounded ≥ LP optimum
    − allowance" invariant meaningful.
  - Tradeoff: Touches `evaluate`, `improves`, `repair`, `solveDayWithDiagnostics` and the two
    diagnostics fields — i.e. the generalisation list grows by one item and Phase 1 gets bigger.
  - Confidence: HIGH — read directly off `macro-solver.ts:450-517` and `:740-757`.
  - Blind spot: Whether `sum` (the L1 tie-break in `improves`) should also be per-day-normalised is a
    separate judgement; the plan should state it either way.
- **Fix B**: Keep `evaluate()` per person but give the solver one `CompState` set per day by splitting a
  shared dish's component into per-day pseudo-components that share a rounding window.
  - Strength: No change to the scorer's shape, so `improves`/`repair` are untouched.
  - Tradeoff: Re-introduces the coupling problem one level down — the shared batch's single rounded
    cook amount must then be reconciled across two independent states, which is precisely what D4's
    "both days carry the dish's full component data" is meant to avoid.
  - Confidence: MEDIUM — plausible but it fights the `CompState`-per-dish decision in §3.
  - Blind spot: Not evaluated against `cookAmounts()` / `buildComponent()`'s batch-amount contract.
- **Decision**: FIXED via Fix A — Phase 1 §5 retitled "Repair, its move set and the scorer" and given an explicit contract: `Evaluation.totals` keyed by `(dayIndex, userId)`, `deviationsFor()` per (day, person), `max`/`sum` over every (day, person) pair with `sum` left un-normalised, `violation` global, `solveDayWithDiagnostics` reading per-(day, person) slices, plus the stated singleton reduction.

### F2 — Phase 2's `db push` drops `save_day_solution` in production while the deployed Worker still calls it

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Phase 2 §1 step 4 + "Implementation Note" / "Migration Notes → Deploy order"
- **Detail**: The plan's deploy-safety claim is *"phases 2 and 3 land together… they are never deployed
  separately"*. That is true of the **code** and false of the **database**. There is one hosted
  Supabase project (CLAUDE.md: "Supabase is cloud-only"), `npm run test:rls` runs against the
  already-deployed schema, and CI cannot `db push` — so Phase 2's own criterion 2.1 applies the
  migration to **production** before the branch is merged. From that moment the live Worker
  (`duo-kitchen.mediewilnp.workers.dev`), which still runs `saveDaySolution()` →
  `supabase.rpc("save_day_solution", …)` (`day-solutions.ts:211`), gets a missing-function error on
  every solve; `/api/plan/solve` catches it and redirects with "Macros could not be solved right now"
  (`solve.ts:130-133`). The window is however long phases 3 and 4 take — the brief estimates one
  session each. Every prior migration in `supabase/migrations/` is additive, so this is the first slice
  where `db push` is a breaking production change, and nothing in the plan names it.
- **Fix A ⭐ Recommended**: Name the window and sequence around it. Add it to "Migration Notes → Deploy
  order" ("between `db push` and the `main` deploy, production's Solve/Accept buttons return
  `DAY_SOLVE_FAILED`; plan reads and the grid are unaffected"), move Phase 2's Implementation Note from
  "pause for manual confirmation" to "phases 2–4 complete and merge in one working block", and add a
  Progress row under Phase 4 for "production solve verified after the deploy".
  - Strength: Zero extra code; keeps D2's invariant ("`plan_day_solutions` keeps exactly one write
    path") and CLAUDE.md's write-revoked rule literally true, which is the thing this repo is strictest
    about. The real-world cost is a graceful error on one button in a two-user app.
  - Tradeoff: A real, if bounded, production regression, and it couples the phase gating — Phase 2 can
    no longer be left overnight for review.
  - Confidence: HIGH — the ordering follows from CLAUDE.md's own mandated chain plus
    `check:migrations` running in the deploy job.
  - Blind spot: Not verified whether the hosted project has any other consumer of
    `save_day_solution` besides this Worker.
- **Fix B**: Keep `save_day_solution(date, int, text, int, text, jsonb)` as a thin deprecated wrapper
  that calls `save_plan_day_solutions` with a one-element array, with its existing revoke/grant pair,
  and drop it in a named follow-up migration once S-08 is live.
  - Strength: No production window at all; the single `insert … on conflict` still lives in one place.
  - Tradeoff: Two client-callable write paths into a write-revoked table for a slice or two, which
    contradicts D2 as written and needs CLAUDE.md, the isolation test's grant block
    (`household_isolation.sql:1392-1397`) and the anon probe (`:1114-1126`) to carry both signatures —
    plus a deferred cleanup that can be forgotten.
  - Confidence: HIGH — mechanically straightforward.
  - Blind spot: Whether the isolation test's "one write path" narrative can express a shim without
    weakening the assertion it exists to make.
- **Decision**: FIXED via Fix A — **Migration Notes → Deploy order** now names the production window (Solve/Accept return `DAY_SOLVE_FAILED` between `db push` and the `main` deploy; reads unaffected) and records the rejected wrapper alternative; Phase 2's Implementation Note changed from "pause before Phase 3" to "complete and merge phases 2–4 in one working block"; new Progress row 4.11 plus its Phase 4 manual criterion for a verified production solve.

### F3 — The CPU gate does not measure the runtime the risk lives on, and its number contradicts the plan's own estimate

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Phase 1 §11 (the `performance` test) + "Performance Considerations"
- **Detail**: Three separate problems in the slice's self-declared top risk. (a) The stated risk is a
  **Cloudflare Workers CPU limit**, but the gate is a vitest measurement on dev hardware; the plan's own
  text says today's single-day solve "is already at the Cloudflare Workers Free plan's 10 ms CPU limit"
  and that the repo "does not record which plan the account is on" — research Open Question 1 asked for
  exactly that confirmation and the plan restates the unknown instead of closing it, although it is one
  command. A 250 ms absolute budget is 25× over the limit it is nominally protecting. (b) The relative
  budget contradicts the plan's own arithmetic one section later: Performance Considerations multiplies
  "~3× the states, ~3× the candidate moves per accepted move… and 3× the move budget under D9" for the
  repair search alone — 27× before the LP and leave-one-out growth — against a ≤ 25× gate. F6 (F2 on
  three days, 13 dishes) also runs 13 leave-one-**dish**-out LP solves on a 3× LP where F2 runs 5 on a
  1× LP, so `explain()` alone is several-fold. The gate will very likely trip. (c) Since the current F2
  solve is ~10 ms, 25× and 250 ms are the *same* number on today's hardware, so the claim that the
  absolute budget "catches a blow-up the ratio would hide" is vacuous as calibrated.
- **Fix A ⭐ Recommended**: Split measurement from gating. Keep an F6 vitest test as a **regression
  guard** with a budget derived from the plan's own multiplication (≈ 60× relative, absolute set from
  the first measured value), and add the real measurement to Phase 4, where `npm run preview` already
  serves the Cloudflare runtime: time one POST to `/api/plan/solve` for an F6-shaped 3-day group,
  record the number in the plan, and record the account's Workers plan from `npx wrangler whoami` /
  the dashboard. Make the recorded workerd figure a Progress row.
  - Strength: Measures the limit that actually exists, on the runtime that enforces it, using a step
    already in the mandated chain — and stops Phase 1 failing on a number the plan itself predicts it
    will exceed.
  - Tradeoff: The decisive measurement moves from Phase 1 to Phase 4, i.e. after the storage and UI
    work is written — which is exactly the ordering research §6 warned against.
  - Confidence: HIGH for the calibration arithmetic; MEDIUM on whether a timed HTTP POST isolates CPU
    well enough on the preview runtime (it includes Supabase round-trips, so it is an upper bound).
  - Blind spot: Cold-isolate cost is still unmeasured either way; S-04 deferred the same thing.
- **Fix B**: Keep the gate in Phase 1 but make it record-and-ratchet: measure the F6/F2 ratio, write the
  observed value into the plan as the pinned budget plus a margin, and treat the edge CPU limit as a
  monitored risk with no gate.
  - Strength: Phase 1 stays self-contained and cheap; no phase ordering changes.
  - Tradeoff: Nothing in the slice ever tests the actual constraint; a limit breach ships and surfaces
    as a production 500 under `/api/plan/solve`.
  - Confidence: HIGH that it is cheap, LOW that it manages the risk.
  - Blind spot: The failure mode on exceeding a Workers CPU limit (error vs. throttle) is not
    established in the plan.
- **Decision**: FIXED via Fix A — Phase 1 §11 recast as a dev/CI regression guard at ≤ 60× (derived from the plan's own multiplication) with the absolute assertion pinned at 3× the first measured value, and the vacuous 25× / 250 ms pairing explained; new Phase 4 §3 "The edge CPU measurement" times a POST to `/api/plan/solve` for an F6-shaped group on workerd and records the account's Workers plan (old §3 renumbered to §4); Performance Considerations gained a "measurement is split from gating" paragraph; criterion 1.4, Progress 1.4 and new Progress 4.12 follow.

### F4 — If the pre-committed mitigation is not enough, the plan has no next step

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Phase 1 Manual Verification / "Performance Considerations" step 3 / Progress 1.6
- **Detail**: Research §6 offered four mitigations and the plan adopts the first three, then replaces
  research's fourth — *"cap a group at 2 days, or compute the explanation at group level once rather
  than per day"* — with memoising `componentBatchMacros()` / `baseMass()` and making `evaluate()`
  incremental, asserting *"no fallback caps group size or degrades the result, so the measurement cannot
  change what the app computes"*. The two design fallbacks are not listed under "What We're NOT Doing"
  and are not held in reserve; they simply vanish. So the ladder terminates: Progress 1.6 reads "If the
  F6 budget failed, the pre-committed behaviour-neutral mitigation was applied and F1–F4 still pass"
  and the plan says nothing about the case where it was applied and the budget **still** fails. Given
  F3(b) that is the likely branch, and the implementer would be improvising a scope decision mid-phase
  — precisely what the plan's preamble promises it does not leave open.
- **Fix A**: Reinstate research's group cap as a pre-committed third rung: a solve group may span at
  most 2 days, validated in `save_meal_plan` with a new class-`KD` SQLSTATE and a `PLAN_ERRORS`
  message, with the `/plan` select omitting options that would form a 3-day group.
  - Strength: Bounds the worst case by construction; research says the realistic case (A3, "lunch for
    2–3 days") is a 2-day group, so most of the value survives.
  - Tradeoff: Cuts the 3-day case the Desired End State and F6 are both written around, adds a fourth
    SQLSTATE plus its isolation-test row and route message, and makes the user hit a wall.
  - Confidence: MEDIUM — the cap is easy, but "2–3 days" in the brief means it cuts a case the PRD's
    FR-017 arguably covers.
  - Blind spot: Whether the couple actually wants a 3-day batch has not been checked.
- **Fix B ⭐ Recommended**: Pre-commit a degradation that touches only the no-fit **explanation**: when a
  group spans more than one day, skip `explain()` and store `explanation: null`. `explain()` is the
  dominant cost (13 LP re-solves for F6) and already runs only on the no-fit path
  (`macro-solver.ts:766`); `explanation: null` is an existing supported state that
  `formatDaySolveSummary()` already handles by falling back to "No fit within ±20%"
  (`day-solutions.ts:411-420`), so no reader changes and no deploy ordering.
  - Strength: Removes the largest multiplier without capping the feature or changing a single
    quantity; costs one `if` and one sentence of documentation.
  - Tradeoff: A multi-day group that cannot be solved loses the "Most obstructive recipe" sentence,
    which is the one piece of actionable advice on that screen; D7's `sharedAcrossDays` flag then only
    ever fires on a blamed *single*-day dish inside a multi-day group.
  - Confidence: HIGH that it works and is cheap; MEDIUM that it is sufficient on its own.
  - Blind spot: The repair search's own 27× growth is untouched by this, so it may not be enough
    alone — which is why it belongs in the plan as a *stated* rung rather than an improvisation.
- **Decision**: FIXED via Fix B — Performance Considerations gained rung 4: for a multi-day group, skip `explain()` and store `explanation: null` (an already-supported state `formatDaySolveSummary()` handles), with its cost stated; the closing "behaviour-neutral throughout" sentence corrected to scope rungs 1–3, and the group cap explicitly recorded as not adopted. Phase 1's manual bullet and Progress 1.6 now say "climb the ladder in order (rung 3, then rung 4)".

### F5 — Optional zod fields will not satisfy `daySolutionSchema: z.ZodType<DaySolution>`

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 §1 (`src/types.ts`) vs Phase 3 §2 (`daySolutionSchema`)
- **Detail**: Phase 1 adds the new fields as **required** (`DaySplitShare` "gains `mealId: string` and
  `dayIndex: PlanDayIndex`"; `DaySolutionMeal` gains `batch: DaySolutionBatch | null`), while Phase 3
  makes the same fields **optional** in the schema ("`meals[].batch` optional, `split.shares[].mealId` /
  `.dayIndex` optional"). The schema is explicitly annotated `const daySolutionSchema:
  z.ZodType<DaySolution>` (`day-solutions.ts:94`), so `.optional()` produces `mealId?: string |
  undefined`, which is not assignable to `mealId: string`, and `astro check` fails. The repo's own
  precedent for exactly this situation is `boundsViolated: z.boolean().default(false)` (`:153`) — a
  `.default()` makes the output **required**. This matters beyond types: `SOLVER_VERSION` 2 → 3 makes
  every pre-S-08 row stale, and stale rows are still rendered at `opacity-50` (`day.astro:161`), so
  `formatSplitLine()` will genuinely be handed legacy shares that carry no `mealId`.
- **Fix**: Model the new fields as nullable-with-default rather than optional: `batch:
  DaySolutionBatch | null` with `.nullable().default(null)`, and `mealId: string | null` / `dayIndex:
  PlanDayIndex | null` with `.nullable().default(null)`; have `formatSplitLine()` add the weekday suffix
  only when `share.dayIndex !== null && share.dayIndex !== viewedDay`, which also makes legacy rows
  render byte-identically to today.
  - Strength: Mirrors the `boundsViolated` pattern the plan itself cites as the precedent, so
    `z.ZodType<DaySolution>` keeps holding and no reader needs a `?.`.
  - Tradeoff: Three nullable fields the writer always populates — a small, permanent "legacy row"
    allowance in the type.
  - Confidence: HIGH — `day-solutions.ts:94` and `:152-153` are explicit.
  - Blind spot: None significant.
- **Decision**: FIXED via the single Fix — Phase 1 §1 now specifies the three new fields as nullable-with-default (`.nullable().default(null)`) rather than optional, citing the `z.ZodType<DaySolution>` annotation and the `boundsViolated` precedent; `DaySplitShare` typed `mealId: string | null` / `dayIndex: PlanDayIndex | null`; Phase 3 §2's schema bullet matches, and `formatSplitLine()` suffixes a weekday only when `share.dayIndex !== null && share.dayIndex !== viewedDay`. D4's wording changed from "optional" to "nullable, defaulted".

### F6 — `shareWith` on `PlanMeal` leaks a write-only concept into `PlanMealRecord`, `getMealPlan()` and every solver fixture

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 §1, Phase 1 §10, Phase 3 §1
- **Detail**: `PlanMealRecord extends PlanMeal` (`types.ts:124`), so putting `shareWith` on `PlanMeal`
  puts it on every **read** record too. `getMealPlan()` (`meal-plans.ts:117-129`) has no `share_with`
  column to read — grouping on the read side is `dishId`, which is what Phase 3 §5 actually renders the
  canonical star form from — so the implementer must either synthesise `shareWith` from `dishId`
  (redundant, two sources of truth for the same fact) or hard-code `null` (a field that is always
  `null` on reads and load-bearing on writes). It also propagates into `SolveDayInput.meals:
  PlanMealRecord[]`, so every fixture record in `macro-solver.fixtures.ts` must carry it even though the
  solver never reads it — and the fixture contract in Phase 1 §10 confirms the mismatch, since
  `day(recipes, eaters?, dayIndex = 0, shareWith?)` is per-day and therefore cannot express the
  cross-day share F5 needs at all.
- **Fix**: Keep `shareWith` off the read types: add it to a distinct write-side DTO (e.g. `PlanMealInput
  = PlanMeal & { shareWith: { dayIndex: PlanDayIndex; mealType: MealType } | null }`) used by
  `/api/plan` and `saveMealPlan()`, and give `PlanMealRecord` only `dishId`. In the fixtures, express
  sharing as a post-step over the concatenated days (e.g. `shareDish(meals, slotA, slotB)` rewriting
  both records' `dishId`) rather than a `day()` parameter, so F5 and F6 can be built from unmodified
  `day()` calls and F1–F4's expansions stay byte-identical.
  - Strength: One source of truth per direction — `dishId` for reads, `shareWith` for writes — matching
    how `PlanEater` already exists only as a form-level type (`types.ts:111`).
  - Tradeoff: One more exported type, and `/api/plan`'s build loop maps to `PlanMealInput` instead of
    `PlanMeal`.
  - Confidence: HIGH — `types.ts:116-126`, `meal-plans.ts:117-129` and `fixtures.ts:276-295` are
    explicit.
  - Blind spot: None significant.
- **Decision**: FIXED via the single Fix — Phase 1 §1 replaces `PlanMeal.shareWith` with a write-side `PlanMealInput = PlanMeal & { shareWith … }` (reasoning from `PlanMealRecord extends PlanMeal` and `getMealPlan()`'s missing column, with `PlanEater` as precedent); `PlanMealRecord` gains `dishId` and nothing else; Phase 1 §10 drops the `shareWith?` parameter from `day()` in favour of a `shareDish(meals, slotA, slotB)` post-step; Phase 3 §1 and §3 take/build `PlanMealInput`.

### F7 — The day page's stated intent (no two identical ingredient lists) is not delivered by its contract, and smoke step 4 pins the duplication

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phase 3 §6 / Phase 4 §1 step 4 / Progress 3.9
- **Detail**: Phase 3 §6's Intent is *"Make a shared batch legible instead of rendering two identical
  ingredient lists"*, but its Contract only **adds** a `<p data-testid="day-batch-{mealType}">` note —
  nothing suppresses or restyles the list. Because D4 stores the dish's full component data on both
  days with the batch `amountG`, `day.astro:224-241` will render the *whole batch* on the non-cook day
  too: a 3-day shared lunch shows "Ryż 900 g" on Wednesday, a day on which the user cooks nothing.
  Smoke step 4 and Progress 3.9 then lock the duplication in by asserting the ingredient lines are
  **identical** on both days. The Contract and the Intent disagree, and the verification sides with the
  Contract. Two smaller renderings go with it: `formatSplitLine()` will emit four shares on both pages,
  and `buildSplit`'s `evenSplit` (`macro-solver.ts:624`, `Math.abs(values[0] - values[1]) <
  splitUnit`) plus `SPLIT_LABELS.splitInHalf` are two-share concepts the plan never generalises, so a
  4-serving batch can render "· split in half".
- **Fix A ⭐ Recommended**: On the non-cook day, render the batch note and the viewer's own portion but
  **not** the batch ingredient list; keep the full list on the cook day. Re-point the "one batch, not
  two" proof at the cook-day list versus the stored jsonb (or at the batch note's amounts appearing on
  exactly one day), and state explicitly what `evenSplit` means for more than two servings.
  - Strength: Delivers the Intent and FR-017's cook-ahead story — amounts appear on the day they are
    cooked, which is what a cook needs; removes the "900 g of rice on a day you cook nothing" trap.
  - Tradeoff: Smoke step 4 and Progress 3.9 must be rewritten, and the single flat meal loop at
    `day.astro:214-246` gains a branch.
  - Confidence: HIGH on the rendering consequence; MEDIUM on the best replacement assertion.
  - Blind spot: Whether the non-cook day should show reheating/portion grams instead of nothing is a
    product call the plan has not made.
- **Fix B**: Keep both lists and retitle the Intent ("label the shared batch on both days") — the note
  plus the weekday-suffixed split line carry the disambiguation, and smoke step 4 stands as written.
  - Strength: Zero extra work; the equality assertion is a genuinely strong proof that it is one batch.
  - Tradeoff: Ships a page that shows a full batch's cook amounts on a day with no cooking, which is
    the misreading the Intent names.
  - Confidence: HIGH — it is the plan as written.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — Phase 3 §6 gained a "The non-cook day must not repeat the batch ingredient list" contract (branch on `batch.cookDayIndex !== viewedDay`: note plus the viewer's own portion, no batch list), smoke step 4 re-points the "one batch, not two" proof at that asymmetry while leaving stored-amount equality to F5's unit assertions, Progress 3.9 and the Phase 3 manual bullet follow, and Phase 1 §6 now states what `evenSplit` means beyond two servings (`splitInHalf` only when `servings.length === 2`).

### F8 — The `share_with` payload snippet names the slot's own identity, so every shared slot self-references (KD015)

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §1 (`src/lib/services/meal-plans.ts`)
- **Detail**: The contract gives the payload line verbatim as
  ``share_with: meal.shareWith ? `${dayIndex}_${mealType}` : null``. Inside `saveMealPlan()`'s map
  (`meal-plans.ts:143-148`) there is no bare `dayIndex` / `mealType` in scope — the fields are
  `meal.dayIndex` / `meal.mealType` — and more importantly those are the **current** slot's
  coordinates, not the target's. Copied as written, every shared slot would name itself, which the
  plan's own KD015 is specified to reject ("or it names the element's own slot"), so no share could
  ever be saved.
- **Fix**: Correct the snippet to
  ``share_with: meal.shareWith ? `${meal.shareWith.dayIndex}_${meal.shareWith.mealType}` : null`` and
  add one unit-level or isolation-level case that a saved share round-trips (two meals, one dish),
  since the route-side regex alone cannot catch a correctly-formatted wrong slot.
- **Decision**: FIXED via the single Fix — Phase 3 §1 now gives the snippet as a fenced line using the **target** slot (`meal.shareWith.dayIndex` / `.mealType`), explains why the element's own coordinates would self-reference into KD015, and points at Phase 2 §7, where the **create** diff case was extended to double as the `share_with` round-trip pin (two meals, one dish); the Testing Strategy line mentions it too.

### F9 — The group solve prompt can render "<Weekday> has all 5 meals" on a day that does not have 5 meals

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3 §2 (`needsSolvePrompt`, `getPlanSolveStatuses`)
- **Detail**: The new rule is `status.isGroupLead && status.groupMaxMealCount === MEAL_TYPES.length &&
  (unsolved || stale)`, and the prompt body is unchanged: `formatSolvePrompt(weekday)` →
  `` `${weekday} has all 5 meals. Solve its macros?` `` (`day-solutions.ts:332-334`, rendered at
  `plan.astro:281-283`). `groupMaxMealCount` is the **max** over the group's days and `isGroupLead` is
  the group's **lowest** day, so a group whose day 0 holds 3 meals and day 1 holds 5 prints the prompt
  on day 0 with a sentence that is factually false, and "its macros" is wrong for a group in any case.
  The plan lists several new sentences in `day-solutions.ts` but not this one.
- **Fix A ⭐ Recommended**: Add a group-aware prompt template alongside `formatSolvePrompt()` (e.g.
  `formatGroupSolvePrompt(weekdays)` → "Monday and Tuesday share a batch and have all 5 meals. Solve
  them together?") and use it when `groupDayIndexes.length > 1`; keep `formatSolvePrompt()` untouched
  for singletons so the existing smoke assertion stays byte-identical, and define `groupMaxMealCount`
  in the plan as "the most meals any day of the group holds".
  - Strength: Keeps the generous "prompt if any day of the group is full" behaviour while the sentence
    stays true, and puts the new text in `day-solutions.ts` where the plan says all sentences live.
  - Tradeoff: One more pinned display string and one more `S08_TEST_IDS` entry to assert.
  - Confidence: HIGH — the rule and the template are both quoted above.
  - Blind spot: Smoke step 2 asserts `day-prompt-0` present / `day-prompt-1` absent for an F5-shaped
    group where both days hold 5 meals, so it would not exercise the mixed-group case; a mixed-group
    step is worth adding.
- **Fix B**: Require **every** day of the group to be full (a `groupMinMealCount === 5` rule) and leave
  `formatSolvePrompt()` alone.
  - Strength: One fewer string; the existing sentence stays true because the lead day is full too.
  - Tradeoff: A group of a full day plus a partial day gets no prompt at all — FR-018's prompt
    disappears for exactly the mixed plans a cook-ahead batch produces (the plain "Solve macros" button
    still shows, so the day is not unreachable).
  - Confidence: HIGH.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix A — Phase 3 §2 defines `groupMaxMealCount` as "the most meals any single day of the group holds" and `isGroupLead` as the group's lowest day, and adds `formatGroupSolvePrompt(weekdays)` used when `groupDayIndexes.length > 1` while `formatSolvePrompt()` stays untouched for singletons (with the all-days-full alternative recorded as rejected); smoke step 2 gained the mixed-group case the blind spot asked for.

### F10 — The write-revoke probe does not "succeed silently" after the constraint is dropped; the premise of a Critical Implementation Detail is wrong

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: "Critical Implementation Details → The write-revoke probe loses its backstop" / Phase 2
  §6 / plan-brief "Phases at a Glance" (Phase 2's key risk)
- **Detail**: The probe is `begin; insert …; raise exception 'plans: user A could insert into
  public.plan_meals directly'; exception when insufficient_privilege then null; end;`
  (`household_isolation.sql:596-604`). If the revoke regressed and the insert succeeded, the explicit
  `raise exception` fires as `P0001`, which that handler does **not** catch, so the test fails loudly
  with the right message — dropping `plan_meals_dish_id_key` cannot make it pass silently. The same is
  true of the "masking" worry about `plan_meals_slot_key`: a unique violation is also uncaught, so the
  test fails, just with a confusing error. Separately, the probe already uses a **free slot**
  (A's fixture meals are `(0, breakfast)` and `(1, dinner)`, `:168-175`; the probe uses `(2, dinner)`)
  plus an existing dish, so the prescribed remedy is already in place and only the comment is stale.
  Acting on the stated premise risks restructuring a working probe, and promoting it to the brief's
  Phase 2 "key risk" crowds out the real one (F2).
- **Fix**: Keep the probe as it stands, replace only its comment (`:597-598`) to say the dropped
  constraint no longer precedes the privilege check and the probe now rests on the revoke alone, and
  demote the item from "Critical Implementation Details" to a one-line note under Phase 2 §6. While
  re-pinning the fixtures, check that the new shared-dish fixture does not occupy `(2, dinner)` on A's
  plan, which is the slot this probe relies on being free.
- **Decision**: FIXED via the single Fix — the "write-revoke probe loses its backstop" item was deleted from **Critical Implementation Details** and the Key Discoveries bullet rewritten to the true behaviour (the trailing `raise exception` is uncaught, so a regressed revoke fails loudly as `P0001`; the probe already uses the free `(2, dinner)` slot with an existing dish); Phase 2 §6 now keeps the probe unchanged, replaces only the comment at `:597-598`, and adds the check that the new fixture leaves `(2, dinner)` free. The plan-brief was left untouched, per the plan.md-only scope.
