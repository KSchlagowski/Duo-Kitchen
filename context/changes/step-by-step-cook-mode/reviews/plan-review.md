<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Step-by-Step Cook Mode (S-11) Implementation Plan

- **Plan**: context/changes/step-by-step-cook-mode/plan.md
- **Mode**: Deep
- **Date**: 2026-10-14
- **Verdict**: REVISE
- **Findings**: 0 critical, 5 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

Overall the plan is well grounded. The per-section currency claim, the "look the stored row up by the lead meal's `mealId`" rule, the `formatSplitLine` context semantics, the Sunday-evening step order, and the smoke windows on `2031-01-20` all check out against the code. The `split-lines.ts` move has no other callers (only `day.astro` and `day-solutions.test.ts`, and both go through the re-export). The findings are about contracts that would fail or mislead as written, not about the approach.

## Grounding

8/8 paths ✓ (`src/types.ts`, `src/lib/services/{recipes,cooking-sessions.fixtures,day-solutions,cooking}.ts`, `src/pages/plan/sessions.astro`, `src/lib/recipe-labels.ts`, `scripts/smoke.mjs`; the new files are absent as expected, and the `plan.astro` + `plan/` folder precedent holds). Symbols 10/11 ✓: `getPlanSolveState`, `buildCookingSessions`, `formatSplitLine`, `formatIngredientAmount`, `formatBatchNote`, `isIsoDate`, `planOf`, `F5`, `S10_SUNDAY_ORDER` and `testIdBody` are all found. `mealLabel` is module-private (see F8). brief↔plan ✓. No `context/foundation/lessons.md` and no `docs/reference/contract-surfaces.md`, so those checks were skipped. Progress↔Phase ✓: four phases match, items 1.1–4.10 cover every success-criteria bullet, and no checkboxes appear in the phase bodies.

## Findings

### F1 — Partner-symmetry check by label swap cannot pass

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 4 §1–2 (`swapViewer`, smoke step 7); Phase 1 §6 ("Viewer relativity")
- **Detail**: Smoke step 7 asserts "B's portion lines equal `swapViewer` of A's", and the plan says this works "as S-04's smoke does". It does not. `formatSplitLine` sorts the viewer's shares first (`viewerFirst()`, `day-solutions.ts:573-575, 654`), so A sees `You: 320 g cooked · Partner: 260 g cooked · You (Tuesday): … · Partner (Tuesday): …` and B sees `You: 260 g cooked · Partner: 320 g cooked · …`. Swapping the labels in A's string gives `Partner: 320 … · You: 260 …`, which is not equal to B's string. S-04's smoke never swaps text: it keys each person's line by a `data-person` attribute (`scripts/smoke.mjs:182-191`). The lines also carry a `Ryż: ` component prefix (per_component recipes), an even-split tail (`split in half`, `split evenly 4 ways`) and, for `all` splits, `All for you` / `All for your partner`. The unit-test bullet "same numbers with You and Partner swapped" has the same gap.
- **Fix A ⭐ Recommended**: Compare parsed share maps, not strings
  - Strength: Keeps `formatSplitLine` and the string view model unchanged. A small smoke helper `portionShares(line)` strips the `<component>: ` prefix, splits on ` · `, maps each `Label(suffix): value` segment to `{ "<label><suffix>": value }`, swaps You↔Partner in the keys (and swaps `All for you` with `All for your partner`), and compares the non-share tail segments verbatim. Phase 1's unit test uses the same normalisation, or compares the A and B views component by component on the swapped maps.
  - Tradeoff: The parsing logic lives in two places (smoke and vitest).
  - Confidence: HIGH — the segment grammar is fixed by `formatSplitLine` (`day-solutions.ts:658-691`).
  - Blind spot: A product name containing ` · ` would break the split. Seed names contain none.
- **Fix B**: Structured portion shares with `data-person` attributes
  - Strength: The page markup is machine-readable, as with S-04's `personLines()`. Symmetry becomes an attribute lookup.
  - Tradeoff: `CookPortionLine` becomes a list of `{ person, suffix, text }` shares, so `formatSplitLine` can no longer be reused as-is. That means a second split formatter, which Key Discoveries says the slice does not need.
  - Confidence: MEDIUM — larger change to the D6/D8 design.
  - Blind spot: Keeping the per-share text byte-identical to the day page is unverified.
- **Decision**: FIXED — Fix A: smoke `portionShares` replaces `swapViewer` (step 7 compares parsed share maps); the viewer-relativity unit test uses the same normalisation

