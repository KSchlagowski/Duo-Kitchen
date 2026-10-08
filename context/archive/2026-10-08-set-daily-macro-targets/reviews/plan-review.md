<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Set Daily Macro Targets (S-02)

- **Plan**: context/changes/set-daily-macro-targets/plan.md
- **Mode**: Deep (claims verified inline against the code; no sub-agent)
- **Date**: 2026-10-08
- **Verdict**: REVISE (light: every fix is a targeted edit and the core design stands)
- **Findings**: 0 critical, 2 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

- **Paths: 7/7 existing paths ✓.** Checked `src/types.ts`, `src/middleware.ts`, `src/pages/dashboard.astro`, `scripts/smoke.mjs`, `supabase/tests/household_isolation.sql`, `CLAUDE.md` and `README.md`. The four new files (the migration, `macro-targets.ts`, `targets.astro` and `api/targets.ts`) are correctly absent.
- **Symbols and line references: 8/8 ✓.**
  - The membership `update` is at `household_invites.sql:296-298`, and the literal-list KD006 comment at `:271`.
  - The `household_members` PK `(household_id, user_id)` and `user_id unique` are at `household_data_scope.sql:26-32`.
  - The products policy and revoke template is at `:148-179`.
  - In `household_isolation.sql`: the anon loop is at `:459-475`, the catch-all at `:484-522`, and the S-01 section starts at `:524`.
  - The debug id list is at `smoke.mjs:245`, and `PROTECTED_ROUTES` (prefix match) is at `middleware.ts:4`.
- **Brief↔plan: ✓.** Phases, decisions and scope match.
- **Blast radius: ✓.** The only code that enumerates `household_id` tables is the isolation catch-all (`household_isolation.sql:494`). Nothing else (the seed test, the KD006 guard, the README cleanup) picks up the new table implicitly.
- **Progress↔Phase: ✓.** There are 4/4 phases and 18/18 criteria rows. The abbreviated row titles follow the same style as the accepted S-01 plan.
- **`context/foundation/lessons.md` and `docs/reference/contract-surfaces.md` do not exist.** No priors or surfaces were checked.

**Design claims confirmed against Postgres semantics and the code:**

- The composite FK targets the exact PK column set.
- RI cascade actions run as the referencing table's owner with RLS not forced, so the `on update cascade` fires inside the definer redemption.
- KD006 counts only the five library tables, so `macro_targets` rows never block or get left behind by a redemption.
- An RLS `WITH CHECK` failure is raised before CHECK, unique and FK checks. This ordering matters for F1.
- Adding a `targets` `<p>` after `library` on the dashboard does not break `linkedHouseholdBody()` in the smoke test.

## Findings

### F1 — Owner predicate on INSERT is never strictly proven

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 §2 (A/B per-user assertions) and §3 (redemption block)
- **Detail**:
  - The owner predicate `user_id = (select auth.uid())` is the only thing that stops a partner writing the other person's targets. The catch-all does not check it (plan line 15). So the test blocks are its only guard.
  - **UPDATE and DELETE are covered** by C's 0-row update and delete on D's row.
  - **INSERT is not covered strictly.**
    - The A→B insert probe accepts `insufficient_privilege` **or** `foreign_key_violation`.
    - With B's household the household predicate already fails (42501), whatever the owner predicate says.
    - With A's household, the owner predicate is currently what raises 42501. If it were dropped, the outcome would be a unique violation (23505, because B's fixture row exists) or, without that row, an FK violation (23503), which the test accepts.
    - So today the probe only fails by accident of fixture ordering.
  - **The real exposure has no test.** It is a partner inserting a row for a co-member who has no row yet (for example D inserting `(user_id = C, household_id = c_household)` after redemption). The composite FK *allows* that row, so the owner predicate is the sole defence.
- **Fix**: Make the INSERT probes require exactly 42501.
  1. In the new "As D" block of Phase 1 §3 (C has no targets row), add an insert of `(user_id = C, household_id = c_household, …valid numbers…)`. It must raise `insufficient_privilege` and nothing else: catch `when insufficient_privilege then null`, and `raise exception 'partner could insert targets for the other member'` if the insert succeeds. Any other SQLSTATE propagates.
  2. In Phase 1 §2, narrow the A→B insert probe with A's household to `insufficient_privilege` only. Keep `foreign_key_violation` acceptable only for an extra probe that uses a non-member `user_id`, if one is added.
- **Decision**: FIXED. The Fix was applied. The A→B insert probes in Phase 1 §2 now require exactly `insufficient_privilege`, with the handler narrowed. Phase 1 §3's "As D" block adds the strict probe of D inserting for C.

### F2 — The non-vacuity check (1.4) cannot be run as written on a cloud-only project

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1, Manual Verification (Progress 1.4); Phase 1 §3 contract
- **Detail**:
  - **The first suggested method is not available.** It is "drop `on update cascade` from a scratch copy of the migration". CLAUDE.md forbids a local stack, and the only database is the hosted project, which is also production. A scratch migration copy can only be exercised by `db push`-ing a different schema to production.
  - **The fallback proves nothing about the cascade.** "Invert the cascade assertion" only shows that the assertion can fail. It does not show that it is the cascade that makes it pass.
  - **The expected message is undefined.** Step 1.4 expects the "targets did not follow the redeemer" message, but §3 never fixes that exception text.
  - **The constraint has no name.** The FK is anonymous in the contract, so a test cannot reliably drop it.
