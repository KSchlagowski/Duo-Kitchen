<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Solve a Day's Macros for A and B (S-04)

- **Plan**: context/changes/solve-daily-macros/plan.md
- **Mode**: Deep (codebase verification done inline, against `daf18d6`)
- **Date**: 2026-10-09
- **Verdict**: REVISE
- **Findings**: 0 critical, 5 warnings, 5 observations

The plan is strong. The LP model, persistence pattern, RLS/grant story, FR-020 isolation and phasing are all sound and grounded in the code. Every finding below is a targeted contract gap or edge case. None calls for rethinking the approach. Fixing F1–F5 before `/10x-implement` makes the plan SOUND.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

Grounding: 10/10 existing paths ✓ (new files correctly absent), 12/12 symbols ✓, brief↔plan ✓, Progress↔Phase ✓ (3/3 phases, 6+8 / 8+8 / 7+6 criteria matched, no checkboxes in phase bodies).

The following were checked:

- **Symbols**:
  - `getMealPlan` with the FK-named embeds (`meal-plans.ts:93-95`), `getCurrentHousehold` → `members[].userId` (`household.ts:5-25`) and `isIsoDate`.
  - `macroKcalMismatch(MacroTargetsInput)`.
  - `IngredientRow`/`ComponentRow`/`toNumberOrNull` (`recipes.ts:84-113`). `ProductRow` has no `id` yet; the plan adds it.
  - `roundHalfUp` is private at `recipe-macros.ts:43`; the plan promotes it.
  - `PlanDayIndex`, `MacroTargetsInput`, the `meal_plans_id_household_key unique (id, household_id)` that the composite FK needs (`20261008170000_meal_plans.sql:57`), `maintain` in the revoke list (`:120-122`), the anon probe (`household_isolation.sql:944-956`) and the grant block (`:1150-1190`).
- **Vitest safety**: `macro-targets.ts`, `recipe-macros.ts` and `meal-plans.ts` use only type imports from Supabase, so vitest can import them without Astro virtual modules.
- **Empty-meals save**: `save_meal_plan` upserts the plan row (`:277-281`), so "saving A's plan with zero meals keeps the solution row" holds.
- **Fixtures**: the seed data matches the fixture claims (eggs 200 g / min 50 g, bread and roll half pieces, salt and spices at 1 g steps).

## Findings

### F1 — Post-rounding bounds are undefined, so repair has no checkable contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Assumptions P4, P7, P8; Phase 1 §3 (`macro-solver.ts`) and §4 (assertion "every eater's portion respects the min-amount bound")
- **Detail**:
  - P8 says a repair move "may never cross the minimum amount, one unit, or the P4 scale bounds". The P4 bounds are defined on the LP variable `x[c,p]`, the fraction of one base batch.
  - After P7 rounding there is no single `x[c,p]` any more. Each ingredient of a component is rounded independently (eggs to whole pieces, butter to 5 g, salt to 1 g), so the component's internal proportions drift. Move 1 (±1 unit on one batch ingredient) changes one ingredient only. The per-person share then comes from a 1 % or 10 g-cooked split.
  - The plan never says how the 0.2–1.5× bound, the 3× ratio bound or the per-eater minimum are measured on rounded amounts. Two implementers would write different checks. Different checks give different repair results and therefore different stored numbers.
  - The Phase 1 test "at least 1 egg each in jajecznica" depends on this definition. With a percent split, an eater's eggs = share × batch eggs, which can be 1.9 eggs.
- **Fix A ⭐ Recommended**: Define an *effective scale* after rounding and check every bound against it.
  - Add to P8: `effScale[c,p] = share[c,p] × Σ_i roundedAmount[i] / Σ_i baseAmount[i]`, with mass ratios over the component's ingredients. The per-eater minimum is `share[c,p] × roundedAmount[i] ≥ min_amount_g[i]`. The ratio bound is `effScale[c1,p] ≤ MAX_COMPONENT_RATIO × effScale[c2,p]`.
  - A repair move is legal only if every bound still holds afterwards. Rounding itself may violate a bound, so the first repair pass also accepts moves that reduce the total bound violation, still in the fixed move order.
  - Strength: Every bound becomes testable on the displayed result, and the unit test checks the same quantity the solver enforces.
  - Tradeoff: Adds a "violation first" rule to repair, about 20 lines.
  - Confidence: HIGH — mass ratio is the natural reading of "portion of the base batch" for fixed-proportion components.
  - Blind spot: For components dominated by one heavy ingredient, a mass ratio can hide drift in a light but macro-dense one (butter). This is acceptable, since repair optimises macros directly.