### F2 — Cook mode hides the day page's "check before cooking" warning

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: D3; Phase 1 §3 (`CookModeSection`), §5; Phase 2 §2 (source note)
- **Detail**: D3 treats every current stored status as exact, including `needs_confirmation` (not yet accepted) and `no_fit`, and labels the section `Amounts and portions from the day solve of Monday.` A stored `DaySolution` can carry `boundsViolated: true`. The day page then warns `Some portions break the solver's limits … — check them before cooking.` (`DAY_BOUNDS_WARNING`, `day-solutions.ts:482-483`). Cook mode is exactly where that warning matters, but the view model has no field for it, so those amounts appear unqualified. `getPlanSolveState()` already returns `statuses` beside `currentSolutions` (`day-solutions.ts:325-327`), and `boundsViolated` is on the `DaySolution` the builder already receives.
- **Fix A ⭐ Recommended**: Bounds warning only
  - Approach: add `boundsWarning: boolean` to `CookModeSection`, true when `currentSolutions[sourceDayIndex].boundsViolated`. Render it under the source note as `<p data-testid="cook-bounds-<kind>">` with a link to `/plan/day?start=…&day=<sourceDayIndex>`. Add a new apostrophe-free constant to `cook-mode.ts`, for example `COOK_BOUNDS_WARNING = "Some amounts break the solver limits — check them on the day page before cooking."`. Pin it with one unit test that sets `boundsViolated: true` on a solved fixture.
  - Strength: Uses data already in the builder input, needs no new signature, and closes the safety-relevant gap.
  - Tradeoff: An unaccepted `needs_confirmation` tier still reads as plain "from the day solve", which matches the S-09 shopping-list precedent.
  - Confidence: HIGH — the field is in the stored schema and survives `parseStoredSolution()`.
  - Blind spot: None significant.
- **Fix B**: Bounds warning plus a status-aware source note
  - Approach: Fix A, and also pass `statuses` into `buildCookMode()`. For `needs_confirmation` / `no_fit`, the source note gains a suffix such as `— best fit needs ±15%, not accepted yet`.
  - Strength: The cook sees the same tolerance caveat `/plan` shows.
  - Tradeoff: More strings, more tests, and cook mode diverges from the shopping list's "any status is exact" wording.
  - Confidence: MEDIUM — the wording and smoke impact are not designed yet.
  - Blind spot: Smoke's solved window accepts a looser tier, so whichever state it lands in must be handled.
- **Decision**: FIXED — Fix A: `boundsWarning` on `CookModeSection`, `COOK_BOUNDS_WARNING` in `cook-mode.ts`, `cook-bounds-<kind>` markup with a day-page link, and a unit test

### F3 — Overview ingredient lists lose component grouping

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 §3 (`CookIngredientLine`, `CookEntryOverview.batches[].ingredients`); Phase 2 §2 (Ingredients and portions); Phase 4 smoke step 5
- **Detail**: `CookEntryOverview.batches[].ingredients` is one flat `CookIngredientLine[]` with no component. The curry has `Sól` in all three components (1 g rice, 2 g chicken, 1 g sauce, `macro-solver.fixtures.ts:198-215`), so the overview would list three unlabeled `Sól` lines, and a per-component recipe's portions would sit apart from their ingredients. The day page renders one `<ul>` per component under its name (`day.astro:267-301`). Smoke step 5 ("`cook-entry-ahead-<curry>` holds exactly one ingredient `<ul>`") relies on the flattening, so it would break once grouping is restored.
- **Fix**: Change the overview batch to `components: { componentName: string | null; ingredients: CookIngredientLine[]; portion: string | null }[]` (name set only for `per_component` recipes, as on `/plan/day`), and render one `<ul>` per component. Give each batch block its own `data-testid="cook-batch-<dishId>"` wrapper. Rewrite smoke step 5 as "exactly one `cook-batch-` block inside `cook-entry-ahead-<curryRecipeId>`".
- **Decision**: FIXED — overview batches carry `components[]` (one `<ul>` per component), `cook-batch-<dishId>` wrapper, smoke step 5 rewritten

### F4 — Estimate portions: contract contradicts itself and the stale smoke check is vacuous

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 §3 (`CookStep.portions` comment); Phase 2 §2 (Portions block); Phase 4 smoke step 9
- **Detail**: `CookStep.portions` is documented as "set on the entry's last step in its section; [] lines when estimate". Phase 2 renders the `cook-step-portions` block whenever `portions` is set. On an estimate section the curry's last step would therefore show an empty "Portions" heading, which contradicts the manual check "no You / Partner lines". Smoke step 9 asserts "no `cook-step-portions`", but it loads Sunday evening without `step`, i.e. step 1 (Leczo 601), where `portions` is null anyway. The check passes whatever the estimate rendering does.
- **Fix**: Make `portions` `null` on estimate sections (and on fell-back batches), and update the type comment. Point smoke step 9 at the curry-404 step (`step = S10_SUNDAY_ORDER.indexOf("404") + 1`). Assert there that `cook-step-portions` is absent and that no `You:` / `Partner:` text appears inside the `cook-entry-ahead-<curryRecipeId>` overview block.
- **Decision**: FIXED — `portions` is null on estimate sections and omits fell-back batches (type comment + builder step 4 + unit test); smoke step 9 targets the curry-404 step

