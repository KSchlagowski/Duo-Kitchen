<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Shopping List from the Plan (S-09)

- **Plan**: context/changes/shopping-list-from-plan/plan.md
- **Scope**: Full plan (Phases 1–5 of 5)
- **Date**: 2026-10-13
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 5 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Automated verification (re-run during this review)

| Command | Result |
|---------|--------|
| `npm test` | PASS: 3 files, 83 tests |
| `npm run lint` | PASS: no errors |
| `npx astro check` | PASS: 0 errors, 0 warnings, 0 hints (64 files) |
| `npm run build` | PASS |
| `npm run test:rls` | PASS: "all assertions passed (… day solutions and shopping-list checks)" |
| `npm run test:seed` | PASS: "seed_integrity: all assertions passed" |
| `npm run check:migrations` | PASS: "All 11 migrations are applied to the hosted project." |
| `npm run preview` + `npm run smoke` | PASS: "All smoke steps passed", including every S-09 step and both S-08-sequence insertions |

The Manual rows in Progress (1.5–1.7, 2.5–2.6, 3.6–3.13, 4.6–4.11, 5.8–5.11) are unchecked. Manual testing is deferred to the user, so they are not reported as missing work. No Manual row is checked without evidence.

## What was verified clean

- **Every planned file is in the diff, and every planned item is implemented.**
  - Migration, isolation test, types, labels, the `joinList` move, the builder and its tests, the `getPlanSolveState()` refactor, `getIngredientProducts()`, `shopping.ts`, the page, the API in both modes, navigation, the island and its hook, smoke, CLAUDE.md and README.
  - Nothing listed under "What We're NOT Doing" was built.
- **Definer RPC:**
  - It sets `search_path = ''` and fully qualifies every name.
  - It resolves the household server-side, looks up the plan within that household (so it cannot write into another household's plan), and rejects unknown or unused products on check with KD019.
  - Its grants are revoked from `public, anon` and granted to `authenticated`.
  - The table's revoke list includes `maintain`. The isolation test asserts every lever.
- **No XSS and no open redirect.**
  - The `?error=` notice goes through Astro's escaping.
  - `start` (`isIsoDate`) and `product_id` (`z.guid()`) are validated before they reach `Location` or the fragment.
- **JSON mode returns only fixed messages.** An expired session gets a 401 JSON response rather than an HTML redirect, and the island reverts on it.
- **Builder dedup is correct for every shared-batch shape.** It keys on the plan's `dishId`, takes the first stored meal and never sums. Totals are cleaned of float noise. The order is deterministic, using Polish collation with a `productId` tiebreak.
- **The island ships no zod, Supabase or solver code.** Its import graph is `shopping-list.ts` → `recipe-macros.ts` (type imports only) → `utils.ts`.

## Findings

### F1 — A dish that falls back to base amounts is still labelled "exact"

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/shopping-list.ts:84-92, 141-148
- **Detail**:
  - Suppose a day is in `currentSolutions` but its stored solution lacks one of the plan's dishes. The builder then adds the recipe base batch and records the dish in `diagnostics.dishesFellBack` (L90-92).
  - However, `daySources[day]` is computed only from `currentSolutions[day] !== undefined` (L145). That day therefore still lands in `formatExactNote(...)`, and the page reads "Exact amounts from the day solve of …" while that dish's amounts are estimates.
  - The only signal is a `console.error` in `shopping.ts`.
  - This is unlikely to happen: the fingerprint covers meal ids. But this is exactly the case the plan's fallback rule exists for (Critical Implementation Details: "fall back to the base batch"), and the user-facing note contradicts the amounts.
- **Fix**:
  - Code: in `buildShoppingList`, when a dish falls back, collect the `dayIndex` of each of its meals into a `Set`, and set `daySources[day] = "estimate"` for those days (after the `empty/exact/estimate` loop).
  - Test: extend the existing "Fallback" case in `shopping-list.test.ts` to assert that `daySources` for the fell-back dish's day is `"estimate"`.
- **Decision**: FIXED (Fix) — `buildShoppingList` collects the days of every fell-back dish and marks them `estimate` (src/lib/services/shopping-list.ts); the Fallback case in shopping-list.test.ts now asserts `daySources`.

### F2 — Stored `amountG` is summed into the list without a range check

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/day-solutions.ts:143
- **Detail**:
  - The stored solve jsonb can be asserted by the client: any household member can write it through `save_plan_day_solutions` (CLAUDE.md, S-04 bullet). `parseStoredSolution()`'s schema accepts `amountG: z.number()`.
  - S-09 now sums these values into the shopping list. A crafted row with a matching fingerprint could therefore show the partner negative or absurd quantities.
  - The damage stays inside one household (RLS), so this is hardening, not a vulnerability.
- **Fix**: Change `amountG: z.number()` to `amountG: z.number().finite().nonnegative()` at `day-solutions.ts:143`.
  - A row that fails the schema already reads as "not solved", so the list falls back to estimates and `/plan/day` shows the day as unsolved, with no new code path.
  - Add one `day-solutions.test.ts` case that a negative `amountG` fails `parseStoredSolution()`.
- **Decision**: FIXED (Fix) — `amountG: z.number().nonnegative()` in day-solutions.ts (`.finite()` dropped: deprecated no-op in zod 4, which already rejects infinities, and lint fails on it); `parseStoredSolution()` exported and a negative-amount case added to day-solutions.test.ts.

### F3 — Tapping one item clears another item's failure message

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/components/hooks/useShoppingChecks.ts:46
- **Detail**:
  - The hook keeps one shared `message`, and `toggle()` calls `setMessage(null)` before every request.
  - Suppose item A's save fails, so it reverts and the message shows. Tapping item B immediately hides that message while A's revert stands. A user moving quickly through a store can miss that A did not save.
- **Fix**: Remove `setMessage(null)` from the start of `toggle()`, and clear the message only after a successful response, i.e. in an `else` branch of the `!response.ok || payload?.ok !== true` check at L54.
- **Decision**: FIXED (Fix) — useShoppingChecks.ts no longer clears the message at the start of `toggle()`; it clears it only after a successful response.

### F4 — Server `?error=` notice survives successful in-place toggles

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/plan/shopping.astro:78-80
- **Detail**:
  - After a no-JS post that failed (`?error=` in the URL), the page renders a red notice outside the island. The island then hydrates with its own separate `aria-live` notice.
  - Later successful in-place toggles never clear the server notice. The page keeps showing a stale error next to items that did save.
  - The sibling pages (`day.astro`, `plan.astro`) render the same way, but they have no in-place updates, so the problem cannot arise there.
- **Fix**:
  - Island: pass the `error` param into the island as an `initialMessage` prop, use it as the hook's initial `message` state, and delete the separate red notice from `shopping.astro`. One `aria-live` notice then covers both paths and is cleared by the next successful toggle (together with F3's fix).
  - URL: call `history.replaceState` to drop `error` from the URL on that first success.
