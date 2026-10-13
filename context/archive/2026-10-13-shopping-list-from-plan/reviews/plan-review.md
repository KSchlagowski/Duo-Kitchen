<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Shopping List from the Plan (S-09)

- **Plan**: context/changes/shopping-list-from-plan/plan.md
- **Mode**: Deep (claims verified inline against the code; no sub-agent)
- **Date**: 2026-10-13
- **Verdict**: REVISE
- **Findings**: 1 critical, 4 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | WARNING |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | FAIL |
| Plan Completeness | WARNING |

## Grounding

16/16 paths ✓. 10/11 symbols ✓: `getMealPlan`, `getPlanSolveStatuses` (`day-solutions.ts:307`), `parseStoredSolution` (`:192`), `formatPlanDayStatus` (`:398`), `joinList` (`:423`), `getSolverRecipes` (`recipes.ts:230`), `formatIngredientAmount` (`recipe-macros.ts:62`), `testIdBody` (`smoke.mjs:113`), `batch.dishId` = the plan's `dishId` (`macro-solver.ts:989-997`), KD018/KD019 unclaimed. ✗ `save_day_solution` was dropped by S-08 (F6). brief↔plan ✓. Progress↔Phase ✓: 5/5 phases and 46/46 criteria matched, no checkboxes in the phase bodies. `getPlanSolveStatuses()` has one caller (`src/pages/plan.astro:91`), so the refactor has a small blast radius. No `context/foundation/lessons.md` and no `docs/reference/contract-surfaces.md`.

The design is sound overall. It reuses the currency rule instead of copying it, dedups by the plan's `dishId`, derives the list instead of storing it, and uses a write-revoked table with a definer RPC. The findings are about test fixtures and the string/markup contracts, not about the approach.

## Findings

### F1 — Smoke and manual checks assume the 2031-01-20 plan is still solved and shared, but the S-08 section leaves it stale and unshared

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 5 §1 "Solved plan with a shared batch"; Phase 3 manual 3.10; Phase 5 manual 5.10
- **Detail**: Phase 5 adds an S-09 smoke section that "runs after the accounts are linked and the S-08 plan exists" and asserts that `/plan/shopping?start=2031-01-20` "(solved in the S-08 section) shows the exact note naming Monday and Tuesday". The S-08 section does not leave the plan in that state. After solving (`scripts/smoke.mjs:856-880`) it goes on to:
  - make B's eater-only edit, after which both days are out of date (`:906-914`);
  - un-share Tuesday's lunch (`:916`) and re-share it (`:930`);
  - swap Monday's lunch to *Leczo* (`:938-946`), which drops the share ("the dropped share has no batch note", `:948-951`).

  When an S-09 section placed after it runs, 2031-01-20 has no shared batch and no current solve, so the exact-note assertion fails and the "counted once" assertion tests nothing. Manual step 3.10 ("the smoke S-08 plan where Tuesday lunch shares Monday's curry batch") and step 5.10 ("confirm each product appears once with the exact-amounts note") rely on the same wrong state.
- **Fix A**: Give S-09 its own solved shared-batch plan (e.g. `2031-02-10`), built with a copy of `shareForm()`. Solve it the way the S-08 step at `:856-875` does (accept a looser tier if offered), then assert the exact note and that no `item-<id>` testid appears twice.
  - Strength: S-09 does not depend on S-08's step order, and 5.10 can open that date afterwards.
  - Tradeoff: one more LP solve per smoke run (CPU on the preview, a few seconds), and the "accept looser tier" helper gets duplicated or must be extracted.
  - Confidence: HIGH — every step uses an existing pattern.
  - Blind spot: none significant.
