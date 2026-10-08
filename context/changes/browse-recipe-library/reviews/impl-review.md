<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Browse the Recipe Library (S-05)

- **Plan**: context/changes/browse-recipe-library/plan.md
- **Scope**: Phases 1–3 of 4 (commits 7e8bcd6, b844d0f, 02f1530, f8a04a4 since 962c945). Phase 4 is gated on S-03 reaching `main` and was intentionally not reviewed or started.
- **Date**: 2026-10-08
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 2 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | WARNING |

### Notes on PASS dimensions

- **Plan Adherence**: every file in "Changes Required" for Phases 1–3 is in the diff and matches its contract: DTOs, label map, pure helpers, the three flat parallel queries (A4), the TS Polish-collation sort (A5), the 404/500 split (A7), the ratings slot (A8), `"/recipes"` appended to `PROTECTED_ROUTES`, the separate dashboard link block, the smoke fixtures with the oracle SQL in a comment, and the README, CLAUDE.md and roadmap blocks. Deviations are recorded in the Progress implementation notes: `recipe-name` is a `<p role="heading" aria-level="1">`, and there are `component-total` / `recipe-unavailable` test ids and `class:list={cn(…)}`. All are benign.
- **Scope Discipline**: there is no migration, photo column, ratings storage, `/api` route, island or S-03 file. The roadmap edit touches only S-05's row and section status.
- **Architecture**: Supabase access stays in `src/lib/services/recipes.ts`. `recipe-macros.ts` is pure, the labels are in one map, and the pages call no `supabase.from(...)`.
- **Pattern Consistency**: the Row→DTO idiom, `if (error) throw error`, the `try/catch` + `console.error` page pattern and `cn()` all match `macro-targets.ts` / `targets.astro`.

### Automated verification (re-run during review)

- `npm run lint`: pass (0 errors, 0 warnings)
- `npx astro check`: pass (0 errors, 0 warnings, 0 hints)
- `npm run build`: pass
- Hosted DB check: `select count(*) … from public.recipes` returned 8 rows, 0 with a non-RFC id (relevant to F1)

## Findings

### F1 — `z.uuid()` is stricter than Postgres `uuid`

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/recipes/[id].astro:21
- **Detail**: Zod 4's `z.uuid()` enforces the RFC 9562 version (1–8) and variant (8/9/a/b) nibbles. Postgres `uuid` accepts any 8-4-4-4-12 hex value. If a library row is ever inserted with a literal non-RFC id (by a later seed or an import migration such as S-12), `/recipes` would list its card but `/recipes/<id>` would answer 404 "Recipe not found" for a row that exists. All 8 current ids are RFC-valid, so this is latent and not live. The goal of the check (keep malformed segments away from PostgREST's `22P02`) only needs hex-shape validation.
- **Fix**: Use `z.guid()`, which still rejects every malformed segment, and update the CLAUDE.md S-05 bullet and the plan with an addendum.
- **Decision**: FIXED. Switched to `z.guid()` with a comment explaining why, updated the S-05 bullet in CLAUDE.md, and added a review addendum to the plan's Phase 3 notes. The smoke tests for the malformed id (`not-a-uuid`) and the absent id still return 404.

### F2 — `recipe-unavailable` missing from the smoke failure dump

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: scripts/smoke.mjs:430
- **Detail**: The detail page renders `data-testid="recipe-unavailable"` on a failed read (status 500), but that id is not in the failure-dump list. When a smoke step fails because the read failed, the dump prints nothing about the cause, which is the one case where it helps most.
- **Fix**: Add `"recipe-unavailable"` to the S-05 part of the dump id list.
- **Decision**: FIXED

### F3 — Manual check 2.10 (phone-width layout) still unchecked

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/browse-recipe-library/plan.md:525
- **Detail**: Progress item 2.10 is honestly left `[ ]`: no browser was available, and the markup is mobile-first (`grid-cols-1` below `sm`, ingredient rows stacked with `flex-col`). The other manual items (1.4, 2.4–2.9, 3.7, 3.8) have concrete evidence in the implementation notes: HTTP checks against a throw-away account, oracle output, and the deliberate-break dump. None looks rubber-stamped.
- **Fix**: Open `/recipes` and one detail page at about 375 px wide in a real browser, then tick 2.10.
- **Decision**: DEFERRED. This needs a human with a browser, and this non-interactive session has none.

## Triage summary

| Decision | Findings |
| -------- | -------- |
| Fixed    | F1, F2   |
| Deferred | F3       |

Post-fix verification: `npm run lint`, `npx astro check` and `npm run build` pass; `npm run smoke` against the production preview passes (all steps, including both 404 cases).