- **Fix B**: Enforce P4 bounds in the LP only, and limit repair to hard per-ingredient rules.
  - Repair checks only: the ingredient minimum per eater, at least one unit, and at most ±1 unit away from the plain rounded value of each ingredient. Document that scale and ratio bounds hold "approximately, within one rounding unit".
  - Strength: Simplest to implement, and the drift cap keeps proportions close to the LP's.
  - Tradeoff: The P4 constants are no longer guaranteed on displayed amounts, and the 3× ratio can be exceeded slightly.
  - Confidence: MED — reasonable, but softer than the plan's current wording promises.
  - Blind spot: The ±1-unit cap may stop repair from reaching ±10 % on F1, so the fallback ratio 3 → 4 may trigger for the wrong reason.
- **Decision**: FIXED — Fix A: P8 defines effScale (mass ratio) and measures the scale, ratio and per-eater min bounds on rounded amounts; repair first reduces bound violations; the Phase 1 §4 min-amount assertion is reworded to match

### F2 — Per-person rounding of a mixed component (Owsianka "Owoce": banana + blueberries) is unspecified

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Assumption P7 ("Exception"); Phase 1 §2 (`DaySolution.components[].split`) and §6 (split line "pieces: You: 2 pcs · Partner: 1½ pcs")
- **Detail**:
  - P7 rounds a whole component per person when it contains any `allow_half_pieces` ingredient. The seed has such a component that also has a gram ingredient: Owsianka `Owoce` (`5eed0003-…0202`) = banana 120 g (half pieces) **+ blueberries 100 g (grams, step 10)**, from `20261007120100_seed_products_and_recipes.sql`, ingredients `…020201`/`…020202`.
  - The split DTO has one `kind`/`value` per eater, and the rendered "pieces" line shows only piece counts. The plan does not say:
    - how the blueberries are split and shown;
    - whether the "pieces" value counts banana pieces or the component;
    - how totals are computed for the gram ingredient of a per-person component.
  - F1 and F4 both contain Owsianka, so the implementer hits this on the first fixture. Jajecznica `Pieczywo` and Twarożek `Pieczywo` are single-ingredient components and are unaffected.
- **Fix A ⭐ Recommended**: Make per-person components list every ingredient per eater.
  - Add a split kind `"per_ingredient"`. For a component containing an `allow_half_pieces` ingredient, every ingredient carries `perPerson[userId]` amounts: pieces rounded per P7 for the piece ingredient, step rounding (with the below-one-step rule) for gram ingredients. The batch amount is their sum.
  - The rendered split line is `You: 1 pc banana + 50 g blueberries · Partner: ½ pc banana + 40 g blueberries`. A single-ingredient piece component keeps the short form `You: 2 pcs · Partner: 1½ pcs`. Totals use `perPerson` directly.
  - Strength: Exact. It matches how a served fruit topping is actually portioned, and totals need no share arithmetic.
  - Tradeoff: One more split kind and render branch, plus a fixture assertion.
  - Confidence: HIGH — the `perPerson` field already exists in the DTO sketch, so this only completes it.
  - Blind spot: For S-07 user recipes, a mixed component with many gram ingredients gives a long split line. That is acceptable for now.
- **Fix B**: Narrow the exception to the piece ingredient only.
  - Only the `allow_half_pieces` ingredient is rounded per person. The rest of the component is batch-rounded and split by percent, so two split lines are shown for that component.
  - Strength: Reuses the percent split.
  - Tradeoff: Two split lines for one component confuse the reader, and the "pieces" split and the percent split can disagree on who eats more.
  - Confidence: MED.
  - Blind spot: How the repair moves interact with a half-per-person, half-batch component.