- **Fix B ⭐ Recommended**: Insert the S-09 solved-batch assertions into the S-08 sequence, right after "A plan page shows both days of the group with one identical status" (`smoke.mjs:876-880`), while the group is solved and shared. Add one more assertion after "both days of the group are out of date" (`:910-914`): both days move to the estimate note. That covers manual step 3.11's stale fallback over HTTP for free. Rewrite manual steps 3.10 and 5.10 to build the share by hand (`/plan`, Tuesday lunch "shares batch with Monday lunch", then Solve Monday) instead of relying on the smoke account's final state.
  - Strength: no extra solve; it asserts both the exact state and the stale fallback at exactly the points where they hold.
  - Tradeoff: S-09 steps are interleaved with S-08's, so a future edit to S-08 must keep them in place (leave a comment there).
  - Confidence: HIGH — the step list is a flat array, and inserting steps is how the earlier slices added theirs.
  - Blind spot: the S-09 page also needs the item count of that state, which the exact path cannot pin from SQL. Assert structure only (no duplicate ids), as the plan already intends.
- **Decision**: FIXED — Fix B: shared-batch assertions moved into the S-08 smoke sequence (solved+shared after `:876-880`, stale fallback after `:910-914`, with keep-in-place comments); manual 3.10/5.10 rewritten to a hand-built solved 2031-02-10 share; Progress 3.10/5.10 titles updated.

### F2 — The isolation-test fixtures contradict the cross-household probe and leave required fixtures unstated

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §2 "Isolation test"
- **Detail**: The plan says "A and B each get one check row on their own plan… Use an unused start date such as `2030-06-01`", and also "B calling with A's start date gets KD014 (B has no plan there)". Those two cannot both hold if both fixture plans use the same date, which is how the existing fixtures do it (`household_isolation.sql:158-159`: A and B both at `2030-01-01`). Two more fixtures go unstated:
  - The RPC behaviour block needs a plan with **dishes**. "Checking a product used by the plan succeeds" and KD019 both depend on recipe ingredients, but the plan never says how the 2030-06-01 plan gets meals.
  - The redemption assertion needs a check row on the **redeemer's** pre-redemption plan, which no fixture creates.

  The `plan_day_solutions` precedent avoids all of this by using an A-only RPC-saved plan (`2030-05-01`, `:979`) for the behaviour and KD blocks and probing B with that date (`:1202-1222`).
- **Fix**: Spell out the fixtures in Phase 1 §2:
  1. Read-isolation rows go on the existing `…a007` / `…b007` fixture plans (2030-01-01), inserted as postgres.
  2. The RPC behaviour and KD blocks use an A-only plan created with `public.save_meal_plan('2030-06-01', …)`, with one meal of seed recipe `5eed0002-…-0001`. The "used product" is any `product_id` of that recipe. The "unused product" is a seed product the recipe does not use, found with a `not exists` query rather than a hard-coded id.
  3. The cross-household probe calls the RPC as B with `2030-06-01`.
  4. The redemption block inserts (as postgres) one check row on the redeemer's pre-redemption plan before redeeming, and asserts afterwards that its `household_id` is unchanged.
- **Decision**: FIXED — Fixtures spelled out in Phase 1 §2: read rows on `…a007`/`…b007` (2030-01-01), A-only RPC-saved 2030-06-01 plan with seed recipe `5eed0002-0000-4000-8000-000000000001` and a `not exists`-found unused product, B probed with 2030-06-01, redeemer pre-redemption check row asserted unchanged.

### F3 — In a solved group, a same-day shared batch has two stored meals that match the plan's "take one stored meal" rule

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Critical Implementation Details "State sequencing"; Phase 2 §3 Rules, §5 Unit tests
- **Detail**: The rule says to take a current dish's ingredients from "the meal whose `batch?.dishId === dishId`, on the day `batch.cookDayIndex`". When one dish feeds two meals of the **same** day (lunch + dinner from one batch, allowed since S-08), both stored meals on that day carry the same `batch.dishId` and the full batch `amountG` (`macro-solver.ts:989-997`). The rule as worded matches two meals, so an implementation that filters and sums the matches double-counts. The unit-test list covers the same-day case only **unsolved** ("One dish eaten at two meals of one day (one dish, unsolved)"), where base amounts are used and the bug cannot show.
- **Fix**: Reword the rule as "build a `Map<dishId, DaySolutionMeal>` from the current solutions, keeping the **first** stored meal for each `batch.dishId` (or for each plan `dishId` of a null-batch meal); never sum across matches". Add a unit case: "One dish eaten at lunch and dinner of one **current** day, counted once at the stored amount".
- **Decision**: FIXED — Rule reworded to a first-wins `Map<dishId, DaySolutionMeal>` (never filter-and-sum); unit case added for one dish at lunch and dinner of one current day.

