<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-08 Shared dish across days

- **Plan**: context/changes/shared-dish-across-days/plan.md
- **Scope**: Full plan — Phases 1–4 of 4 (all automated Progress rows complete; Manual rows deferred to the user and not treated as missing work)
- **Date**: 2026-10-12
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 5 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Automated verification (re-run during this review)

| Command | Result |
|---------|--------|
| `npm test` | PASS: 69/69 tests, 1 file |
| `npm run lint` | PASS: no output |
| `npx astro check` | PASS: 0 errors, 0 warnings, 0 hints (56 files) |
| `npm run build` | PASS: exit 0 |
| `npm run test:rls` | PASS: "household_isolation: all assertions passed (… shared dishes and day solutions)" |
| `npm run test:seed` | PASS: "seed_integrity: all assertions passed" |
| `npm run check:migrations` | **Exit 1, no message, on this Windows host** (see F7). The migration is applied, checked directly: `20261011120000` is in `schema_migrations`, `plan_meals_dish_id_key` is gone, `plan_meals_dish_plan_idx` exists, `save_day_solution` is gone, and `anon` has no execute on `save_plan_day_solutions`. |
| `npm run build && npm run preview` + `BASE_URL=http://localhost:4321 npm run smoke` | PASS: "All smoke steps passed", including the whole S-08 section. This run signed up two more `smoke-…@example.com` accounts on the hosted project; clean them up with the README queries. |

The plan-drift sweep found no MISSING planned change and no breach of "What We're NOT Doing". In particular:
- no new `public` table, no change to the library schema or to any solver constant, and no island on `/plan`;
- no dish id in the client payload, and dishes still cannot span two plans;
- F9 and F10 are untouched.

Security checks found nothing:
- the plpgsql has no dynamic SQL;
- the new RPC follows the definer, `search_path = ''`, revoke-then-grant pattern, and the isolation test asserts it;
- the 4a delete runs as one snapshot statement, and the post-4a invariant behind 4c holds.

## Findings

### F1 — Changing or clearing the lead slot of a saved batch rejects the whole grid save

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/plan.ts:118-129 (with `batchOf()` in src/pages/plan.astro)
- **Detail**: `/plan` re-renders a saved group in canonical star form, so every non-lead member's "Share a batch with" select is pre-selected to the lead slot. If the user then changes the lead slot's recipe, or empties it, and saves, the route rejects the whole form at `if (!targetRecipe) … SHARE_EMPTY_SLOT` / `if (targetRecipe !== recipeId) … SHARE_OTHER_RECIPE`. The RPC's KD016/KD017 would reject it too. So the most ordinary edit ("swap Monday's lunch") fails until the user finds and clears the batch selects on the other days. Smoke never exercises this path. Step 7 posts a deliberately wrong share, not an edit of the lead slot.
- **Fix A ⭐ Recommended**: When the target slot is empty or holds a different recipe, the route sets `shareWith = null` (a fresh batch) instead of redirecting, and appends a soft notice to the `saved=1` redirect ("Tuesday's lunch no longer shares a batch"). The RPC's KD015–KD017 stay as they are. Re-point smoke step 7 to assert that the save succeeds and the `batch-1_lunch` note disappears; KD017 stays pinned by `npm run test:rls`.
  - Strength: The natural edit just works. The database guarantee is unchanged, because only the route's UX check relaxes.
  - Tradeoff: A deliberately wrong share choice is silently turned into "fresh batch" instead of being explained, so smoke step 7 and Progress 3.10 change meaning.
  - Confidence: MED — the route already owns these checks as UX-only (comment at :117), so softening them is within its role.
  - Blind spot: Whether the user would rather be told than auto-corrected; no product decision on this is recorded.
- **Fix B**: Keep the rejection, but make the message name the dependent slots and the action ("Tuesday's lunch shares Monday's lunch batch — set it to 'Cook a fresh batch' first").
  - Strength: No behaviour change. Smoke step 7 and the KD017 message mapping stay valid.
  - Tradeoff: The user still has to make a second edit for a common change.
  - Confidence: HIGH — a message-only change in `meal-plans.ts` / `api/plan.ts`.
  - Blind spot: None significant.
- **Decision**: FIXED (Fix A) — src/pages/api/plan.ts turns a share whose target slot is empty or holds another recipe into a fresh batch and appends a `notice` (formatUnsharedNotice in src/lib/services/meal-plans.ts) to the saved=1 redirect, rendered on src/pages/plan.astro as `plan-notice`; a self-reference is still rejected. Smoke step 7 now swaps Monday's lunch (the lead slot) and asserts the save succeeds with the notice and the batch note disappears; README smoke paragraph updated. KD017 stays pinned by npm run test:rls; manual row 3.10 now needs a direct RPC call to see KD017.

