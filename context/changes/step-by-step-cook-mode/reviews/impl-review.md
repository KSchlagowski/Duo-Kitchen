<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Step-by-Step Cook Mode (S-11)

- **Plan**: context/changes/step-by-step-cook-mode/plan.md
- **Scope**: Full plan (Phases 1–4 of 4)
- **Date**: 2026-10-14
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Evidence summary

- **Diff vs plan**: every file in the plan's "Changes Required" was changed (`types.ts`, `recipes.ts`, `cooking-sessions.fixtures.ts`, `split-lines.ts`, `day-solutions.ts`, `recipe-labels.ts`, `cook-mode.ts`, `cook-mode.test.ts`, `cooking.ts`, `cook.astro`, `sessions.astro`, `useCookProgress.ts`, `useWakeLock.ts`, `CookMode.tsx`, `smoke.mjs`, `CLAUDE.md`, `README.md`). Not in the plan: `cooking-sessions.test.ts` (one line, `componentId: null` that the new required field forces, which is fine) and `mealLabel` exported from `cooking-sessions.ts` (the plan asked for this). Commit `9746b90` (the CLAUDE.md "No GitHub issues" rule) is on the branch but is not S-11 work (F5).
- **Contracts checked**: D2 validation regexes and the step clamp (`cook.astro:38-43`, `:76`); D3 per-section currency through `getPlanSolveState()` only (`cooking.ts`, `cook-mode.ts:223-225`); one stored row per dish found by lead `mealId` (`cook-mode.ts:137`); D4 per-component step amounts and portions on an entry's last step (`cook-mode.ts:237-252`); D5 per-batch headings; D6 lead-meal context and D7 `ownOnly` serving notes; D8 `split-lines.ts` moved unchanged, with `day-solutions.ts` re-exporting it; island imports limited to `cook-mode.ts`, labels, utils and hooks; `history.replaceState`, modifier-click passthrough, focus on the heading after an in-place change; no `set:html`.
- **Island safety**: `cook-mode.ts` and `split-lines.ts` import nothing from `day-solutions`, `macro-solver`, `zod` or `@supabase`. Grep for `yalps|ZodError` under `dist/client/` found no matches.

## Success criteria

| Check | Result |
|---|---|
| `npm test` | PASS: 5 files, 112 tests |
| `npm run lint` | PASS: no output |
| `npx astro check` | PASS: 76 files, 0 errors / 0 warnings / 0 hints |
| `npm run build` | PASS (only the usual sitemap `site` warning) |
| `npm run check:migrations` | PASS: "All 11 migrations are applied to the hosted project." |
| Island-safety grep (1.5) | PASS |
| `dist/client/` has no `yalps` / `ZodError` (3.6) | PASS |
| `npm run smoke` against `npm run preview` (4.5) | PASS: "All smoke steps passed", including the 9 S-11 steps and 5 edge cases |

Manual rows 1.6–1.8, 2.6–2.17, 3.7–3.14 and 4.7–4.10 are unchecked. Manual testing is deferred to the user, so this report does not count them as missing work. No Manual row is marked done without evidence.

## Findings

### F1 — A dish that falls back shows base amounts under the "exact" note

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/cook-mode.ts:136-145 (also `src/pages/plan/sessions/cook.astro:117-121`)
- **Detail**: D3 says a dish whose lead-meal row is missing from a current day falls back to the estimate, which is recorded in `diagnostics.dishesFellBack`. The section's `source` stays `"exact"`. So the page prints "Amounts and portions from the day solve of Monday." above that dish's recipe **base** amounts, with nothing marking them as estimates. The unit test "falls back for one dish whose current row is missing" (`cook-mode.test.ts:298-311`) pins exactly this: the section is `exact`, and step 401 shows the base `160 g`. A cook following the page would weigh base-batch quantities while believing they were solved. The case only arises from inconsistent stored data, which is why it is a warning and not critical. A related diagnostics problem: a serving note whose own row is missing pushes the note meal's `dishId` into `dishesFellBack` (`cook-mode.ts:208`), although that dish's amounts did not fall back. Only the note's portions are missing.
- **Fix A ⭐ Recommended**: Add `estimate: boolean` to `CookBatchAmounts` and to the overview batch (true when `batch.stored === null` on an exact section). Render a short "(recipe base amounts — estimate)" tag next to that batch in `CookMode.tsx` and `cook.astro`. Pin it in the existing fallback test.
  - Strength: keeps D3's per-section note and fixes only the batch that is wrong. The flag is cheap because `Batch.stored` already says it.
  - Tradeoff: one more field and label (add it to `COOK_MODE_LABELS` for S-14). The island and the page markup both change.
  - Confidence: HIGH — the builder already knows which batches fell back.
  - Blind spot: the label must be apostrophe-free if smoke ever pins it.