### F4 — The source notes' wording and markup contradict A2 and can't be matched by smoke's `<p>` helper

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Decision A2; Phase 3 §2 (`formatExactNote`, `formatEstimateNote`), §3 "Header and notes"; Phase 5 §1
- **Detail**: There are two problems.
  1. A2 counts `needs_confirmation` and `no_fit` rows as exact, and promises "The page note still distinguishes 'solved' from 'best fit not yet accepted' through `formatPlanDayStatus()` wording". But `formatExactNote(weekdays)` takes no status and prints `Exact amounts from the solved ${days}.`, so a day with an unaccepted ±20 % best fit, or no fit at all, is called "solved". No phase delivers the promised distinction.
  2. Phase 3 renders `<p data-testid="shopping-estimate">` with each weekday as a link to `/plan/day`, plus status text next to it. The plain string `formatEstimateNote(weekdays)` is what smoke pins, and `testIdBody()` (`smoke.mjs:113`) matches `\s*<text>\s*</p>`. Neither the string nor the helper fits markup with nested `<a>` and status spans.
- **Fix A ⭐ Recommended**: Split the text from the links.
  - Keep `shopping-exact` and `shopping-estimate` as plain-text `<p>` elements, with the exact note reworded to `Exact amounts from the day solve of ${joinList(weekdays)}.` so it no longer claims "solved".
  - Below them, render one `<li data-testid="shopping-day-<n>">` per non-empty day: the weekday linked to `/plan/day?start=…&day=n`, then `formatPlanDayStatus(statuses[n])`. That shows "Needs ±20% — open to accept" and "No fit within ±20%" exactly as `/plan` does.
  - Smoke pins the `<p>` notes with `testIdBody()` and each day line with the new `testIdItem()` helper.
  - Strength: A2 is kept, it reuses the existing status strings, and smoke can match everything with existing or planned helpers.
  - Tradeoff: one more small list on the page.
  - Confidence: HIGH — every piece already exists (`formatPlanDayStatus`, `joinList`, the `testIdItem` the plan already adds).
  - Blind spot: none significant.
- **Fix B**: Narrow A2 so only `solved` counts as exact, and treat `needs_confirmation` and `no_fit` as estimates. "Solved" is then true. The estimate-note links still need splitting out of the pinned `<p>`, as in Fix A.
  - Strength: the word "solved" means exactly what it says, and the exact set is smaller.
  - Tradeoff: it overturns A2's reasoning (rounded best-fit amounts predict the cook better than base batches), and a household that never accepts a looser tier shops on estimates.
  - Confidence: MED — a product call the user owns.
  - Blind spot: how often seed plans land in `needs_confirmation` is not measured. Smoke shows S-04's 4-meal day needs ±15/20 %, so it is common.
- **Decision**: FIXED — Fix A: exact note reworded to `Exact amounts from the day solve of …`; notes are plain-text `<p>`; per-day `<li data-testid="shopping-day-<n>">` lines carry the link and `formatPlanDayStatus()`; A2, Desired End State, manual steps and smoke pins updated.

