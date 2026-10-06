# Household-Scoped Data Access Implementation Plan

## Overview

Roadmap F-01. Introduce the household concept so that every account belongs to exactly one household (a household of one at sign-up), and establish the row-level-security pattern that every later household-owned table (targets, recipes, plans, shopping lists…) copies. No domain tables are added here.

## Current State Analysis

- Supabase has only `supabase/config.toml` (`project_id = "10x-astro-starter"`, Postgres 17, `enable_confirmations = false`). No migrations, no schema, no `seed.sql`.
- Auth is plain email + password: `src/pages/api/auth/signup.ts` calls `supabase.auth.signUp`, `src/middleware.ts` resolves `context.locals.user` and guards `PROTECTED_ROUTES` (`/dashboard`).
- `src/types.ts` does not exist yet; `src/lib/services/` does not exist yet.
- No test runner. Verification today = `npm run lint`, `npx astro check`, `npm run build`, `npm run smoke` (HTTP auth flow; CI runs it against a local Supabase started with `supabase start`, which applies migrations).
- Supabase CLI 2.117 provides `supabase db query --local -f <file>` — runs SQL against the local stack without needing `psql` (not installed on the dev machine).

## Desired End State

- Signing up creates, atomically, one `households` row and one `household_members` row linking the new user to it.
- An authenticated user can read only their own household and its membership rows; they cannot insert/update/delete either table directly. Anonymous users see nothing.
- A single helper, `private.user_household_ids()`, is the one place that answers "which households does the caller belong to"; later tables write `household_id in (select private.user_household_ids())` in their policies. S-12 (AI agent "system") will extend this one function.
- The pattern is documented in `CLAUDE.md` so every future migration follows it.
- `npm run test:rls` proves isolation between two households; CI runs it.
- `/dashboard` shows the current user's household (via `src/lib/services/household.ts`).

### Key Discoveries:

- `supabase/config.toml:13` exposes only `public` and `graphql_public` through the API — a `private` schema is therefore not reachable via PostgREST, which is what makes a `SECURITY DEFINER` helper safe to keep there.
- Supabase grants all privileges on new `public` tables to `anon`/`authenticated` by default; RLS without a policy denies, but revoking write grants on the two membership tables adds defence in depth.
- `scripts/smoke.mjs` signs up a fresh user — once the trigger exists, a broken trigger makes the "signup creates account" step fail, so the smoke test already guards trigger regressions.
- `.github/workflows/ci.yml` smoke job excludes many services in `supabase start -x …` but keeps the DB — `supabase db query --local` works there.

## What We're NOT Doing

- Invite / join / leave flows, or what happens to a partner's solo household on join (S-01).
- Per-person data: display names, A/B labels, macro targets (S-02).
- Any domain table (products, recipes, plans) (F-02, S-03+).
- The AI agent identity, connection, or "system" attribution (S-12) — only leaving one extension point.
- Cleaning up orphaned households when an account is deleted.
- Generated Supabase TypeScript types (`supabase gen types`) — hand-written types are enough for two tables.
- Resolving the household in middleware on every request.

## Implementation Approach

Database-first. One migration owns the schema, helper, policies, sign-up trigger and backfill so the invariant "every user has a household" holds from the moment the migration applies. A plain-SQL test, run in a rolled-back transaction, impersonates two users to prove isolation and doubles as the template for testing later tables. The app layer gets a thin read-only service and a visible dashboard line, nothing more.

## Critical Implementation Details

- **Security-definer lockdown**: both `private` functions must be `SECURITY DEFINER` with `set search_path = ''` and fully qualified names (`public.household_members`, `auth.uid()`). Revoke `execute` from `public` and `anon`; grant `usage` on schema `private` and `execute` on `user_household_ids()` to `authenticated` only. The trigger function needs no grants (it runs as the trigger owner).
- **Recursion**: the `household_members` select policy must call the helper, never a subquery on `household_members` itself — the definer function bypasses RLS and breaks the cycle.
- **Policy performance form**: use `household_id in (select private.user_household_ids())` (the sub-select lets Postgres evaluate it once per statement as an initPlan) rather than calling a per-row boolean function.
- **Test impersonation**: inside the transaction, `set local role authenticated` plus `select set_config('request.jwt.claims', json_build_object('sub', <uid>, 'role', 'authenticated')::text, true)`; switch users with `reset role` and repeat. Test users are inserted into `auth.users` as `postgres` (at minimum `id`, `email`, `aud = 'authenticated'`, `role = 'authenticated'`), which fires the trigger.

## Phase 1: Schema, Trigger & Access Policies

### Overview

