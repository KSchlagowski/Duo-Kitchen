<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Solve a Day's Macros for A and B (S-04)

- **Plan**: context/changes/solve-daily-macros/plan.md
- **Scope**: Full plan — Phases 1–3 of 3 (commits f15f9ef, ab39035, 9620dab, f90cb80)
- **Date**: 2026-10-09
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 6 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

### Success criteria evidence (re-run during this review)

| Command | Result |
|---|---|
| `npm test` | PASS — 45/45 tests (vitest 5.0.3) |
| `npm run lint` | PASS — no output |
| `npx astro check` | PASS — 0 errors, 0 warnings, 0 hints (55 files) |
| `npm run build` | PASS — Complete (only the existing sitemap `site` warning) |
| `npx prettier --check CLAUDE.md README.md` | PASS |
| `npm run test:rls` | PASS — "all assertions passed (… meal plans and day solutions)" |
| `npm run test:seed` | PASS — "seed_integrity: all assertions passed" |
| `npx supabase migration list --linked` | `20261009120000` is applied to the remote (2.1) |
| `npm run smoke` | **Not re-run**: it signs up real accounts on the hosted project. Recorded as passing at 9620dab (3.6). |

Manual rows 1.7–1.14, 2.9–2.16 and 3.8–3.13 are unchecked. Manual testing is deferred to the user, so they are pending, not missing.

Every file in the plan's "Changes Required" is in the diff. No planned item is missing. Nothing on the "What We're NOT Doing" list was touched: `save_meal_plan` and the plan tables are unchanged, there is no island, no dashboard line and no library migration.

## Findings

### F1 — The stored solve result is trusted without validation when it is read

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/day-solutions.ts:100 (also supabase/migrations/20261009120000_plan_day_solutions.sql:131-136, src/pages/plan/day.astro:159-237)
- **Detail**:
  - `save_day_solution` checks only that `p_result` is a jsonb object under 64 KB. The isolation test itself stores `'{"version":1}'`.
  - `getDaySolution` casts the row to `DaySolution` with no shape check.
  - Any household member can call the RPC directly. They can store an arbitrary status and arbitrary quantities with a matching fingerprint, since every fingerprint input is readable to them and `SOLVER_VERSION` is public. The fake result then looks current to their partner.
  - A malformed result makes `/plan/day` render `solution.people.map(...)` outside any `try`. The day returns 500 for both partners until someone solves again.
  - The reach is limited to the caller's own household, so this is not a breach between households. But S-08, S-09 and S-11 are meant to consume this jsonb "and never re-derive quantities", so the blast radius grows with each later slice.
- **Fix A ⭐ Recommended**: Validate on read. Add a zod schema for `DaySolution` (version 1) in `day-solutions.ts`, parse it in `getDaySolution` and `getPlanSolveStatuses`, and treat a row that fails as stale/unsolved (log it with `console.error`). Add a CLAUDE.md line that the stored result is client-assertable and every consumer must read it through this validator.
  - Strength: protects every current and future consumer at one choke point, and a corrupt row becomes recoverable ("Solve again") instead of a 500.
  - Tradeoff: one schema to keep in sync with the `DaySolution` type; small parse cost per read (at most 3 rows on `/plan`).
  - Confidence: HIGH — zod is already the boundary validator across the API routes.
  - Blind spot: it does not stop a partner storing well-formed but invented numbers. That is accepted, given that the trust boundary is the household.
- **Fix B**: Also harden the RPC with a structural check inside the KD013 sub-block: `(p_result->>'version') = '1'`, and `p_result ? 'people'` / `? 'meals'` with `jsonb_typeof(...) = 'array'`. Add KD013 probes for it to `household_isolation.sql`. This is on top of Fix A, not instead of it.
  - Strength: rejects garbage at the write, so other readers (SQL, future jobs) never see it.
  - Tradeoff: needs a new migration plus `db push` before merge; a partial check in SQL duplicates the TS type.
  - Confidence: MED — it catches gross malformation only, not deep shape errors.
  - Blind spot: whether S-09/S-11 will read the jsonb in SQL at all.
- **Decision**: PENDING

### F2 — A rounded result that still breaks a hard bound is stored as "Solved"

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/macro-solver.ts:503-512 (`improves`), :557-581 (`repair`), :304-316 (`roundingWindow`)
- **Detail**:
  - P8 says rounding may violate a bound and that repair first reduces the total violation.
  - Repair moves are additionally confined to each amount's floor/ceil "rounding window" (an addition not in the plan, see F7). Repair stops at 50 moves or at a local minimum.
  - So a day can end with `evaluation.violation > 0`: a portion below `min_amount_g`, an effScale outside 0.2–1.5, or a component more than 3× another. Nothing reports this.
  - The tier is judged only on `evaluation.max`, so such a day can be saved as `Solved within ±10%`.
  - The unit tests check the bounds on F1–F4 only (`macro-solver.test.ts:187-223`). User recipes in S-07 will not be covered.