- **Decision**: FIXED — Fix A: P7 gives every ingredient of a half-piece component `perPerson` amounts; new split kind `per_ingredient` in the DTO, its render line in Phase 1 §6, and a fixture assertion for Owsianka `Owoce`

### F3 — "Accept ±N%" silently re-solves current inputs, so the user can accept numbers they never saw

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Assumption P2/P3; Phase 2 §4 (`POST /api/plan/solve` flow) and §5 (Accept form)
- **Detail**:
  - The Accept form posts only `start_date`, `day_index` and `accept_tolerance`. The route reloads the inputs, re-solves and stores the result.
  - When the stored result is stale (the partner edited the day or their targets), clicking **Accept ±15%** stores a *different* solution as `solved`. The user confirmed a looser tolerance for numbers they never saw. FR-019 says "escalates … on user confirmation", and this undermines what that confirmation means. The page even shows the Accept button next to the stale banner, because Phase 2 §5 does not hide it when the result is stale.
  - Conversely, every **Solve again** posts the default `accept_tolerance=10`. Re-solving an unchanged, already-accepted day therefore drops it back to `needs_confirmation`.
  - P2's claim "accepting ±15 % re-runs the same solve and gets the same numbers" holds only when the inputs are unchanged.
- **Fix A ⭐ Recommended**: Bind the acceptance to the fingerprint the user saw.
  - Add a hidden `fingerprint` field to the Accept form, filled from `stored.inputFingerprint`, and validate it in zod with `/^[0-9a-f]{64}$/`.
  - In the route, after computing the current fingerprint, if `accept_tolerance > 10` and the posted fingerprint ≠ current, do not store anything. Redirect with a new message: "The day changed since you looked — review the new result before accepting." Then show the stale result as the plan already does.
  - Hide the Accept button while `stale` is true.
  - Optionally, for **Solve again** on an unchanged fingerprint, carry forward the stored `accepted_tolerance_pct`.
  - Strength: The confirmation always refers to the displayed numbers. No schema or RPC change, and one extra smoke assertion is possible.
  - Tradeoff: One more message and a hidden field.
  - Confidence: HIGH — the fingerprint is already computed on both sides.
  - Blind spot: None significant.
- **Fix B**: Accept without re-solving.
  - Add `public.accept_day_solution(p_start_date, p_day_index, p_tolerance, p_fingerprint)`. It updates only `status` and `accepted_tolerance_pct` of the stored row `where input_fingerprint = p_fingerprint` and raises a new KD015 otherwise.
  - Strength: Accept becomes a pure status flip, and the numbers cannot change at all.
  - Tradeoff: A second definer RPC, a new SQLSTATE, and more grant, anon-probe and rejection tests in `household_isolation.sql`. It also duplicates the tier logic in SQL, because the RPC must check `requiredTier <= tolerance` from the jsonb.
  - Confidence: MED.
  - Blind spot: The jsonb shape becomes something SQL depends on.
- **Decision**: FIXED — Fix A: hidden `fingerprint` on the Accept form (zod-validated); on a mismatch the route stores nothing and redirects with `DAY_CHANGED_BEFORE_ACCEPT`; Accept hidden while stale; Solve again carries forward the accepted tolerance on an unchanged fingerprint; P2 and smoke step 8 updated

### F4 — Contracts lack a pure "is this day solvable?" check and the route's no-plan path

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 §3 (`getDayView`: "an unsolvable current input also counts as stale"), Phase 2 §5 ("The page never computes a result it does not store"), Phase 3 §1 (`getPlanSolveStatuses` kind `"unsolvable"`, "does not re-solve"), Phase 2 §4 (route flow step 1)
- **Detail**:
  - The only exported way to learn that inputs are unsolvable is `solveDay()`, which also runs the full LP, rounding, repair and up to 5 leave-one-out solves. The day page and `/plan` must classify days as unsolvable yet are told never to solve, so the implementer must either break that rule or invent an unlisted export.
  - Separately, the solve route's flow says "Load the inputs" without handling `loadDaySolveInputs` returning `null` (no plan for the date). "Invalid fields redirect to `/plan?error=…` when the date is unknown" mixes up a malformed date with a missing plan, and the RPC's KD014 is then the only guard.