Single migration that creates the household model, the access helper, per-operation/per-role policies, the sign-up trigger and a backfill; plus documenting the reusable pattern.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/20261006120000_household_data_scope.sql`

**Intent**: Create the household model and make "every account has exactly one household" an enforced database invariant, with RLS that restricts reads to members and forbids direct client writes.

**Contract**:
- `create schema private` (not added to API schemas).
- `public.households (id uuid pk default gen_random_uuid(), created_at timestamptz not null default now())`.
- `public.household_members (household_id uuid not null references public.households on delete cascade, user_id uuid not null unique references auth.users on delete cascade, joined_at timestamptz not null default now(), primary key (household_id, user_id))` — `unique(user_id)` enforces one household per person.
- RLS enabled on both tables. Policies:
  - `households`: `select` `to authenticated` `using (id in (select private.user_household_ids()))`.
  - `household_members`: `select` `to authenticated` `using (household_id in (select private.user_household_ids()))` (members see their partner's row once S-01 links them).
  - No `insert`/`update`/`delete` policies for any role, and no policies for `anon` — documented in a SQL comment as intentional (writes happen only via definer functions: the trigger now, the S-01 join function later). Revoke `insert, update, delete` on both tables from `anon, authenticated`; revoke all from `anon`.
- `private.user_household_ids() returns setof uuid language sql stable security definer set search_path = ''` — returns `household_id` from `public.household_members` where `user_id = (select auth.uid())`. Comment marks it as the single extension point for the AI agent (S-12).
- `private.handle_new_user() returns trigger language plpgsql security definer set search_path = ''` — inserts a household, then a membership for `new.id`; returns `new`.
- `create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user()`.
- Backfill: for every `auth.users` row without a membership, create a household and membership (idempotent via `not exists`).

#### 2. Pattern documentation

**File**: `CLAUDE.md`

**Intent**: Make the household-scoping rule discoverable so every later migration copies it instead of inventing its own.

**Contract**: New bullet under `## Hard rules` — "Household-scoped tables": column `household_id uuid not null references public.households on delete cascade` (indexed); RLS policies per operation `to authenticated` using/with check `household_id in (select private.user_household_ids())`; no `anon` policies; never query `household_members` directly in a policy; extend the isolation test (`supabase/tests/household_isolation.sql`) for each new table. One-line pointer in `## Architecture` that `households`/`household_members` exist and households are created by the sign-up trigger.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly on a fresh DB: `npx supabase db reset`
- Supabase security advisors report no new issues for these tables/functions: `npx supabase db advisors --local` (or `npx supabase db lint` if advisors is unavailable locally)
- Smoke test still passes against the dev server (sign-up goes through the trigger): `npm run smoke`
- Lint passes: `npm run lint`

#### Manual Verification:

- In Studio (`http://localhost:54323`), a newly signed-up user has exactly one `households` row and one `household_members` row.
- Users that existed before the migration (if any) were backfilled with their own household.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Household Isolation Test

### Overview

An SQL script that proves the RLS pattern works for two households, runnable locally and in CI, and serving as the template for testing every later table.

### Changes Required:

#### 1. Isolation test script

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Assert, in a transaction that is always rolled back, that the trigger and policies give each user exactly their own household and nothing else.

**Contract**: `begin; … rollback;` wrapping `DO` blocks that `raise exception` with a descriptive message on any failed assertion. As `postgres`, insert two test users into `auth.users`. Then assert:
- Trigger: each user has exactly one membership and distinct households.
- As user A: sees exactly 1 row in `households` (own) and only own-household rows in `household_members`; B's household id is not visible.
- As user A: `insert` into `households` and `household_members`, `update`/`delete` on own rows — each fails with a permission error or affects 0 rows (assert accordingly).
- As `anon` (no `sub` claim): 0 rows in both tables.
- As `authenticated`, calling `private.user_household_ids()` returns only A's household; as `anon`, execution is denied.
- Ends with a `raise notice` summary so a passing run is visible.

#### 2. npm script

**File**: `package.json`

**Intent**: One command to run the isolation test against the local stack, cross-platform (no psql).

**Contract**: `"test:rls": "supabase db query --local -f supabase/tests/household_isolation.sql"`.

#### 3. CI step

**File**: `.github/workflows/ci.yml`

**Intent**: Run the isolation test on every push/PR so a later migration can't silently break household privacy.

**Contract**: In the `smoke` job, a new step after "Start local Supabase": `supabase db query --local -f supabase/tests/household_isolation.sql`.

#### 4. Docs

**File**: `CLAUDE.md` (`## Commands`) and `README.md` (Available Scripts; replace the "No database tables or migrations are required" sentence)

**Intent**: Document `npm run test:rls` and that the DB now has migrations.

**Contract**: One bullet each; README sentence updated to say migrations are applied by `supabase start` / `supabase db reset`.

### Success Criteria:

#### Automated Verification:

- Isolation test passes: `npm run test:rls`
- Test actually fails when isolation is broken: temporarily change the `households` select policy to `using (true)` (or comment out the trigger), run `npm run test:rls`, confirm non-zero exit with a descriptive message, then revert
- Test leaves no residue: after a run, `npx supabase db query --local "select count(*) from auth.users where email like '%@rls-test.local'"` returns 0
- Lint passes: `npm run lint`

#### Manual Verification:

- CI smoke job shows the new step passing on the pushed branch/PR.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: App Layer — Household Service & Dashboard

### Overview

A read-only service that later slices use as the entry point for "current household", and a visible confirmation on the dashboard.

### Changes Required:

#### 1. Shared types

**File**: `src/types.ts` (new)

**Intent**: Home for shared entity types per project convention.

**Contract**: `Household { id: string; createdAt: string; members: HouseholdMember[] }`, `HouseholdMember { userId: string; joinedAt: string }`.

#### 2. Household service

**File**: `src/lib/services/household.ts` (new)

**Intent**: Single place that queries household data; pages and API routes must not call `supabase.from(...)` directly.

**Contract**: `getCurrentHousehold(supabase: SupabaseClient): Promise<Household | null>` — selects the caller's household with its members (RLS scopes the result; no explicit user filter needed); returns `null` when no row (unauthenticated) and throws on query error.

#### 3. Dashboard

**File**: `src/pages/dashboard.astro`

**Intent**: Visible proof that the signed-in user belongs to a household.

**Contract**: Create the client with `createClient(Astro.request.headers, Astro.cookies)`, call `getCurrentHousehold`, render a line such as "Household: <short id> · <n> member(s)". If the result is `null` or the query throws, render a neutral fallback message instead of failing the page (keeps the smoke step "dashboard renders for signed-in user" at 200).

### Success Criteria:

#### Automated Verification:

- Type check passes: `npx astro check`
- Lint passes: `npm run lint`
- Build passes: `npm run build`
- Smoke test passes: `npm run smoke`

#### Manual Verification:

- Sign up a new account, open `/dashboard`: it shows a household with 1 member.
- Sign up a second account in another browser: its dashboard shows a different household id.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- None — no JS test runner exists and the service is a thin query; adding a framework is out of scope.

### Integration Tests:

- `supabase/tests/household_isolation.sql` — trigger invariant, cross-household read isolation, client write denial, anon denial, helper function grants.
- `npm run smoke` — sign-up end-to-end through the trigger; dashboard renders with the service call.

### Manual Testing Steps:

1. `npx supabase db reset`, start `npm run dev`, sign up user A → dashboard shows household, 1 member.
2. Sign up user B in a private window → dashboard shows a different household.
3. In Studio, confirm two households and two membership rows.

## Performance Considerations

The helper is `stable` and used as `in (select …)`, so Postgres evaluates it once per statement. `household_members.user_id` is unique (indexed) and `household_id` leads the primary key, so both lookup directions are indexed.

## Migration Notes

First migration in the repo. Includes a backfill so any accounts already in a local or cloud project get a household. Rollback = drop trigger, functions, tables and schema `private` (no other objects depend on them yet).

## References

- Roadmap: `context/foundation/roadmap.md` (F-01)
- PRD: `context/foundation/prd.md` (Access Control, NFR household privacy)
- Sign-up path: `src/pages/api/auth/signup.ts`
- Smoke test: `scripts/smoke.mjs`
- CI: `.github/workflows/ci.yml`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema, Trigger & Access Policies

#### Automated

- [x] 1.1 Migration applies cleanly on a fresh DB: `npx supabase db reset`
- [x] 1.2 Supabase security advisors report no new issues for these tables/functions
- [x] 1.3 Smoke test still passes against the dev server: `npm run smoke`
- [x] 1.4 Lint passes: `npm run lint`

#### Manual

- [x] 1.5 New user has exactly one household and one membership row in Studio
- [x] 1.6 Pre-existing users were backfilled with their own household

### Phase 2: Household Isolation Test

#### Automated

- [ ] 2.1 Isolation test passes: `npm run test:rls`
- [ ] 2.2 Test fails when isolation is deliberately broken, then reverted
- [ ] 2.3 Test leaves no residue in `auth.users`
- [ ] 2.4 Lint passes: `npm run lint`

#### Manual

- [ ] 2.5 CI smoke job shows the new step passing

### Phase 3: App Layer — Household Service & Dashboard

#### Automated

- [ ] 3.1 Type check passes: `npx astro check`
- [ ] 3.2 Lint passes: `npm run lint`
- [ ] 3.3 Build passes: `npm run build`
- [ ] 3.4 Smoke test passes: `npm run smoke`

#### Manual

- [ ] 3.5 New account's dashboard shows a household with 1 member
- [ ] 3.6 Second account's dashboard shows a different household id