- **Fix**: Return the final `violation` in the solver diagnostics. If it is above `EPSILON`, either cap the outcome at `requiredTier = null` with a dedicated explanation, or add a `boundsViolated: true` flag to `DaySolution` that the day page renders as a warning. Add a unit test asserting `violation === 0` for F1–F4, plus a synthetic recipe that forces a violation.
  - Strength: the stored "solved" status then means what the plan promises (P4/P8 bounds hold).
  - Tradeoff: one more field in the persisted jsonb (it is versioned, so bump `SOLVER_VERSION`), or a stricter tier that can turn borderline days into no-fit.
  - Confidence: MED — the code path is clear, but whether the seed library can ever hit it is unmeasured.
  - Blind spot: how often violations survive repair on real user recipes.
- **Decision**: PENDING

### F3 — Plan premises the implementation disproved are not recorded in the plan

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/services/macro-solver.test.ts:244-253 and :84-92; plan.md:58, :166, :242-243, :256
- **Detail**:
  - **"Rounded ≥ t\*" is false.** The plan states that "any rounded solution is a feasible LP point", so the rounded deviation can never beat `t*`. The implementation found this wrong: rounding each ingredient on its own shifts a component's proportions, and the LP holds them fixed. F3 lands 0.4 points under `t*`.
    - The test was relaxed to `worstDeviation >= lpOptimum - 0.01`.
    - Consequence: F3's escalation expectation ("cannot reach 10 %") and smoke step 8 now rest on the observed result, not on the stated guarantee. A day with `t*` slightly above 10 % can also legitimately store as ±10 %.
  - **The F2 reason macro differs.** The plan expects `fat`; the code (correctly applying P10 step 4) yields `carbsG`/`under`. The UI then reads "Leczo z kiełbasą (too little carbs)", which is a counter-intuitive reason for a fatty dish.
  - Neither deviation is in the Progress notes, and CLAUDE.md does not mention the weaker invariant.
- **Fix**: Append a Progress/addendum note to plan.md recording both outcomes, and correct Key Discoveries l.58 and Critical Details l.166. Add one sentence to the CLAUDE.md "Macro solver (S-04)" bullet: rounding can land up to ~1 pp below the LP optimum, and the tier is judged on the displayed 0.1-rounded value, so 10.04 % counts as ±10 %. Separately, decide whether the P10 step-4 reason should prefer the macro that the blamed recipe pushes in the deviation's direction, so "too much fat" is not lost to "too little carbs".
- **Decision**: PENDING

### F4 — The solver relies on `whole_dish` recipes having exactly one component, and nothing enforces it

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: src/lib/services/macro-solver.ts:202, :400
- **Detail**:
  - Plan Key Discoveries says a `whole_dish` recipe "has one component, so it needs no special case".
  - That rule exists only as a table comment (`20261007120000_products_and_recipes.sql:24,89`). There is no check, trigger or seed-integrity assertion.
  - Only `per_component` recipes get the ratio bound. A multi-component `whole_dish` recipe would therefore be scaled per component with no coupling at all: each eater could get a different mix of what should be one dish.
  - S-07 (user-written recipes) is the slice that can create such rows.
- **Fix A ⭐ Recommended**: Make `checkSolvable` return a new unsolvable reason (for example `invalid_recipe`, with `recipeName`) when a `whole_dish` recipe has more than one component. Add its message to `UNSOLVABLE_MESSAGES` and a unit test.
  - Strength: no schema change, and the solver's assumption is checked exactly where it is relied on.
  - Tradeoff: such a recipe is unsolvable rather than handled.
  - Confidence: HIGH — `checkSolvable` already guards `empty_recipe` the same way.
  - Blind spot: S-07 may still want to allow multi-component whole dishes.
- **Fix B**: Enforce the invariant in the schema with a constraint trigger on `recipe_components` (and `recipes.division_mode` updates), asserted in `seed_integrity.sql`, before S-07 lands.
  - Strength: the data can never violate the rule, for every consumer.
  - Tradeoff: a new migration plus `db push`, and trigger logic across two tables.
  - Confidence: MED — cross-table triggers need care with update ordering.
  - Blind spot: S-07's intended write path (RPC vs column grants) is not designed yet.
- **Decision**: PENDING

### F5 — "split in half" is shown for near-even, unequal splits

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/services/macro-solver.ts:619
- **Detail**: `evenSplit: Math.abs(values[0] - values[1]) < splitUnit(cs)`. A cooked split of 320 g / 311 g (remainder rule) or 50 % / 50.4 % is labelled "split in half". P7 says only an *equal* split shows it, and the per-person branch (`:592`) uses strict equality.
- **Fix**: Use `evenSplit: values[0] === values[1]` (after `round6`), and add a unit test with an odd remainder that asserts `evenSplit === false`.
- **Decision**: PENDING