- **Fix**: Make three edits to the contracts:
  - Add `checkSolvable(input): UnsolvableReason | null` to the `macro-solver.ts` contract. `solveDay` calls it first, and `getDayView`/`getPlanSolveStatuses` call it instead of `solveDay`.
  - In Phase 2 §4, add the step "`null` (no plan for that date) → redirect to `/plan?start=<date>&error=` + `DAY_SOLVE_ERRORS.KD014`" before solving.
  - Reword "date is unknown" to "the date is malformed".
- **Decision**: FIXED — Fix: `checkSolvable(input)` added to the solver contract and used by `getDayView`/`getPlanSolveStatuses`; route step 1 handles `null` with the KD014 message; "unknown" → "malformed"; the performance note is aligned

### F5 — P14 creates a second label map, against the "single map S-14 localises" rule

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Assumption P14; Phase 1 §5 (`UNSOLVABLE_MESSAGES`, `formatDaySolveSummary` in `day-solutions.ts`)
- **Detail**:
  - CLAUDE.md (S-05 bullet) says: "every enum label lives in `src/lib/recipe-labels.ts`, the single map S-14 localises". The research (§8) also routes S-04 labels through `recipe-labels.ts`.
  - P14 instead puts the labels "in one map in the solver service". That is a second localisation map, and P14 does not even agree with Phase 1 §5 on where it lives (the pure `macro-solver.ts` or `day-solutions.ts`).
  - New enums such as macro names (fat/protein), directions (too much/too little), split kinds and solve statuses would end up outside the single map.
- **Fix**:
  - Change P14 to: "Enum labels (macro names, over/under phrasing, split-kind words, `DaySolveStatus` labels) go in `src/lib/recipe-labels.ts`. Sentence templates (`formatDaySolveSummary`, `UNSOLVABLE_MESSAGES`, `DAY_SOLVE_ERRORS`) live in `day-solutions.ts`, next to the logic, like `formatPlanSummary`. `macro-solver.ts` returns codes only, never display text."
  - Mention `recipe-labels.ts` in the Phase 3 CLAUDE.md bullet.
- **Decision**: FIXED — Fix: P14 rewritten as proposed; `recipe-labels.ts` added to the Phase 1 §5 files and the Phase 3 CLAUDE.md bullet

### F6 — The no-fit reason names the day's worst macro, which may have nothing to do with the named recipe

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Assumption P10 step 4; Phase 1 §4 (F2 expects macro `fat`)
- **Detail**:
  - P10 picks the recipe by leave-one-out, but takes the reason from "the worst rounded deviation in the full-day result". The two are computed independently.
  - The output can read "Most obstructive recipe: Leczo z kiełbasą (too little protein)", even when removing Leczo mostly fixed fat. The research (§9) tied the reason to "that dish's share of that macro", and the plan dropped that link.
  - The F2 unit test pins `fat`, so a mismatch would show up as a confusing test failure, not as a design question.
- **Fix**: In P10 step 4, take the macro from leave-one-out. Pick the `(person, macro)` whose LP deviation improved most between the full-day solve and the solve without the blamed meal. Take the direction from that deviation's sign in the full-day result. Ties go to people by user id, then macros in the order kcal, protein, fat, carbs. This costs no extra solves, because both LP results are already computed.
- **Decision**: FIXED — Fix: P10 step 4 takes the macro and direction from leave-one-out, with the deterministic tie-break; the F2 fixture expectation now points to P10 step 4

### F7 — Rounding `maxDeviationPct` to 0.1 breaks the "rounded ≥ LP optimum" invariant at the boundary

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Assumption P9; Key Discoveries ("A day with `t*` > 10 % can therefore never round down into ±10 %"); Phase 1 §4 (invariant assertion)
- **Detail**:
  - P9 rounds the worst deviation half-up to 0.1 before choosing the tier. A raw worst deviation of 10.04 % shows as 10.0 % and gets tier 10, even when `t*` = 10.02 %.
  - That is a defensible product choice (the tier follows the displayed value), but it contradicts the Key Discovery sentence. The invariant test "rounded `maxDeviationPct` ≥ `t*`" can then fail spuriously.