### F5 — The island needs the display helpers client-side, but Phase 3 leaves them in an undecided I/O module

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 §2 (file choice "the implementer picks one"); Phase 4 §2 Props, §3
- **Detail**: Phase 4 moves `<p data-testid="shopping-summary">` into the island "so its count updates live". The island also shows `SHOPPING_SAVE_FAILED` and per-item amounts. That means `formatShoppingSummary`, `SHOPPING_SAVE_FAILED` and `formatShoppingAmount` must run in the browser. Phase 3 §2 defines them in the I/O service, whose file is left to the implementer, and that service imports `day-solutions.ts`. If the island imports it, `day-solutions` → `macro-solver` (`yalps`), zod and the solver all ship to the client. If it doesn't, the smoke-pinned summary template gets copied into the `.tsx`, and the two copies can drift. The `labels` prop is also unspecified: which strings, keyed how?
- **Fix**: Decide the split in Phase 2/3.
  - `src/lib/services/shopping-list.ts` is pure (imports only `@/types`, `recipe-macros`, `recipe-labels` and `joinList`, or a copy of it). It holds `buildShoppingList`, `STORE_AISLES`, every `format*` string helper and the `SHOPPING_*` message constants.
  - A sibling `src/lib/services/shopping.ts` holds only the Supabase reads, the RPC call and `shoppingErrorMessage()`.
  - The island imports only from `shopping-list.ts`.
  - `labels` becomes `{ aisles: Record<StoreAisle, string> }`. Amounts are formatted in the island with `formatShoppingAmount`.
  - Note that `joinList` currently lives in `day-solutions.ts` (`:423`). Move it to a pure module, or import it only in the pure file if that does not pull the solver in.
- **Decision**: FIXED — Pure `shopping-list.ts` holds builder, all format helpers and SHOPPING_* constants; new `shopping.ts` holds reads, RPC and `shoppingErrorMessage()`; `joinList` moves to `src/lib/utils.ts`; island imports only the pure module; `labels` = `{ aisles: Record<StoreAisle, string> }`.

### F6 — Stale reference to `save_day_solution`, and an unneeded sub-block for KD018

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1 RPC steps 1–2
- **Detail**: Step 1 says "Resolve the household as in `save_day_solution`". S-08 dropped that function (CLAUDE.md), and the live template is `save_plan_day_solutions` (`20261011120000_shared_dishes.sql:340-344`). Step 2 wraps three `is null` checks in "its own sub-block that relabels unexpected errors, as KD013 does". KD013 needs that block because it walks client jsonb (`:346-400`). Three scalar null checks cannot raise anything unexpected.
- **Fix**: Change step 1 to "as in `save_plan_day_solutions` (`shared_dishes.sql:340-344`)". Change step 2 to a plain `if p_start_date is null or p_product_id is null or p_checked is null then raise … using errcode = 'KD018'`, with no sub-block.
- **Decision**: FIXED — Step 1 now references `save_plan_day_solutions` (`shared_dishes.sql:340-344`); step 2 is a plain null check raising KD018, no sub-block.

### F7 — Smoke's `request()` cannot send an `Accept` header, and the JSON-mode POST changes state

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 5 §1 Check-off ("A JSON-mode POST (`Accept: application/json`) returns `200`")
- **Detail**: `makeClient().request(path, { method, form })` (`smoke.mjs:46-64`) sets only `Cookie`, `Origin` and `Content-Type`, so there is no way to send `Accept: application/json` without changing the helper. The JSON-mode POST also really checks or unchecks an item. Unless it is sequenced deliberately, it changes the `checked` count and `data-checked` state that the neighbouring steps assert.
- **Fix**: Add a `headers` option to `request()` that is merged after the defaults. Make the JSON-mode step a check of a second product, followed by a JSON uncheck of it, each asserting `200` with `check:` parsing `{"ok":true,"checked":…}`. Place both after the cross-partner steps, so the pinned product's final unchecked state (manual 5.10) is unaffected.
- **Decision**: FIXED — `headers` option added to smoke `request()`; JSON mode is a check then uncheck of a second product after the cross-partner steps, each asserting `200` and `{"ok":true,"checked":…}`.