### F6 — Leave-one-out blame is biased toward a person's only meal

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/macro-solver.ts:667-674
- **Detail**:
  - `explain()` re-solves with `peopleOf(rest)`.
  - Removing a meal that is someone's only meal of the day drops that person from the minimax entirely. `t*` then falls to the other person's optimum, so that meal tends to be blamed whether or not it is the real obstacle.
  - This follows P10 step 3 literally, so the flaw is in the plan. It only matters on mixed-eater days, which the fixtures do not cover for no-fit.
- **Fix**: In the leave-one-out loop, skip (or score last) any candidate whose removal changes the set of solved people, falling back to the current rule only when every candidate does. Add an F4-style no-fit fixture with a single-eater meal to pin the behaviour.
  - Strength: blame reflects which recipe hinders the fit, not who stops being measured.
  - Tradeoff: deviates from P10 step 3 as written, so it needs a plan note.
  - Confidence: MED — the reasoning is sound, but no fixture demonstrates the misattribution yet.
  - Blind spot: an all-single-eater day, where every candidate changes the people set.
- **Decision**: PENDING

### F7 — Small undocumented additions and drifts in the solver and readers

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/lib/services/macro-solver.ts:301-316, :528, :541-554; src/lib/services/recipes.ts:236-237; src/lib/services/day-solutions.ts:305-317
- **Detail**: All of these are benign, but the plan does not describe them:
  - Repair moves are confined to a floor/ceil "rounding window" per amount (P8 lists plain ±1-unit moves).
  - Move 3 also steps per-person **gram** ingredients (P8: "per-person piece ingredient").
  - `getSolverRecipes` does not select `products.id`, which the plan asked for. The fingerprint still covers every product value, so staleness is unaffected.
  - `formatDaySolveSummary` takes an optional `viewerId` and adds a "Your partner's daily targets don't add up…" variant that is not in the Desired End State strings.
- **Fix**: Record these four points in a plan.md addendum (and, for the partner-targets string, in the CLAUDE.md S-04 bullet next to the pinned templates). No code change is needed, except optionally adding `id` to the products embed in `COMPONENT_COLUMNS` to match the contract.
- **Decision**: PENDING

### F8 — The fingerprint omits display names that the stored result copies

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/lib/services/macro-solver.ts:783-826
- **Detail**: The fingerprint leaves out `recipe.name`, component `name` and `productName`, but `DaySolution` copies all three for display. Today the library is immutable, so this does not matter. Once S-07 makes rows editable, a rename keeps showing the old name and the result does not go "Out of date".
- **Fix**: Add the three name fields to the canonical fingerprint JSON and bump `SOLVER_VERSION` to 2. Alternatively, add an explicit S-07 hand-off note to the CLAUDE.md S-04 bullet.
- **Decision**: PENDING

### F9 — `/plan` reads more than it needs, and the solve's Workers CPU cost is unmeasured

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/day-solutions.ts:170-179
- **Detail**:
  - `getPlanSolveStatuses` selects the full `result` jsonb (up to 3 × 64 KB) only to read `requiredTier`.
  - Through `loadSharedInputs` it also repeats a `getCurrentHousehold` read that `plan.astro` already made. It is not N+1.
  - The plan's CPU claim (about 1 ms per day) came from Node measurements. A no-fit solve (1 LP + up to 5 leave-one-out LPs + repair) on a cold isolate has not been measured on workerd against the Free plan's 10 ms limit.
- **Fix**: Select `result->requiredTier` (or `result->>requiredTier`) instead of `result` in the statuses read, and pass the already-loaded household into `getPlanSolveStatuses`. Measure `POST /api/plan/solve` for the F2 (all-whole-dish) day with `npx wrangler tail` after a deploy, and record the CPU time in the plan's Progress notes.
- **Decision**: PENDING

### F10 — A concurrent plain "Solve again" can silently undo a partner's acceptance

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/plan/solve.ts:109-113; supabase/migrations/20261009120000_plan_day_solutions.sql:151
- **Detail**:
  - The carry-forward of `accepted_tolerance_pct` reads the stored row in `getDayView`. The RPC then upserts last-writer-wins.
  - If partner B accepts ±20 % while partner A's plain Solve again is in flight (A having read the pre-accept row), A's write stores tolerance 10 and the day falls back to `needs_confirmation`.
  - The accept-fingerprint binding is sound, so "accept what you saw" still holds. The only effect is that a confirmation can be lost.
- **Fix**: In `save_day_solution`'s upsert, keep the larger tolerance when the fingerprint is unchanged: `accepted_tolerance_pct = case when plan_day_solutions.input_fingerprint = excluded.input_fingerprint then greatest(plan_day_solutions.accepted_tolerance_pct, excluded.accepted_tolerance_pct) else excluded.accepted_tolerance_pct end`, with `status` recomputed to match. The cheaper alternative is to document the race in a comment at the upsert.
- **Decision**: PENDING
