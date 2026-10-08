<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Set Daily Macro Targets (S-02)

- **Plan**: context/changes/set-daily-macro-targets/plan.md
- **Scope**: All phases (1–4 of 4), commits b1f95f3..9439282 on `main`
- **Date**: 2026-10-08
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 2 observations

The review was done inline, without sub-agents. The diff is small: 9 code and docs files, plus the change folder. Every planned file was read in full and compared against its Phase contract.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Evidence

**Plan to diff.** Every planned file is in the diff, and no unplanned code file appears:

- the migration;
- `household_isolation.sql`;
- `types.ts`, `macro-targets.ts`, `api/targets.ts`, `middleware.ts`, `targets.astro` and `dashboard.astro`;
- `smoke.mjs`;
- `CLAUDE.md` and `README.md`.

The three additions beyond the plan are all already recorded in the plan's Progress notes and are benign:

- `class:list={cn(…)}` instead of `class={cn(…)}`;
- `data-testid="targets-hint"`;
- the postgres-side composite-FK probe for C in D's household.

**Contract checks.**

- **Migration.** It matches the SQL contract byte for byte: the composite FK, `on update cascade on delete cascade`, CHECK bounds, the index, RLS, `revoke all from anon`, `revoke truncate, references, trigger from authenticated`, and four policies. The write policies carry the owner predicate.
- **Route.** The digits-only regex runs before `Number`. Both messages are URL-encoded constants, and the structure is cloned from `redeem.ts`.
- **Page.** It handles the two independent read failures exactly as specified, and never defaults the member count to 0.
- **Isolation test.** It has the strict `insufficient_privilege`-only insert probes. D's row is inserted before the redemption, and the cascade assertion uses the planned message.

**Automated verification (re-run during this review against the hosted project):**

| Command | Result |
|---|---|
| `npm run lint` | PASS (0 errors, 0 warnings) |
| `npx astro check` | PASS (0 errors) |
| `npm run build` | PASS |
| `npm run test:rls` | PASS — "household_isolation: all assertions passed (incl. invite isolation, RPC grants, redemption, macro targets and eight rejection SQLSTATEs)" |
| `npm run test:seed` | PASS — "seed_integrity: all assertions passed" |
| `npx prettier --check CLAUDE.md README.md` | PASS |
| `npm run smoke` (production preview, after the F1 fix) | PASS — all steps, including the S-02 targets and post-redemption partner steps |

`npx supabase db push` was not re-run. The migration is already on the hosted project, which is why `test:rls` passes against it.

## Findings

### F1 — Dashboard link says "Set targets" when the targets read failed

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/pages/dashboard.astro:97 (link label), :54-60 (labels)
- **Detail**: When `getHouseholdMacroTargets` throws, `targets` is `null`. The status line correctly reads "Targets are unavailable right now.", but `myTargets` is also `null`, so the link next to it reads "Set targets". That implies the targets are not set, which `targets.astro` takes care never to imply when a read fails ("never let a failed read pass for 'Not set'"). The dashboard link did not follow that same rule.
- **Fix**: Derive a `targetsLinkLabel`: "Open targets" when the read failed, "Edit targets" when a row exists, and "Set targets" only when the read succeeded and found none.
- **Decision**: FIXED. `targetsLinkLabel` was added in `src/pages/dashboard.astro`. Lint, astro check, build and smoke (production preview) were re-run and all passed.

### F2 — Manual verification rows 2.5–2.9 and 4.2 are still pending

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/set-daily-macro-targets/plan.md (Progress, Phase 2 and Phase 4 Manual)
- **Detail**: These are correctly left `[ ]`, with no rubber-stamping. The Phase 2 note records what the agent checked over HTTP: 2.5, 2.6, 2.7 and 2.9. The smoke now covers 2.5, 2.7, 2.8 and 2.9 in CI. Two things still need a person: the visual layout and devtools validation bypass in a real browser, and the reader judgment in 4.2. The two manual rows marked `[x]` (1.4 and 3.4) each have a concrete note describing how the deliberate break was performed and what failed, so they are evidenced.
- **Fix**: Leave pending for a human browser pass. Not something the agent can close.
- **Decision**: ACCEPTED. The rows stay pending for a human; no code change.

### F3 — `saveMyMacroTargets` reads `household_members` directly instead of reusing `getCurrentHousehold`

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/lib/services/macro-targets.ts:45-49
- **Detail**: The service resolves the caller's `household_id` with its own `household_members` select (`.eq("user_id", userId).single()`). `household.ts` already has `getCurrentHousehold`. This matches the plan's contract (Phase 2 §2, step 1) exactly, and it is cheaper: one column of one row, against an embedded households-plus-members read. It is not a policy, so the "never query `household_members` inside a policy" rule does not apply. It is noted only so the next per-person service (S-06 ratings) makes a deliberate choice instead of copying it by accident.
- **Fix**: No change. The planned, narrower query is the right one here.
- **Decision**: DISMISSED. It matches the plan and the conventions.

## Triage summary

| Decision | Findings |
|---|---|
| Fixed | F1 |
| Accepted | F2 |
| Dismissed | F3 |
