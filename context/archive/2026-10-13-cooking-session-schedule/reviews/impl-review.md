<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Cooking-Session Schedule (S-10)

- **Plan**: context/changes/cooking-session-schedule/plan.md
- **Scope**: Full plan (Phases 1–3 of 3)
- **Date**: 2026-10-14
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 5 observations

The change had already been archived (b422d08) without an implementation review. It was moved back to
`context/changes/` for this review and re-archived afterwards.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Automated verification (re-run during this review)

| Command | Result |
|---------|--------|
| `npm test` | PASS: 4 files, 97 tests (98 after F2) |
| `npm run lint` | PASS: no errors |
| `npx astro check` | PASS: 0 errors, 0 warnings, 0 hints (69 files) |
| `npm run build` | PASS |
| `npm run check:migrations` | PASS: all 11 migrations applied |

Smoke was not re-run: no runtime code changed in this review. Every planned file is in the diff
(2a7b8d2..b422d08), and no file outside the plan was changed. All rules D1–D10 match the plan. The 33
fixture steps match the seed migration, and Sunday evening's order (601, 401, 602, 603, 402, 403, 404,
701, 201, 702, 604, 202; 118 min, 1 untimed) was re-derived by hand from D5.

## Findings

### F1 — Progress cites commit SHAs that do not exist

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/cooking-session-schedule/plan.md (Progress)
- **Detail**: Every automated Progress item cites feecde6, 49291b1 or 3f750b2, and none of these exists in any ref (`git log --all`). They are probably the SHAs from before a rebase. The real phase commits are d0145bd (p1), 7c8b4a2 (p2) and 33b266e (p3), so as written the evidence trail is broken.
- **Fix**: Replace the SHAs with d0145bd / 7c8b4a2 / 33b266e.
- **Decision**: FIXED

### F2 — Two rule cases lack unit-test assertions

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/services/cooking-sessions.test.ts:261
- **Detail**: Plan §5 (D10) asks the zero-step-only plan to assert its diagnostic, and that case did not. D4's "dishes with no fresh steps keep every note" (for example, a shared Ciastka batch on one day) had no test at all.
- **Fix**: Assert `recipesWithoutSteps` in the zero-step-only case, and add a same-day shared Ciastka test that expects the morning batch note.
- **Decision**: FIXED

### F3 — Lead fresh-step entry lists later meals of a shared batch

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/services/cooking-sessions.ts (entry `meals`)
- **Detail**: Monday morning's curry entry (step 405, "reheat and serve") reads "For Monday Lunch and Tuesday Lunch", while Tuesday morning carries the batch note. This follows the contract ("every meal those dishes feed"), but it may read oddly. S-11 owns serving per meal.
- **Fix**: None now. Revisit in S-11 if users find it confusing.
- **Decision**: SKIPPED (follows plan contract)

### F4 — S-10 anonymous smoke checks not beside the S-09 ones

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: scripts/smoke.mjs:1348-1362
- **Detail**: The plan placed them with the S-09 anonymous checks (around l.1211). They sit after the S-09 date edge cases instead. They work the same way.
- **Fix**: None needed.
- **Decision**: SKIPPED (benign)

### F5 — Demoted make-ahead steps log console.error on every view

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/services/cooking.ts:25-28
- **Detail**: This copies S-09's diagnostics pattern. The seed is clean today, but once S-07 opens the library to writes, a user recipe with a make-ahead step after a fresh one would log an error on every page view.
- **Fix**: Downgrade demotions to `console.warn` when S-07 lands.
- **Decision**: SKIPPED (deferred to S-07)

### F6 — Evening divider also drawn above the first section

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/pages/plan/sessions.astro:114
- **Detail**: The `border-t … pt-3` class applies to every evening section, including the first, so a rule sits directly under the session heading. This is cosmetic only.
- **Fix**: Apply the divider only to the second section.
- **Decision**: SKIPPED (cosmetic)