### F2 — The coupled solve's CPU cost: an O(states²) ratio loop on every evaluation, with the edge measurement still open

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/macro-solver.ts:676-679 (`evaluate()` ratio loop); budget at :773
- **Detail**: The F6 group (3 days, no fit) takes about 41 ms on dev hardware after rung 3 of the mitigation ladder, which is about 16× an F2 solve. The test's own comment records 157–165 ms before rung 3. Every `evaluate()` still runs the ratio check as `for (const [a, csA] of states.entries()) for (const [b, csB] of states.entries()) { if (a === b || csB.dishIndex !== csA.dishIndex) continue; … }`, which is O(states²) over the whole group rather than over each dish. It runs for every candidate of a first-improvement scan whose accepted-move budget is now `MAX_REPAIR_MOVES × dayCount` (150). Cloudflare's Free plan allows 10 ms of CPU, and the account's plan is still unrecorded (Progress 4.12 is a deferred manual row, so it is not reported here as missing). This finding is about the code-side cost, which can be cut without changing behaviour.
- **Fix**: Precompute, once per solve, a `statesByDish: number[][]` index, and loop the ratio check over `statesByDish[csA.dishIndex]` only. This is rung-3-style and behaviour-neutral, which the `toStrictEqual` assertions on F1–F5 prove. Then re-record `F6_MEASURED_MS`. Separately, run the Phase 4 §3 workerd measurement and record the Workers plan (or set `limits.cpu_ms` in `wrangler.jsonc` on a paid plan).
  - Strength: Removes the dominant quadratic term from the hot path, with no quantity able to change.
  - Tradeoff: A small refactor in `evaluate()` and in the precomputation.
  - Confidence: MED — the loop shape is verified, but its share of the 41 ms has not been profiled.
  - Blind spot: Cold-isolate cost and the real workerd figure are unmeasured.
- **Decision**: FIXED (Fix) — src/lib/services/macro-solver.ts: indexStatesByDish() computed once in repair() and passed to evaluate(), whose ratio loop visits only the dish's own states (same ascending order, F1–F5 toStrictEqual still pass). Re-measured F6 at 32–42 ms (no measurable change, so the quadratic term was not dominant); F6_MEASURED_MS stays 41. Still on the user: the workerd timing and Workers plan (Progress 4.12).