- **Decision**: FIXED (Fix) — the island takes an `initialMessage` prop (the `?error=` param) as the hook's initial message, a successful toggle clears it and drops `error` from the URL with `history.replaceState`; shopping.astro renders its own red notice only when no list is loaded (no-plan/unavailable states, which have no island).

### F5 — Second library read duplicates part of `getSolverRecipes()`

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/recipes.ts:285-315
- **Detail**:
  - `getIngredientProducts()` reads `recipe_components → recipe_ingredients → products` for the same recipe ids that `getPlanSolveState()` has already read through `getSolverRecipes()`, only to get `product_id`, `aisle` and the product name.
  - The plan chose this deliberately ("without touching `SolverIngredient`", "No changes to … `getSolverRecipes()`"). It runs inside the same `Promise.all`, so it adds one Supabase round trip but no serial latency and negligible CPU.
  - Folding it into the solver read is risky: if the fingerprint serialises the ingredient objects (unverified), every stored solve would go stale.
- **Fix**: Keep the code as is, and record the trade-off in the plan's "Performance Considerations" ("one extra library read, chosen to keep `SolverIngredient` and the solve fingerprint untouched").
  - Revisit only if an edge CPU or latency measurement of `/plan/shopping` shows it matters.
- **Decision**: FIXED (Fix) — plan.md "Performance Considerations" records the extra library read and why it is kept.

### F6 — Small undocumented deviations from the plan

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/components/shopping/ShoppingList.tsx:16; src/pages/plan/shopping.astro:105-138; src/lib/services/shopping-list.ts:182-187; src/pages/api/plan/shopping.ts:87-88
- **Detail**: Four benign drifts that the plan does not record:
  1. **Island props.** The island has no `initialCheckedCount` prop (the count is derived from item state, which is better), and it takes an extra `children` prop.
  2. **Notes and day lines.** These are written in `.astro` as planned, but passed into the island as a slot. They therefore render between the summary and the aisles, inside the island's root. The testids are unchanged and smoke passes.
  3. **Summary wording.** `formatShoppingSummary` prints "no items yet" whenever `itemCount === 0` (not only when the plan has no meals), and adds a singular "1 item".
  4. **JSON status codes.** In JSON mode, an authenticated caller without a household gets KD007 → `400`, not `401`. This is practically unreachable, because every account gets a household at sign-up.

  The smoke test also pins two product lines instead of one, and hard-codes the KD019 test product (oats). Both are benign extras.
- **Fix**: Append a short "Implementation deviations" addendum to `plan.md` (after "References") listing items 1–4, so the plan stays an accurate source of truth for S-10/S-11 and future reviews. No code change.
- **Decision**: FIXED (Fix) — plan.md gains an "Implementation deviations" addendum after References listing items 1–4 (plus the new `initialMessage` prop from F4) and the smoke extras.