- **Fix**:
  - Have the invariant test compare the **unrounded** worst deviation, exposed on the same test-only path as `t*`, against `t*`.
  - Reword the Key Discovery to "…can never reach a deviation below `t*`; the tier uses the value rounded to 0.1, as displayed".
- **Decision**: FIXED — Fix: the invariant test compares the unrounded worst deviation with `t*`; Key Discovery and Critical Implementation Details reworded

### F8 — Phase 3 status texts and prompt condition leave two cases open

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §1 (status testid `day-status-<n>` texts; "prompt banner for every day that has all 5 meals and no current solution")
- **Detail**:
  - The status list has only `Solved within ±10%`, but a day accepted at ±15 or ±20 % is stored as `solved` too. Phase 2's manual check expects `Solved within ±N%` on the day page.
  - "No current solution" is not defined for a fresh `needs_confirmation` or `no_fit` row, or for a full day whose inputs are unsolvable (for example, the partner has no targets). The prompt may keep nagging or vanish, depending on the reading.
- **Fix**:
  - Replace the status text with `Solved within ±N%`, where N = `requiredTier`.
  - Define "current solution" as `stored !== null && !stale`, whatever its status. State that the prompt is not shown for `unsolvable` days, which show `Can't solve yet — see day` instead.
  - Add a unit-level or smoke assertion that an accepted day reads `Solved within ±N%` on `/plan` (smoke step 8 can check `day-status-2`).
- **Decision**: FIXED — Fix: status text is `Solved within ±N%` (N = `requiredTier`); "current solution" is defined as `stored !== null && !stale`, with no prompt for unsolvable days; smoke step 8 asserts `day-status-2` on `/plan`

### F9 — Smoke steps rely on helpers that cannot read the planned markup as written

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §2, steps 4–6 and 9; Phase 1 §6 (testids)
- **Detail**:
  - `scripts/smoke.mjs` reads text only through `testIdText()`/`testIdBody()`, which match a single `<p …data-testid=…>…</p>` and return the **first** match (`smoke.mjs:69-72, 110-112`).
  - `day-person` occurs once per person, so step 4's "capture the full `day-person` lines" needs every match.
  - Step 6 compares A's "You" line with B's "Partner" line, but each line starts with its own label (`You · 2190 kcal …`), so the strings never match verbatim.
  - The plan does not say which element carries the testids.
- **Fix**:
  - In Phase 1 §6, state that `day-solve-summary`, `day-person`, `day-status-<n>` and `day-prompt-<n>` text sits in a `<p>`.
  - Render `day-person` as `<p data-testid="day-person" data-person="you|partner">`.
  - In Phase 3 §2, add a `testIdTexts(body, id)` helper (global regex, all matches), and compare lines after stripping the leading `You · ` / `Partner · ` label, or select by `data-person`.
- **Decision**: FIXED — Fix: Phase 1 §6 puts testid text in a `<p>` and adds `data-person` to `day-person`; Phase 3 §2 adds `testIdTexts()` and label-stripped comparison (step 6 reworded)

### F10 — vitest version is unpinned against Astro 7's Vite 8

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 §1 (dependencies and test runner); P13
- **Detail**:
  - The repo resolves `vite@8.3.0`, through `astro@7` → `vite ^8.0.13`.
  - Older vitest majors declare peer ranges without Vite 8. Depending on the version, `npm install vitest` either pulls a second Vite copy or fails peer resolution under `npm ci` in CI.
  - The plan names no version.
- **Fix**:
  - In Phase 1 §1, add: "Install a vitest release whose `peerDependencies.vite` includes `^8` (check with `npm view vitest peerDependencies`). Confirm `npm ls vite` shows a single deduped `vite@8.x`."
  - Keep `vitest.config.ts` free of `getViteConfig()`. The solver modules use only type imports, so no Astro virtual modules are needed (verified for `macro-targets.ts`, `recipe-macros.ts` and `meal-plans.ts`).
- **Decision**: FIXED — Fix: Phase 1 §1 requires a vitest release whose peer range includes `vite ^8`, an `npm ls vite` dedupe check, and no `getViteConfig()`