- **Fix**:
  1. **Name the constraint in the migration contract:** `constraint macro_targets_membership_fkey foreign key (household_id, user_id) references public.household_members (household_id, user_id) on update cascade on delete cascade`.
  2. **Fix the assertion text in §3:** `raise exception 'redeem: targets did not follow the redeemer: D''s row is in household %, expected %', …`.
  3. **Rewrite 1.4 as follows:**
     - Temporarily insert `alter table public.macro_targets drop constraint macro_targets_membership_fkey;` directly after `begin;` in `household_isolation.sql`.
     - Run `npm run test:rls`, and confirm it fails with that exact message. The plain `household_id` FK keeps D's row valid in `d_household`, so the row is stranded rather than erroring.
     - Revert the line.
     - The whole file runs in a rolled-back transaction, so nothing persists on the hosted project. The DDL holds an `ACCESS EXCLUSIVE` lock on the new, still-empty table only for the test's duration.
- **Decision**: FIXED. The Fix was applied:
  - The FK is named `macro_targets_membership_fkey` in the contract.
  - §3 fixes the exception text as `redeem: targets did not follow the redeemer: …`.
  - The 1.4 manual step and its Progress row are rewritten as an in-transaction `drop constraint` run.

### F3 — `on delete cascade` makes any future delete-and-reinsert membership move destroy per-person data

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 §1 (migration header) and Phase 4 §1 (CLAUDE.md bullet)
- **Detail**:
  - The composite FK's correctness depends on one property: a membership move is an **UPDATE** of `household_members.household_id`, which is what `redeem_household_invite()` does today (`:296-298`).
  - Suppose any future slice (a leave or unlink path, a "move to a different household" flow, which the KD008 comment at `household_invites.sql` explicitly anticipates "needs its own slice", or an admin repair script) moves a person by `delete` + `insert` of their membership row. Then `on delete cascade` silently deletes their targets, and later their S-06 ratings.
  - Nothing in the planned CLAUDE.md text warns about this. The planned bullet says only "never add a per-table move step to the function".
- **Fix**:
  1. Add one sentence to the Phase 4 CLAUDE.md per-person bullet: "Membership moves must stay a single `update … set household_id` of the `household_members` row; deleting and re-inserting a membership cascades away every per-person row for that user."
  2. Put the same sentence in the migration's header comment.
- **Decision**: FIXED. The Fix was applied. The membership-move warning sentence is now in the intent for the Phase 1 §1 migration header and in the Phase 4 CLAUDE.md per-person bullet.

### F4 — The error redirect contract needs explicit URL-encoding, and the race comment names the wrong SQLSTATE

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 §2 (service) and §3 (API route contract)
- **Detail**:
  - **Encoding.** The contract writes the failure redirect as `/targets?error=` + `"Enter whole numbers: calories 1–9999, …"`. The message contains en-dashes (U+2013). A raw non-Latin-1 character in a `Location` header makes `Headers` throw, which turns the redirect into a 500. `redeem.ts` always wraps the message in `encodeURIComponent`, but the plan's contract does not say so. The smoke `fat_g: ""` step would catch the mistake, but only after the fact.
  - **SQLSTATE.** The service contract says a redemption race surfaces as `23503`. Suppose a redemption commits between the household read and the upsert. RLS `WITH CHECK` runs before FK checks, so the error is actually `42501`: on the insert path, the stale `household_id` is no longer in `user_household_ids()`, and on the conflict path the new row's `household_id` fails the update `with check`. Either error maps to the same generic message, so only the comment would mislead a future maintainer.
- **Fix**:
  1. In Phase 2 §3, write the redirects as ``context.redirect(`/targets?error=${encodeURIComponent(INVALID_TARGETS)}`)`` and ``context.redirect(`/targets?error=${encodeURIComponent(SAVE_FAILED)}`)``, with both messages as named constants, matching `redeem.ts`.
  2. In Phase 2 §2, change "including a `23503` from a redemption race" to "including a `42501` (RLS `WITH CHECK`, the usual outcome) or `23503` from a redemption race".
- **Decision**: FIXED. The Fix was applied:
  - Phase 2 §3 now wraps the `INVALID_TARGETS` and `SAVE_FAILED` constants in `encodeURIComponent`.
  - The Phase 2 §2 race comment names `42501` as the usual outcome, or `23503`.

### F5 — Partial read failures on `/targets` are not specified

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 §5 (targets page)
- **Detail**:
  - **The page makes two independent reads.** `getCurrentHousehold()` supplies the member count, and `getHouseholdMacroTargets()` supplies the values. The plan specifies one fallback for "a read failure": "Targets are unavailable right now." and an empty form.
  - **The plan does not say which read, or what each testid shows when only one read fails.**
  - **The members read can fail alone.** Then "Not linked yet" and "Not set yet" cannot be told apart, and an implementer may default `memberCount` to 0 the way `dashboard.astro:39` does. That would render a false "Not linked yet" for a linked user.
- **Fix**: Specify the three cases in the Phase 2 §5 contract:
  - **Targets read fails:** `targets-mine` and `targets-partner` both read "Targets are unavailable right now.", and the form renders empty.
  - **Household read fails but targets succeed:**
    - `targets-mine` renders normally.
    - `targets-partner` shows the partner's values if any visible row has `user_id ≠ Astro.locals.user.id`.
    - Otherwise `targets-partner` reads "Partner information is unavailable right now." It never shows "Not linked yet" or "Not set yet" in this case.
  - **Both reads succeed:** the behaviour is as planned.
- **Decision**: FIXED. The Fix was applied:
  - Phase 2 §5 now specifies the three read-failure cases.
  - When the household read fails, the partner line falls back to "Partner information is unavailable right now."
  - `memberCount` is never defaulted to 0.