- **Fix B**: When any dish of a section falls back, downgrade that whole section to `source: "estimate"`.
  - Strength: no new field; the existing estimate note and "Solve" link appear.
  - Tradeoff: throws away the correct exact amounts of the section's other dishes, and the "solve Monday" advice is wrong when Monday is already solved.
  - Confidence: MED — simple, but the message misleads.
  - Blind spot: none significant.
- **Decision**: PENDING

### F2 — Wake lock can leak a sentinel on quick re-toggles

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/components/hooks/useWakeLock.ts:26-39
- **Detail**: `request()` assigns `sentinel.current = lock` without releasing a lock it already holds. Toggling on → off → on while the first `navigator.wakeLock.request` is still pending leaves two requests in flight, and both resolve with `wanted.current === true`. The first lock is overwritten and never released, so the screen stays on even after the user unticks **Keep screen on**, until the tab is hidden. The same overlap can happen when `visibilitychange` fires while a `setActive(true)` request is pending.
- **Fix**: In `request()`, after the `await`, release the new lock when `sentinel.current` is already set and not released (or call `release()` before assigning), so at most one sentinel is ever held.
- **Decision**: PENDING

### F3 — Unplanned storage behaviour in useCookProgress (cross-tab sync, in-memory fallback)

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/components/hooks/useCookProgress.ts:12-41
- **Detail**: The plan's Critical Implementation Details and Phase 3 say the ticks (and wake-lock support) are read "in an effect". The implementation uses `useSyncExternalStore` with a `null` server snapshot instead. That is equally hydration-safe. It also adds two behaviours the plan does not describe: ticks sync across tabs through the `storage` event, and a module-level in-memory `Map` keeps ticks when `localStorage` is blocked. Both are benign and arguably better. They are still undocumented: the plan and the CLAUDE.md S-11 bullet describe ticks as `localStorage`-only.
- **Fix**: Add one sentence to the CLAUDE.md S-11 bullet (and a plan addendum if the plan is kept as the record), saying that ticks sync across tabs of the same browser and fall back to memory when storage is blocked.
- **Decision**: PENDING

### F4 — Island props serialise the whole view, overview included

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/plan/sessions/cook.astro:154-159
- **Detail**: `<CookMode view={view} …>` serialises the whole `CookModeView` into the island's props: `sections` (every entry's overview ingredients, portions and serving notes) and `diagnostics`. The island reads only `steps`, `planId`, `startDate`, `sessionKey` and `part`. The overview is already rendered by plain Astro, so its data ships twice in the HTML. The plan specified `view: CookModeView` as the prop, so this follows the plan, but it makes the "a few KB" estimate larger than needed on a phone.
- **Fix**: Pass `view={{ ...view, sections: [], diagnostics: { dishesFellBack: [], missingRecipeIds: [] } }}`, or narrow the prop type to `Pick<CookModeView, "planId" | "startDate" | "sessionKey" | "part" | "steps">` in `CookMode.tsx` and `useCookProgress.ts`.
- **Decision**: PENDING

### F5 — Unrelated CLAUDE.md rule commit rides on the feature branch

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: CLAUDE.md:5 (commit 9746b90)
- **Detail**: `git log main..HEAD` includes `9746b90 docs(claude): never create GitHub issues for this project`. It adds a project-wide hard rule unrelated to S-11. It is harmless, but merging the branch lands a repository policy change under the S-11 PR.
- **Fix**: Name the commit in the S-11 PR description as a separate docs change, or cherry-pick it onto `main` first so the S-11 diff holds only the slice.
- **Decision**: PENDING