### F3 — The non-cook day shows the whole batch split, not the viewer's own portion

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/pages/plan/day.astro:251-292; src/lib/services/day-solutions.ts:618-656
- **Detail**: Phase 3 §6 says the non-cook day renders "the batch note and the viewer's **own portion**". The page does skip the ingredient list (`cookedElsewhere`), but it still calls `formatSplitLine()` with every share of the batch: this meal's eaters plus the other day's servings, suffixed "(Monday)". For a `percent` split it shows only percentages "of the dish", while the gram amounts that give them meaning are hidden on this day. A `per_ingredient` split shows "N% of the batch" for the other servings. Smoke's curry fixture uses `grams_cooked`, so neither case is exercised.
- **Fix**: When `cookedElsewhere`, pass a flag to `formatSplitLine()` that keeps only `isOwnShare` shares. For `percent`, also show the grams the share represents (fraction × the batch's cooked weight), so the portion is actionable without the batch list.
- **Decision**: FIXED (Fix) — SplitLineContext gains `ownOnly` (src/lib/services/day-solutions.ts); formatSplitLine() then keeps only this meal's shares, shows a percent share as grams of the batch plus its percentage, and drops the even-split label; src/pages/plan/day.astro passes `ownOnly: cookedElsewhere`. Pinned in src/lib/services/day-solutions.test.ts.

### F4 — The day page and `/plan` judge a group's staleness by different rules

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/day-solutions.ts:295 vs :344
- **Detail**: `getDayView()` sets `stale` from the viewed day's own row only (`stored.inputFingerprint !== fingerprint`). `getPlanSolveStatuses()` marks the group stale when **any** group day's row is missing, fails the schema or mismatches. Through the app, group writes are atomic, so the two agree. A row written by a direct RPC call, or one that fails the zod schema, would make the day page show "Solved" with an Accept button while `/plan` shows "Out of date" for the same group.
- **Fix**: Compute `DayView.stale` over `groupStored` with the same rule `/plan` uses: stale unless every group day has a parsed row whose fingerprint equals the group fingerprint.
- **Decision**: FIXED (Fix) — getDayView() in src/lib/services/day-solutions.ts sets `stale` unless every group day in `groupStored` carries the group fingerprint, the rule getPlanSolveStatuses() uses.

### F5 — No test pins "the fingerprint is equal for both days of a group"

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/services/macro-solver.test.ts (fingerprint block)
- **Detail**: Phase 1 §11 asks that the fingerprint be shown to be "**equal** for both days of a group". The suite covers that it changes on a grouping-only change and on a rename and stays 64 hex characters, but not the equality. It holds today by construction (one fingerprint per group input), but nothing stops a regression where the fingerprint input is filtered by day.
- **Fix**: Add a test asserting that `solveFingerprint` over the group `solveGroups()` returns for a meal of day 0 equals the fingerprint over the group it returns for a meal of day 1 of F5, using shuffled input for both.
- **Decision**: FIXED (Fix) — src/lib/services/macro-solver.test.ts: new test "the fingerprint is equal for both days of a group" fingerprints the solveGroups() group of a day-0 and a day-1 meal of shuffled F5 via shuffledInput().

### F6 — The F6 absolute budget pins a post-mitigation value and a wall-clock figure that may flake on CI

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/services/macro-solver.test.ts:21-25 (`F6_MEASURED_MS = 41`), :580
- **Detail**: The plan says to pin the absolute assertion at 3× the "first measured value". The comment records a first measurement of 157–165 ms (about 63×, over budget), then rung 3, and pins 41 ms, the post-mitigation value. That is a defensible reading, but it is not written in the plan. `expect(f6).toBeLessThan(123)` is also a wall-clock bound on shared CI runners, which are often several times slower than the dev machine that set it. The relative ≤ 60× guard is the robust one.
- **Fix**: Add a line to Phase 1 §11 recording "first measurement 157–165 ms → rung 3 applied → 41 ms pinned". Keep the absolute assertion only if it proves stable on CI; otherwise widen it to cover CI runner speed.
- **Decision**: FIXED (Fix) — plan.md Phase 1 §11 records 157–165 ms → rung 3 → 41 ms pinned. The branch has no CI run of the guard yet, so the absolute assertion is widened by CI_RUNNER_SLOWDOWN = 4 (src/lib/services/macro-solver.test.ts); the relative ≤ 60× budget stays the gate.

### F7 — `npm run check:migrations` exits 1 silently on Windows

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: scripts/check-migrations.mjs:36-40
- **Detail**: `execFileSync("npx", [...])` without `shell` cannot spawn `npx.cmd` on Windows. The `catch` exits with `error.status || 1` and prints nothing. Progress rows 2.2 and 4.6 are marked passing. The migration is in fact applied (verified directly, see the table above), and CI runs on Linux, where the script works. The script is pre-existing and not part of this diff, but on this host its result cannot be trusted as a success signal for those rows.
- **Fix**: Pass `{ stdio: "inherit", shell: process.platform === "win32" }` to `execFileSync`, and print `error.message` in the `catch` before exiting.
- **Decision**: FIXED (Fix, adapted) — scripts/check-migrations.mjs writes the SQL to a temp file and runs `npx supabase db query --linked -f <file>` through a shell (execSync), and prints error.message before exiting. The literal `shell: true` + execFileSync was tried first: cmd.exe split the multi-line SQL argument (UnexpectedArgument) and Node warns DEP0190. Verified on Windows: exit 0 when applied, exit 1 with the reason for a missing version.

### F8 — Same-day sharing UI added beyond the plan

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/lib/services/day-solutions.ts:593-656 (`SplitLineContext`, meal-type suffix), `formatSameDayBatchNote`; src/lib/recipe-labels.ts (`SPLIT_LABELS.ofTheBatch`, `splitEvenly`)
- **Detail**: The RPC allows two slots of the **same** day to share a batch. The plan designed only cross-day notes, so the implementation added these:
  - a same-day batch note;
  - a meal-type suffix on shares eaten at another meal of the viewed day;
  - an "N% of the batch" rendering for other servings of a `per_ingredient` split.

  `formatSplitLine()` takes a `SplitLineContext` object rather than the planned `(resolver, viewedDay)` pair. The additions are benign and consistent, but undocumented. No unit test or smoke step covers a same-day share.
- **Fix**: Record same-day sharing and its rendering in the plan as an addendum to Phase 3 §2/§6, and add one unit test of `formatSplitLine()` for a same-day two-meal batch.
- **Decision**: FIXED (Fix) — plan.md Phase 3 §2 addendum records same-day sharing and its rendering (SplitLineContext, meal-type suffix, ofTheBatch, splitEvenly); src/lib/services/day-solutions.test.ts adds a formatSplitLine() test for a same-day two-meal batch (CLAUDE.md `npm test` line updated).