### F5 — Three unit-test bullets do not match the fixtures

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §6
- **Detail**:
  - (a) "Per-person component: a `per_ingredient` split (the half-piece bread case)". A single-ingredient half-piece component (Jajecznica *Pieczywo*) solves to `kind: "pieces"`, not `per_ingredient` (`macro-solver.ts:819-829`, pinned at `macro-solver.test.ts:307`). `per_ingredient` is Owsianka *Owoce* (banana + blueberries, `:317`).
  - (b) "No double counting: the curry dish yields one batch block in the whole schedule's cook views, never two". With F5 the curry entry appears in both Sunday evening (make-ahead) and Monday morning (405 fresh), so the schedule has two curry blocks by design.
  - (c) "Same-day double meal: a batch shared by Monday lunch and Monday dinner". `shareDish(F1, [0,"lunch"], [0,"dinner"])` would join curry and Leczo into one dish with two recipes, an inconsistent plan that the RPC rejects with KD017.
- **Fix**: Rewrite the bullets as follows:
  - (a) "Per-person components: Jajecznica *Pieczywo* renders a `pieces` split, and Owsianka *Owoce* renders `per_ingredient` per-person lines."
  - (b) "No double counting: within any one session each plan `dishId` yields exactly one batch block, and Tuesday morning has no curry batch block, only the serving note."
  - (c) "Same-day double meal: build a day with the curry at both lunch and dinner (`day([…, CURRY, …, CURRY])`), then `shareDish(…, [0,"lunch"], [0,"dinner"])`."
- **Decision**: FIXED — the three Phase 1 §6 bullets rewritten as proposed

### F6 — New smoke helpers must strip React text markers

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §3; Phase 4 §1 (`cookSection`, `portionLines`)
- **Detail**: After Phase 3 the step card, its amounts and its portions are server-rendered by React. React inserts `<!-- -->` between adjacent text expressions (for example `{componentName}: {line}`). Phase 4's `portionLines(html)` ("the text of every `<p>`") would then carry those markers into the F1 comparison. `smoke.mjs` already has a stripping helper for exactly this (`:297`).
- **Fix**: In Phase 4 §1, state that `portionLines` and any text extraction reuse the existing marker-and-tag stripping helper at `scripts/smoke.mjs:297`. In Phase 3 §3, render each portion line from one pre-joined string expression.
- **Decision**: FIXED — `portionLines` reuses the stripping helper at `smoke.mjs:297`; Phase 3 §3 renders pre-joined portion strings

### F7 — Island bundle check only inspects one chunk

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 Success Criteria (3.6)
- **Detail**: "Grep `dist/` client chunks for `zod` and `yalps` and find no match in the chunk that contains `CookMode`". Vite splits shared modules into separate chunks that the island chunk imports, so a leak would usually land in a sibling chunk and this check would miss it. Build output is `dist/client` / `dist/server`.
- **Fix**: Reword 3.6 as "no file under `dist/client/` contains `yalps` or zod's `ZodError`". No browser island legitimately uses either today; `ShoppingList.tsx` imports only `shopping-list.ts`.
- **Decision**: FIXED — criterion 3.6 reworded (Phase 3 success criteria and Progress) to "no file under `dist/client/` contains `yalps` or `ZodError`"

### F8 — Small contract gaps: private `mealLabel`, short step ids

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §5 (`formatBatchHeading`); Phase 4 §1–2 (smoke steps 2–4, 6)
- **Detail**:
  - `formatBatchHeading` "reuses the S-10 meal label", but `mealLabel()` is not exported from `cooking-sessions.ts` (`:282-284`).
  - `S10_SUNDAY_ORDER` holds 3-digit suffixes (`"601"`, `"401"`, …), while `data-step-id` is the full uuid. Comparing `S10_SUNDAY_ORDER[1]` with the page's `data-step-id` directly would always fail.
- **Fix**:
  - Phase 1 §5: export `mealLabel` from `cooking-sessions.ts` (or add `formatMealLabel`) and build `formatBatchHeading` from it.
  - Phase 4 §1: compare step ids as `s10Step(S10_SUNDAY_ORDER[i])` (the existing helper at `smoke.mjs:365`), and check Tuesday morning's "no curry step" with `S10_CURRY_STEPS.map(s10Step)`.
- **Decision**: FIXED — export `mealLabel` from `cooking-sessions.ts` for `formatBatchHeading`; smoke compares step ids via `s10Step()` and checks Tuesday with `S10_CURRY_STEPS.map(s10Step)`
