# Household-Scoped Data Access — Plan Brief

> Full plan: `context/changes/household-data-scope/plan.md`

## What & Why

Roadmap F-01. Every account must belong to a household, and all household data must be visible only to that household's members (PRD NFR). This foundation lands before any domain table, so recipes, plans and targets can be household-scoped from their first migration instead of being retrofitted.

## Starting Point

Email + password auth via Supabase SSR works (`signup.ts`, `middleware.ts`), but the database is empty: no migrations, no schema, no test runner. Verification today is lint, `astro check`, build and an HTTP smoke test.

## Desired End State

Signing up automatically creates a household of one. A user can read only their own household and members, and can't write either table directly. One helper function defines "my households", and every later table's access rules reuse it. An SQL test proves two households can't see each other and runs in CI. The dashboard shows the current household.

## Key Decisions Made

| Decision           | Choice                                                      | Why (1 sentence)                                                                     |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Household creation | DB trigger on `auth.users` (security definer)               | Atomic and works for every sign-up path, so no account can exist without a household. |
| Data model         | `households` + `household_members` (`user_id` unique)       | Clean join point for S-01 invites; one household per person enforced by the DB.       |
| RLS pattern        | `household_id in (select private.user_household_ids())`     | No recursion, evaluated once per query, one function to extend for the AI agent.      |
| Client writes      | None on membership tables (no policies, grants revoked)     | Changes go only through definer functions (trigger now, S-01 join later).             |
| Isolation proof    | Plain SQL test, rolled-back transaction, `supabase db query` | No new dependencies; runs on Windows and in CI; template for later tables.            |
| App layer          | `services/household.ts` + dashboard line; no middleware     | Gives later slices an entry point without an extra DB call on every request.          |

## Scope

**In scope:**
- Migration: tables, `private` schema, helper, policies, sign-up trigger, backfill
- Household pattern written into `CLAUDE.md`
- `supabase/tests/household_isolation.sql`, `npm run test:rls`, CI step
- `src/types.ts`, `src/lib/services/household.ts`, dashboard display

**Out of scope:**
- Invites, joining and leaving (S-01); names, A/B labels and targets (S-02)
- Domain tables; the AI-agent identity (S-12 extends the helper)
- Orphaned-household cleanup; generated DB types; resolving the household in middleware

## Architecture / Approach

`auth.users` insert → trigger `private.handle_new_user()` → `households` + `household_members`. Access rules on every household table call `private.user_household_ids()`, a security-definer function in a schema the API doesn't expose. It returns the caller's household ids, so all access goes through one choke point. The app reads through `getCurrentHousehold()`, and RLS does the scoping.

## Phases at a Glance

| Phase                          | What it delivers                                      | Key risk                                                            |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------- |
| 1. Schema, trigger & policies  | Enforced "every user has a household" + RLS pattern    | A broken trigger blocks sign-up (caught by smoke)                    |
| 2. Isolation test              | `npm run test:rls` locally and in CI                   | `supabase db query` may not fail loudly; checked by deliberately breaking a rule |
| 3. App layer                   | Service + dashboard shows household                    | Low; the dashboard must still render if the query fails             |

**Prerequisites:** Docker + local Supabase (`npx supabase start`); Supabase CLI ≥ 2.117 (`db query`).
**Estimated effort:** ~1 session across 3 small phases.

## Open Risks & Assumptions

- Assumes `supabase db query --local -f` runs a multi-statement file with `begin … rollback` and exits non-zero on `raise exception`. Fallback: `docker exec -i supabase_db_10x-astro-starter psql -U postgres -v ON_ERROR_STOP=1 < file`.
- Deleting an account leaves its household behind. That's harmless for one couple and deferred.
- The partner's solo household when they join is S-01's decision; nothing here blocks either choice.

## Success Criteria (Summary)

- Every new account has its own household automatically, and sign-up still works (smoke passes).
- Two accounts in different households can't read or write each other's household data, proven by an automated test in CI.
- Later slices have a documented one-line rule to copy for any new household table.
