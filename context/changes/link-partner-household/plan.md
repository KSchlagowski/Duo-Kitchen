# Link Partner Into One Shared Household — Implementation Plan

## Overview

Roadmap slice **S-01**. One partner generates an invite code/link from the dashboard; the other redeems it and is moved into the inviter's household. Afterwards both accounts read and write the same products, recipes, plans and shopping lists — which the F-01/F-02 policy layer already delivers the moment the membership row moves.

Covers PRD **FR-002** (generate an invite code/link that the partner redeems to link both accounts into one household) and **FR-003** (linked persons see the same recipes, plans and shopping lists). FR-001 (sign-up/sign-in) and US-01's planning surface are already in place or out of this slice.

Grounding research: `context/changes/link-partner-household/research.md` (read in full). This plan resolves every one of its 12 Open Questions; see **Decisions Taken** below.

## Current State Analysis

Three migrations are live on the hosted project `tvmfkhnxxsnmvogplknz` (F-01 and F-02 both merged to `main` and pushed):

| Migration                                      | Owns                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261006120000_household_data_scope.sql`      | `private` schema, `households`, `household_members`, `private.user_household_ids()`, 2 select policies, `private.handle_new_user()` + `on_auth_user_created`, backfill |
| `20261007120000_products_and_recipes.sql`      | 4 enums, 5 household tables + 20 policies, 5 `private.seed_*` templates, `private.seed_household()`                                                                    |
| `20261007120100_seed_products_and_recipes.sql` | ~170 rows of template content + a backfill                                                                                                                             |

What this slice plugs into:

- `public.household_members.user_id` is `unique` (`20261006120000_household_data_scope.sql:29`, comment `-- unique: one household per person`). Redemption is therefore an **`update` of one row**, not an `insert`. A second row raises `unique_violation` (23505).
- F-01 reserved this exact slice in a comment: _"Membership changes happen only through security-definer functions: the sign-up trigger below now, the S-01 join function later."_ (`20261006120000_household_data_scope.sql:56-62`).
- Both existing select policies are already household-scoped, not user-scoped (`:71-83`), with the comment _"Members see their partner's row once S-01 links them."_ **FR-003 needs zero schema work** beyond the move.
- `dashboard.astro:29-31` already pluralizes `${memberCount} member${memberCount === 1 ? "" : "s"}` and `household.ts:8` already selects `household_members(user_id, joined_at)`. The dashboard will read "2 members" with no change to either.
- The sign-up trigger fires on `auth.users` inserts only. Redemption writes `household_members`, so `private.seed_household()` is never re-entered — the guarantee is incidental rather than enforced, so this plan asserts it in the isolation test.

What is missing: any invite storage, any client-callable function, any JSON or validation convention, `zod` (absent from `node_modules`; the four `package-lock.json` hits are transitive), and any component in `src/components/ui/` beyond `button.tsx`.

### Key Discoveries

- **The isolation test's catch-all forces the design** (`supabase/tests/household_isolation.sql:439-484`). It loops every `public` relkind `'r'` with a `household_id` attribute, exempting only `household_members` (`:457`), and raises if RLS is off, if any of SELECT/INSERT/UPDATE/DELETE lacks a policy `to authenticated`, or if **any** policy's `coalesce(qual,'') || coalesce(with_check,'')` does not contain the literal `user_household_ids`. A "redeemer reads the invite by code" policy is un-shippable by construction, which is the correct outcome.
- **The catch-all reads `pg_policies` only, never grants.** So a table can carry four conforming policies to satisfy the test while `revoke` makes insert/update/delete unreachable — exactly the belt-and-braces pairing F-01 already uses on `households`/`household_members` (`20261006120000_household_data_scope.sql:66-69`).
- **The redemption function cannot live in `private`.** The authority is the hosted project's **dashboard API settings** (Settings → API → Exposed schemas), which on a default Supabase project exposes `public` and `graphql_public` only; `supabase/config.toml:13` corroborates it but configures the _local_ stack, which CLAUDE.md forbids running. That is _why_ every definer helper sits in `private` (`20261006120000_household_data_scope.sql:7-9`). Because the premise is load-bearing for the whole design — and because a brand-new function must also be picked up by PostgREST's schema cache — Phase 1 proves it over the real transport rather than assuming it. There is **no function in `public` anywhere in the repo today** — this slice introduces the first. The alternative (an Astro route with a service-role client) is unavailable: `astro.config.mjs:17-22` declares only `SUPABASE_URL` and the anon `SUPABASE_KEY`, and no admin factory exists in `src/lib/supabase.ts`.
- **Supabase's default privileges grant `execute` on new `public` functions to `anon`.** The `revoke execute … from public, anon` / `grant execute … to authenticated` pair (modelled on `:53-54`) is **mandatory, not cosmetic**.
- **A true merge is forbidden by the schema, not merely expensive.** `unique (household_id, seed_id)` on all five data tables (`20261007120000_products_and_recipes.sql:50` and siblings) makes re-pointing the redeemer's ~170 seed rows collide on every row; and the composite FKs `(recipe_id, household_id)` / `(component_id, household_id)` (`:82,107-108,126-129`) default to `on update no action`, so changing a parent's `household_id` raises `foreign_key_violation` before any policy is consulted. F-02's plan review hit precisely this (`reviews/plan-review.md` F5).
- **Correction to research §8.** Of the four `tables text[]` / `foreach` literals the research says "must each gain `household_invites`", only **two** should:
  - `:74` — compares per-household `seed_id is not null` counts against `private.seed_*`. Invites have no `seed_id` and no template. **Do not add.**
  - `:246` — id-indexed read isolation over fixture ids `…a00%s`/`…b00%s`, `i` in 1..5. **Add as element 6**, with postgres-seeded fixture invites at `…a006`/`…b006`.
  - `:279` — cross-household _write_ attempts under policy. Invites are write-revoked, so these inserts would fail with `insufficient_privilege` rather than exercise policy behaviour. **Do not add**; write a tailored denial block mirroring `household_members` at `:179-237`.
  - `:427` — anon sees 0 rows. **Add.**
- **GUC staleness is the main test trap.** Household ids are discovered once and stashed in transaction-local GUCs (`:36-53`), then re-read by eight later blocks. A mid-test redemption makes the stashed id point at a now-memberless household. The redemption block must use **fresh users** and **new GUCs**, placed after all existing assertions.
- **The expect-denial idiom does not catch definer-function rejections.** The established form (`:186-190`) catches `insufficient_privilege`; a plpgsql `raise exception` is `P0001`. This plan defines distinct SQLSTATEs instead.
- **`eslint.config.js:73-78`** gives `scripts/**/*.mjs` an explicit globals allowlist of exactly `console`, `process`, `fetch`, `URLSearchParams`. _Environment_ globals outside that list (`crypto`, `URL`, `setTimeout`, `AbortController`, `TextDecoder`) trip `no-undef` and fail `npm run lint`. _Language_ built-ins (`Date`, `Map`, `RegExp`, `JSON`) come from `ecmaVersion` and are fine — the existing script already uses `Date.now()` and `new Map()`. This is the easiest way to break CI while editing the smoke script.
- **`.github/workflows/ci.yml` never runs `npx supabase db push`** (`:36-47`). CI runs `test:rls` against the _deployed_ schema, so the migration must be pushed to the hosted project **before** the PR carrying the new assertions, or `test:rls` fails on a missing table. CLAUDE.md states the rule; it bites concretely here.
- **`eslint.config.js:17` runs `tseslint.configs.strictTypeChecked`**, and there is no `database.types.ts` / `Database` generic. An untyped `supabase.rpc(...)` result trips `no-unsafe-assignment` / `no-unsafe-member-access` and needs an explicit cast at the service boundary, exactly as `src/lib/services/household.ts:19-24` does today.

## Decisions Taken

This session is non-interactive, so every open question is resolved here with its rationale. Each is a stated assumption the user can overturn on review; none blocks implementation.

| #   | Question (research §)                                          | Decision                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Merge vs. discard of pre-redemption data (§4)                  | **Orphan + guard.** Move the membership, leave the old household intact and memberless, stamp provenance on the invite row, and **refuse redemption if the redeemer's household holds any non-seed row**.                                                                                                                 | Non-destructive (satisfies `change.md`'s "at minimum not silently destroy it"), one `update`, reversible by `postgres`, and keeps the user-owned merge-vs-discard answer genuinely open. A merge is schema-forbidden today (see Key Discoveries) and there is nothing to merge: every slice that writes user data (S-02, S-03, S-05, S-07, S-09) is still `proposed`. The guard makes the slice forward-safe — once those slices ship, redemption fails loudly instead of orphaning data silently. |
| 2   | Invite storage: §2 Option A vs C                               | **Option A** — `public.household_invites`, four conforming policies, writes revoked from `authenticated`.                                                                                                                                                                                                                 | The only option needing no change to a shared test and no amendment to a CLAUDE.md hard rule, and the `select` policy recovers the inviter's "show / revoke my code" UI for free. Option C (table in `private`) is tighter but costs a third RPC and hand-written coverage; Option B (exempt the table) is rejected — it would expose every pending invite's `household_id` to every authenticated user.                                                                                           |
| 3   | How the code survives sign-up → confirm-email → sign-in (§7.4) | **Short-lived `httpOnly` cookie** `dk_invite` set by the unprotected `/join` page, max-age 7 days (= invite TTL). `/api/auth/signin` redirects to `/join` instead of `/` when the cookie is present.                                                                                                                      | Survives the email round-trip, which a threaded query param does not. Touches one auth route's redirect target and neither auth _page_.                                                                                                                                                                                                                                                                                                                                                            |
| 4   | One live invite per household, or many?                        | **One.** Partial unique index on `(household_id) where redeemed_at is null`; the create RPC **deletes** any existing unredeemed row for the caller's household before inserting.                                                                                                                                          | "Generate new code" always yields a fresh code and invalidates the previous one — one obvious live code, no dangling expired rows blocking regeneration. Note the index predicate cannot include `expires_at > now()` (not immutable), which is exactly why the RPC deletes rather than relying on the index alone.                                                                                                                                                                                |
| 5   | Expiry window                                                  | **7 days**, as a literal in the create RPC.                                                                                                                                                                                                                                                                               | Nothing in the PRD specifies it. 7 days covers a real-world "I'll do it tonight" without leaving codes live indefinitely, and matches the cookie max-age.                                                                                                                                                                                                                                                                                                                                          |
| 6   | Does the redemption screen show who invited you?               | **No.** `/join` shows "You've been invited to share a household."                                                                                                                                                                                                                                                         | `households` has no `name` and clients cannot read `auth.users`. A preview RPC would leak the inviter's email to any code holder, and inventing a `households.name` column is scope creep.                                                                                                                                                                                                                                                                                                         |
| 7   | Is `revoke`-on-a-policied-table too subtle?                    | **Comment it, and assert it.** A `comment on table` plus a comment block above the policies explaining they exist to satisfy the catch-all; and an isolation assertion that direct `insert`/`update`/`delete`/`truncate` as `authenticated` raises `insufficient_privilege`. Do **not** teach the catch-all about grants. | The executable assertion is what actually stops a future reader from "fixing" the revokes. Changing the shared catch-all is a larger, riskier edit that would affect every table.                                                                                                                                                                                                                                                                                                                  |
| 8   | Error convention for definer rejections (§8)                   | **Distinct custom SQLSTATEs in class `KD`** (see the table in Phase 1), not one `P0001`.                                                                                                                                                                                                                                  | Lets the isolation test assert the precise rejection reason (a wrong code propagates and fails the test) and lets the API route map each to a distinct user-facing message. Class `KD` is not in PostgreSQL's reserved class list, which covers `00`–`4x`, `A`–`H`, `P0`, `XX` and friends.                                                                                                                                                                                                        |
| 9   | Leave / unlink                                                 | **Out of scope**, per PRD and roadmap. Mitigation: `/join` requires an explicit confirm **POST**, never a one-click GET, so redemption is always deliberate.                                                                                                                                                              | Not in the PRD or roadmap, and impossible today (no update/delete path on `household_members`). Recorded in "What We're NOT Doing" with the consequence: a wrong redemption needs `postgres` to undo.                                                                                                                                                                                                                                                                                              |
| 10  | README cleanup query deletes exactly what this slice creates   | **Both** — a warning plus an amended query that spares households referenced by `household_invites.redeemed_from_household_id`, and a note to run it until it deletes 0 rows.                                                                                                                                             | F-02's impl-review already flagged this blind spot (_"once S-01 can leave a household temporarily memberless, revisit the query"_). Without the fix, a documented maintenance step deletes a partner's pre-redemption data.                                                                                                                                                                                                                                                                        |
| 11  | S-02 coupling (§9)                                             | **Record the expectation**: macro targets are keyed on `user_id` (scoped by `household_id` for RLS), so they travel with the person through redemption.                                                                                                                                                                   | S-02 owns the table; S-01 only needs to state the expectation so the two slices don't contradict. Matches PRD §Access Control: _"each person keeps their own macro targets and ratings (visible to the partner)"_.                                                                                                                                                                                                                                                                                 |
| 12  | Unverified tooling state                                       | **Phase 0 prerequisite**: `npm ci`, `.env`/`.dev.vars`, `npx supabase link --project-ref tvmfkhnxxsnmvogplknz`.                                                                                                                                                                                                           | This checkout has no `node_modules`, no env files and is not linked, so nothing in the research was executed.                                                                                                                                                                                                                                                                                                                                                                                      |

Additional decisions not in the research's question list:

- **Code format: 16 lowercase hex characters** from `substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)` (64 bits). Chosen over `encode(extensions.gen_random_bytes(8), 'hex')` because it carries **no extension dependency**: `gen_random_uuid()` is a pg13+ built-in resolvable under `set search_path = ''`, and the existing migrations already rely on it for PK defaults. `gen_random_bytes` lives in `extensions` on Supabase and `extra_search_path` (`config.toml:15`) applies to API requests, not to a definer function with an empty search path — one more qualification to get wrong for no gain.
- **Plaintext code storage.** The table is readable only by the inviter's own household, which is precisely who must see it. Hashing would break the inviter's "show me my code" UI without an extra column, for no threat this app faces. The whole threat model is 64 bits of entropy + single use + 7-day expiry; no rate limiting exists anywhere in the stack and none is warranted for a two-person app.
- **Two-member cap lives in the RPCs, not the schema.** Both `create_household_invite()` and `redeem_household_invite()` refuse at 2 members. The RPCs are the only write path to `household_members`, so this is sufficient. It is explicitly **not** a DB invariant — a real one would be a counting trigger, and the PRD's "single couple" is a product statement, not a durability requirement.
- **`zod` is installed in this slice** and sets the first validation convention, because CLAUDE.md mandates it for API routes and it is currently absent. The three existing auth routes are **not** retrofitted.
- **No new React islands.** The invite UI is server-rendered into `dashboard.astro` and `join.astro` with native `<form method="POST">`, keeping the redirect-with-`?error=` convention and requiring no `fetch()` anywhere (there is none in the codebase today). Consequence: no copy-to-clipboard button — the link is rendered as selectable text.

## Desired End State

On the hosted project and the deployed app:

1. A signed-in member of a one-person household sees an invite section on `/dashboard` with a 16-hex code and a shareable `/join?code=…` link, plus a "Generate new code" control that replaces it.
2. Their partner opens the link, signs up or signs in (surviving the email-confirmation round-trip), lands back on `/join`, clicks one confirm button, and is moved into the inviter's household.
3. Both dashboards then read `Household: <same 8-char prefix> · 2 members` and the **same** library counts, and the invite section is replaced by a "linked" state.
4. The target household's seed row counts are **unchanged** by redemption (no re-seed, no duplicate seed set).
5. The redeemer's former household survives, memberless, with its rows intact, and the invite row records it in `redeemed_from_household_id`.
6. `npm run lint`, `astro check`, `npm run build`, `npm run test:rls`, `npm run test:seed` and `npm run smoke` all pass; the smoke run proves points 2–4 over HTTP with two independent cookie jars.

Verification: Phase success criteria below, plus the manual walkthrough in **Testing Strategy**.

## What We're NOT Doing

- **No merge or deletion of the redeemer's pre-redemption data.** Decision 1 defers the user-owned unknown deliberately. Merge remains the user's call and would need deferrable or cascading composite FKs plus `seed_id` deduping.
- **No leave / unlink / transfer path.** Not in the PRD or roadmap, and no update/delete surface on `household_members` exists. A wrong redemption is unrecoverable short of `postgres`.
- **No role model.** PRD §Access Control: _"Flat role model inside a household (no admin/member split)."_ No `role` / `is_owner` / `owner_id` column.
- **No `households.name` and no inviter-identity preview RPC** (Decision 6).
- **No DB-level member cap** (counting trigger). The cap is an RPC check only.
- **No rate limiting** on invite creation or redemption.
- **No hashing of invite codes.**
- **No copy-to-clipboard island, no toast, no new `shadcn/ui` components.** The slice adds zero React components.
- **No retrofit of the three auth routes** to zod, and no change to `signup.ts` or `signout.ts` beyond what the cookie requires (which is nothing — only `signin.ts`'s redirect target changes).
- **No multi-household membership.** `household_members_user_id_key` stays; dropping it would also break `getCurrentHousehold`'s `.maybeSingle()`.
- **No change to the isolation test's catch-all** (`:439-484`) or its exemption predicate (`:457`).
- **No service-role key** anywhere (env schema, repo secrets, Cloudflare).
- **No macro targets, plans, ratings or solver work** — S-02, S-03, S-04, S-06 own those. This slice only states the S-02 keying expectation (Decision 11).
- **No test runner.** Verification stays in `household_isolation.sql`, `seed_integrity.sql` and `scripts/smoke.mjs`, consistent with F-01's and F-02's explicit decisions.

## Implementation Approach

Follow the choke point F-01 built and reserved: **all reads funnel through `private.user_household_ids()`; all membership writes funnel through `security definer` functions.** This slice is the first consumer of the second half, and it adds the one new architectural surface the design always implied — a `public` definer RPC, because `private` is not API-reachable.

The sequencing is driven by one hard external constraint: **CI runs `test:rls` against the deployed schema, not the branch's migrations.** So the migration is written and pushed to the hosted project _before_ the test assertions that depend on it, inside Phase 1. Everything after Phase 1 is ordinary app work against a live schema.

Four phases, each independently verifiable:

1. **SQL** — table, index, RLS, policies, revokes, two RPCs, grants; push; then the isolation assertions. The whole security posture is provable here, before a line of TypeScript.
2. **App layer** — `zod`, types, one service, two API routes, the invite cookie, `/join`, the dashboard section. Ends with a hand-driven end-to-end join in a browser.
3. **Smoke** — a genuine refactor of `scripts/smoke.mjs` to support two accounts, then the ten new steps that prove FR-002 and FR-003 over HTTP.
4. **Docs** — CLAUDE.md, README (including the cleanup-query fix), and the `.claude/settings.json` allowlist entries F-02 still owes.

## Critical Implementation Details

**Ordering (Phase 1 is not reorderable).** Write the migration → `npx supabase db push` → _then_ add the isolation assertions → `npm run test:rls`. Adding the assertions first fails against the deployed schema. And once the migration is pushed, the catch-all starts exercising `household_invites` on **every open branch**, including branches that do not contain the migration file — so push close to merging, and expect `test:rls` on other branches to begin covering the new table immediately.

**Definer discipline for the two new `public` functions**, copied from `private.user_household_ids()` (`20261006120000_household_data_scope.sql:41-54`) and F-01's "Critical Implementation Details": `security definer`, `set search_path = ''`, **every** name fully qualified (`public.household_members`, `public.households`, `auth.uid()`), then `revoke execute … from public, anon` followed by `grant execute … to authenticated`. The revoke is load-bearing: Supabase's default privileges would otherwise leave both functions callable by `anon`.

**Atomicity.** `redeem_household_invite` must perform the membership `update` and the invite stamping in one function body so a crash cannot leave a redeemed-but-unmoved or moved-but-unstamped state. Lock the invite row with `select … for update` before validating, so two concurrent redemptions of the same code cannot both pass the `redeemed_at is null` check. `create_household_invite` needs the same discipline on its own delete-then-insert, serialising on the caller's `households` row (see Phase 1 change 3).

**The non-seed guard catches additions, not deletions.** It refuses redemption when the redeemer's household holds a row with `seed_id is null`. A household that _deleted_ seed rows passes the guard and loses those deletions silently. Nothing can delete seed rows today (S-05 is `proposed`), but the slice that enables it must revisit this guard — worth a comment in the RPC body.

## Phase 0: Prerequisites

### Overview

This checkout is not ready to run anything. Do this before Phase 1.

### Changes Required:

No files change. Run, in order:

- `npm ci`
- `cp .env.example .env` and `cp .env.example .dev.vars`, filling `SUPABASE_URL=https://tvmfkhnxxsnmvogplknz.supabase.co` and the anon `SUPABASE_KEY`
- `npx supabase link --project-ref tvmfkhnxxsnmvogplknz`
- Confirm the baseline is green before changing anything: `npm run lint`, `npx astro check`, `npm run test:rls`, `npm run test:seed`

### Success Criteria:

#### Automated Verification:

- `npm ci` completes and `node_modules` exists
- `npm run lint` passes on the unmodified checkout
- `npx astro check` passes on the unmodified checkout
- `npm run test:rls` passes against the hosted project
- `npm run test:seed` passes against the hosted project

---

## Phase 1: Invite schema, redemption RPCs and isolation coverage

### Overview

Everything that enforces the security posture. At the end of this phase, membership movement is possible, correct and proven in SQL — with no app code.

### Changes Required:

#### 1. The invite table

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_household_invites.sql` (new; timestamp must sort after `20261007120100`)

**Intent**: Add `public.household_invites` as a household-scoped table holding one live bearer code per household plus the provenance of a completed redemption. Follow the F-02 house style exactly: lowercase SQL, 2-space indent, `comment on table`, a section-banner comment per block.

**Contract**: Columns —
`id uuid primary key default gen_random_uuid()`;
`household_id uuid not null references public.households on delete cascade` (the CLAUDE.md hard rule);
`code text not null unique`;
`created_by uuid references auth.users on delete set null` — **not** `not null` and **not** `on delete cascade`, matching `redeemed_by` below. A cascade here would take the whole invite row away when the inviter's account is deleted, and with it the `redeemed_from_household_id` that Phase 4's amended cleanup query relies on to spare the redeemer's preserved household — turning one account deletion into silent collateral loss on the next maintenance run (and making Phase 4 manual 4.4 never exercise the sparing branch, since `delete from auth.users where email like 'smoke-%@example.com'` would remove the invite rows first). Anything reading `created_by` must therefore handle null;
`created_at timestamptz not null default now()`;
`expires_at timestamptz not null`;
`redeemed_at timestamptz`;
`redeemed_by uuid references auth.users on delete set null`;
`redeemed_from_household_id uuid references public.households on delete set null`.

Two indexes. An **explicit** `create index household_invites_household_id_idx on public.household_invites (household_id)` — F-02 satisfied the hard rule implicitly via a leading-column composite unique (`20261007120000_products_and_recipes.sql:49-50`), but with no `seed_id` here there is no such index to lean on. And the one-live-invite constraint, whose predicate is deliberately single-column:

```sql
-- Only one unredeemed invite per household. The predicate cannot include
-- `expires_at > now()` (not immutable), which is why create_household_invite()
-- deletes the previous unredeemed row rather than relying on this index alone.
create unique index household_invites_one_unredeemed_idx
  on public.household_invites (household_id)
  where redeemed_at is null;
```

`comment on table` must state that the table is written only by security-definer functions and that the insert/update/delete policies below exist to satisfy the isolation catch-all (Decision 7).

#### 2. RLS, policies and revokes

**File**: same migration

**Intent**: Give the table the four conforming policies the catch-all demands, then revoke the grants that would make three of them reachable — so clients can read their own household's invites and nothing more.

**Contract**: `alter table … enable row level security`; `revoke all on public.household_invites from anon`; `revoke insert, update, delete, truncate, references, trigger on public.household_invites from authenticated` (note `truncate` bypasses RLS, per the F-01/F-02 precedent at `20261007120000_products_and_recipes.sql:144-146`); four policies named `household_invites_{select,insert,update,delete}_authenticated`, each `to authenticated`, each predicate `household_id in (select private.user_household_ids())` — copying the template at `20261007120000_products_and_recipes.sql:167-179` verbatim. `select` stays granted; that is the inviter's read path.

The counterintuitive pairing is the one thing worth spelling out in the file:

```sql
-- Policies + revokes are independent levers (F-01 precedent, 20261006120000:66-69):
-- the policies below satisfy supabase/tests/household_isolation.sql's household_id
-- catch-all, which inspects pg_policies only; the revokes above make the
-- insert/update/delete ones unreachable. Writes go through the definer RPCs only.
-- Do not "simplify" by dropping either half.
```

#### 3. `public.create_household_invite()`

**File**: same migration

**Intent**: Let a member of a one-person household mint a fresh code for their own household, replacing any previous unredeemed one. Creation goes through an RPC rather than a plain insert under the insert policy so that code entropy, the expiry window and the one-live-invite rule stay server-controlled — and so the revokes in change 2 can stand.

**Contract**: `create function public.create_household_invite() returns text`, `language plpgsql`, `security definer`, `set search_path = ''`. Body: resolve the caller's household via `private.user_household_ids()` (raise `KD007` if none); raise `KD005` if that household already has 2 members; serialise on the household row with `perform 1 from public.households where id = v_household for update;` — matching the locking discipline mandated for redemption, and necessary because two concurrent calls (a double-clicked "Generate new code") would otherwise both find nothing to delete or both re-insert, and the loser would hit `household_invites_one_unredeemed_idx` with `unique_violation` (23505), which is not in the `KD0xx` table and so can only surface as `inviteErrorMessage`'s neutral fallback. With the lock, the second caller simply mints the next code and no new SQLSTATE is needed. Then `delete from public.household_invites where household_id = <caller's> and redeemed_at is null`; insert with `expires_at = now() + interval '7 days'`, `created_by = (select auth.uid())` and the generated code; return the code.

Code generation — the choice is deliberate, so pin it:

```sql
-- 64 bits, no extension dependency: gen_random_uuid() is a pg13+ built-in and so
-- resolves under `set search_path = ''`. extensions.gen_random_bytes() would also
-- work but needs schema qualification that extra_search_path does not supply here.
v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
```

Then `revoke execute on function public.create_household_invite() from public, anon;` and `grant execute on function public.create_household_invite() to authenticated;`.

#### 4. `public.redeem_household_invite(p_code text)`

**File**: same migration

**Intent**: The S-01 join function F-01 reserved. Validate a bearer code and move the caller's single membership row into the invite's household, atomically, stamping provenance.

**Contract**: `create function public.redeem_household_invite(p_code text) returns uuid`, `language plpgsql`, `security definer`, `set search_path = ''`. Returns the target `household_id`. The caller's household id is resolved **once** into a local `v_origin_household` before any write, and that local — never a re-call of `private.user_household_ids()` — is what the `KD004` / `KD006` checks and the provenance stamp use. (`private.user_household_ids()` is `stable` and each plpgsql statement runs with a fresh snapshot, so re-calling it after the membership `update` would return the _target_ household and silently stamp the wrong provenance.)

Validations, each raising its own SQLSTATE, in this order:

| SQLSTATE | Condition                                                                                                                                         | Message intent                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `KD007`  | `auth.uid()` is null, or the caller has no household                                                                                              | "You need an account to join a household."                                         |
| `KD001`  | no row with `code = p_code`                                                                                                                       | "That invite code is not valid."                                                   |
| `KD003`  | `redeemed_at is not null`                                                                                                                         | "That invite code has already been used."                                          |
| `KD002`  | `expires_at <= now()`                                                                                                                             | "That invite code has expired."                                                    |
| `KD004`  | the invite's household is already the caller's                                                                                                    | "You are already in that household."                                               |
| `KD005`  | the invite's household has 2 or more members                                                                                                      | "That household already has two members."                                          |
| `KD006`  | the caller's household holds any row with `seed_id is null` in `products`, `recipes`, `recipe_components`, `recipe_ingredients` or `recipe_steps` | "Your kitchen has data that would be left behind. Contact support before joining." |

Then, in the same body and in this order:

1. `delete from public.household_invites where household_id = v_origin_household and redeemed_at is null` — the redeemer's own household is about to become memberless, so any live bearer code pointing at it must die with the move. Without this, a code the redeemer minted before joining stays redeemable: no validation rejects it afterwards (`KD005` counts the _invite's_ household, which now has 0 members, not ≥ 2; `KD004` only rejects your own household), so the inviter — or any third party ever sent that link — could be moved into the orphan, splitting the couple and handing them the redeemer's pre-redemption kitchen. Redemption is irreversible by any application path, so recovery would need `postgres`. This is the same statement `create_household_invite` already performs, applied to the origin side.
2. `update public.household_members set household_id = <target>, joined_at = now() where user_id = (select auth.uid())`.
3. `update public.household_invites set redeemed_at = now(), redeemed_by = (select auth.uid()), redeemed_from_household_id = v_origin_household where id = <invite id>`.

Two things the implementer must not miss. The invite row is selected `for update` **before** validation, so two concurrent redemptions cannot both see `redeemed_at is null`. And the `KD006` guard needs a comment recording its blind spot:

```sql
-- Guards additions, not deletions: a household that deleted seed rows passes this
-- check and loses those deletions. Nothing can delete seed rows today (S-05 is
-- proposed); the slice that enables it must revisit this guard.
```

Grants as in change 3. Also add a comment noting that this function never calls `private.seed_household()`, so no re-seed can occur — the guarantee asserted in change 6.

#### 5. Fixture invites and read-isolation coverage

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Fold the new table into the existing per-table read-isolation sweep and the anon sweep, so A sees only its own invite and anon sees none.

**Contract**: In the postgres setup section, insert one invite per household with fixture ids `00000000-0000-4000-b000-00000000a006` / `…b006` (continuing the `…<a|b>00<n>` scheme with its single-digit `%s` format), distinct `code` values, `created_by` = that household's test user, and a future `expires_at`. Add `'household_invites'` as element **6** of the `tables text[]` at `:246` and to the `foreach` array at `:427`. Do **not** add it at `:74` (no `seed_id`, no template) or `:279` (write-revoked; see Key Discoveries).

#### 6. Write-denial and redemption coverage

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Prove the revokes hold, prove the RPC grants, and prove a redemption does the right thing — placed **after** all existing assertions so the stashed `rls_test.a_household` / `b_household` GUCs stay valid for the blocks that read them.

**Contract**: Three new blocks plus additions to the anon block.

_Denial block_ (as user A), mirroring `:179-237`: direct `insert`, `update`, `delete` and `truncate` on `public.household_invites` each raise `insufficient_privilege`. This block is what stops a future reader from dropping the revokes.

_Redemption block_: fresh users with ids continuing the `00000000-0000-4000-a000-00000000000<x>` scheme, their household ids stashed in **new** GUCs (`rls_test.c_household`, …) — never reusing A's or B's. Assertions, in order:

1. As C: `public.create_household_invite()` returns a 16-character code; stash it in a GUC.
2. As D (pre-join): `select count(*) from public.household_invites` is **0** — the redeemer cannot see the invite they are about to redeem. This is the assertion that proves the §2 design question was answered correctly.
3. As D: `public.redeem_household_invite(<code>)` returns C's household id.
4. As postgres: D's single membership row now has `household_id` = C's household; D's old household still **exists** and has **0** members, and holds **0** `public.household_invites` rows (the origin-side delete from change 4); the invite row carries `redeemed_at`, `redeemed_by` = D, and `redeemed_from_household_id` equal to D's recorded old household **and `<>` C's household id** — the inequality is what catches a `redeemed_from_household_id` resolved after the membership update, which would otherwise stamp the live shared household and invert Phase 4's cleanup protection.
5. As postgres: C's household's `seed_id is not null` counts per data table are **unchanged** (equal to `private.seed_*` counts, not doubled) — proving no re-seed and no merge.
6. As C, then as D: each sees **2** rows in `public.household_members`, and **identical** row counts across all five data tables.

_Negative-case block_: one rejection per fresh household, because the partial unique index permits only one unredeemed invite per household — so each case needs its own. Cover `KD003` (second redemption of the same code), `KD002` (expired invite, inserted directly as postgres), `KD005` (redeeming into an already-2-member household, and `create_household_invite()` called from one), `KD004` (redeeming an invite to your own household), `KD006` (redeemer's household holds a `seed_id is null` row), and `KD001` for the **stale origin code**: a fresh pair where the redeemer mints a code for their own household _before_ redeeming someone else's, then that minted code is rejected with `KD001` once the redeemer has moved — proving the origin-side delete in change 4 landed.

The catch idiom is new to this file and must be used consistently, so that a _wrong_ rejection reason propagates and fails the test rather than being swallowed:

```sql
begin
  perform public.redeem_household_invite(current_setting('rls_test.c_code'));
  raise exception 'redeem: reused code was accepted';
exception when sqlstate 'KD003' then null;
end;
```

_Anon additions_: anon can execute neither `public.create_household_invite()` nor `public.redeem_household_invite(…)` (both `insufficient_privilege`) — note the catch-all inspects tables only, so the new functions' grants are covered by **no** existing assertion.

Finally, extend the closing `raise notice` summary (`:491`) and the success `select` to name invite isolation, RPC grants and redemption.

#### 7. Re-seed assertion placement

**File**: `supabase/tests/seed_integrity.sql`

**Intent**: None — no change. Change 6 step 5 asserts the no-re-seed property inside the isolation test, where the redemption already happens. Noted here so the implementer does not duplicate it.

**Contract**: File unchanged. `npm run test:seed` must still pass, which is the Phase 1 check that the new migration did not disturb seeding.

### Success Criteria:

#### Automated Verification:

- The migration file name matches `YYYYMMDDHHmmss_short_description.sql` and sorts after `20261007120100`
- `npx supabase db push` applies the migration to the hosted project cleanly
- `npm run test:rls` passes, including the catch-all now exercising `household_invites`
- `npm run test:seed` still passes
- Re-running `npx supabase db push` reports nothing to apply (no accidental non-idempotent repeat)
- The RPC resolves over HTTPS with the anon key and is **not** 404 — proving both that `public` is API-exposed on the hosted project and that the anon revoke holds over the real transport, neither of which any SQL assertion covers:
  ```bash
  curl -s -o /dev/null -w '%{http_code}' -X POST \
    "$SUPABASE_URL/rest/v1/rpc/create_household_invite" \
    -H "apikey: $SUPABASE_KEY" -H "Content-Type: application/json" -d '{}'
  ```
  Expect 401/403 from the `revoke execute … from anon`. A 404 means the schema is not exposed or the schema cache is stale — stop and fix that before Phase 2.

#### Manual Verification:

- Read back the deployed grants and confirm `authenticated` holds `select` only on `public.household_invites`, and that `anon` can execute neither new function
- Confirm both new functions report `security definer` with an empty `search_path` in `pg_proc`
- Confirm the test's redemption block appears **after** every block that reads `rls_test.a_household` / `rls_test.b_household`

**Implementation Note**: Pause here for manual confirmation before Phase 2. The `## Progress` section at the bottom owns the checkbox state for these items.

---

## Phase 2: App layer — service, API routes, cookie and pages

### Overview

Everything a user touches. Ends with a join performed by hand in a browser against the hosted project.

### Changes Required:

#### 1. Install zod

**File**: `package.json`

**Intent**: Add `zod` as a dependency — CLAUDE.md mandates it for API-route input validation and it is currently absent.

**Contract**: `npm install zod`; `zod` appears under `dependencies`. The three existing auth routes are not retrofitted.

#### 2. Shared types

**File**: `src/types.ts`

**Intent**: Add the invite entity in the established camelCase shape, alongside `Household` / `HouseholdMember`.

**Contract**: `export interface HouseholdInvite { id: string; code: string; createdAt: string; expiresAt: string }`. The redeemed/provenance fields are not surfaced to the UI in this slice and are omitted.

#### 3. Invite service

**File**: `src/lib/services/invites.ts` (new)

**Intent**: The single home for every invite query and RPC call, and for mapping the `KD0xx` SQLSTATEs to user-facing messages — both API routes need the mapping, so per CLAUDE.md it belongs in a service, not in a route.

**Contract**: Follow `src/lib/services/household.ts` conventions exactly: client as the first positional param typed bare `SupabaseClient`, errors **thrown** not returned, snake→camel mapped by hand with explicit casts, return types from `@/types`, and a comment noting RLS does the scoping.

- `getActiveInvite(supabase): Promise<HouseholdInvite | null>` — selects the caller's household's unredeemed, unexpired invite (`.maybeSingle()`).
- `createInvite(supabase): Promise<string>` — calls `create_household_invite`, returns the code.
- `redeemInvite(supabase, code: string): Promise<string>` — calls `redeem_household_invite`, returns the target household id.
- `inviteErrorMessage(error: unknown): string` — maps each SQLSTATE from the Phase 1 table to its message, with a neutral fallback for anything else.

Two non-obvious constraints. `strictTypeChecked` means an untyped `rpc()` result trips `no-unsafe-assignment`/`no-unsafe-member-access`, so cast at the boundary exactly as `household.ts:19-24` does. And the SQLSTATE arrives on the PostgREST error as its `code` field, not in `message` — match on `code`, and treat the error as `unknown` narrowed by a type guard rather than casting to `PostgrestError`.

#### 4. Invite cookie helper

**File**: `src/lib/invite-cookie.ts` (new)

**Intent**: One place that owns the cookie carrying an invite code across the sign-up → confirm-email → sign-in detour, so `/join`, the redeem route and the signin route cannot disagree about its name or options. A generic helper used by more than one route, so per CLAUDE.md it belongs in `src/lib/`, not in `src/lib/services/`.

**Contract**: Exports the cookie name `dk_invite` and `set` / `read` / `clear` helpers over `AstroCookies`. Options: `httpOnly: true`, `secure: true`, `sameSite: "lax"`, `path: "/"`, `maxAge` = 7 days (matching the invite TTL from Decision 5). `sameSite: "lax"` is required, not incidental: the invite link is followed from an email client, i.e. a cross-site top-level GET.

#### 5. Invite creation route

**File**: `src/pages/api/household/invite.ts` (new)

**Intent**: Let the inviter mint a code from the dashboard.

**Contract**: `export const POST: APIRoute = async (context) => {…}` following the `src/pages/api/auth/signup.ts` template — single `context` arg, no `prerender` export, `context.redirect()` for every response. No body to validate. Must check `context.locals.user` itself: `/api/*` is **not** in `middleware.ts`'s `PROTECTED_ROUTES`, so this route is reachable anonymously. Null-check `createClient(...)` as every caller does. On success redirect to `/dashboard`; on failure redirect to `/dashboard?error=<encoded inviteErrorMessage>`.

#### 6. Redemption route

**File**: `src/pages/api/household/redeem.ts` (new)

**Intent**: Perform the join and clear the carried cookie.

**Contract**: Same route shape as change 5. Reads `code` from `request.formData()` and validates it with the first zod schema in the codebase — `z.object({ code: z.string().trim().toLowerCase().regex(/^[0-9a-f]{16}$/) })` — which sets the convention: parse with `safeParse`, and on failure redirect with the same `?error=` treatment rather than returning a 400 (no JSON-response convention exists, and introducing one is out of scope). Requires `context.locals.user`, redirecting to `/auth/signin` if absent. On success: clear the `dk_invite` cookie and redirect to `/dashboard?joined=1`. On failure: redirect to `/join?error=<encoded inviteErrorMessage>` — the cookie still holds the code, so `/join` can re-render.

#### 7. Signin redirect honours a pending invite

**File**: `src/pages/api/auth/signin.ts`

**Intent**: Send a user who arrived via an invite link back to `/join` after they authenticate, instead of to `/`. This is what makes the code survive the email round-trip.

**Contract**: One change, at the success return only: redirect to `/join` when `dk_invite` is present, else `/` as today. The error paths and the `?error=` convention are untouched. Note the smoke test asserts `location: "/"` for a sign-in with no pending invite — that assertion must continue to hold.

#### 8. The redemption page

**File**: `src/pages/join.astro` (new)

**Intent**: The one page an unauthenticated user may reach besides sign-in and sign-up (PRD §Access Control). It captures the code, survives the auth detour, and makes redemption an explicit act.

**Contract**: Not added to `PROTECTED_ROUTES`. Reads the code from `?code=` or, failing that, from the `dk_invite` cookie (query wins). Sets the cookie when the code came from the query. Renders, in the `dashboard.astro` layout idiom with `Layout` and a `data-testid="join"` status line:

- no code → "This invite link is incomplete."
- code, no `Astro.locals.user` → "You've been invited to share a household." plus links to `/auth/signin` and `/auth/signup`. Shows **no** inviter identity (Decision 6) and renders **no** form.
- code and a signed-in user → a native `<form method="POST" action="/api/household/redeem">` with a hidden `code` input and a confirm button. **Never** a one-click GET: redemption is irreversible in this slice (see "What We're NOT Doing"), so it must take a deliberate POST.

Renders `Astro.url.searchParams.get("error")` the way the auth pages do.

#### 9. Dashboard invite section

**File**: `src/pages/dashboard.astro`

**Intent**: Give the inviter somewhere to generate, see and share the code, and show the linked state once a partner has joined.

**Contract**: Add a `getActiveInvite` call inside the existing `if (supabase)` block, wrapped in `try/catch` with a neutral fallback string and a `console.error` under the established `// eslint-disable-next-line no-console -- …` comment, exactly like the two calls already there. Add one `<p data-testid="invite">` plus, when appropriate, a native `<form method="POST" action="/api/household/invite">`:

- `memberCount >= 2` → "Linked with your partner." No form.
- active invite → the 16-char code and the absolute `/join?code=…` link as selectable text, plus a "Generate new code" submit (which replaces the previous code — Decision 4). No clipboard island.
- otherwise → a "Generate invite code" submit.

Also render `?error=` and `?joined=1` from `Astro.url.searchParams` into the existing message area. Build the link from `Astro.url.origin` so it works in dev, preview and production without configuration.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (watch `strictTypeChecked` on the `rpc()` results and the error guard in the service)
- `npx astro check` passes
- `npm run build` succeeds
- `npm run test:rls` still passes (no app change should affect it, so a failure here means a stray migration edit)

#### Manual Verification:

- Signed in as a fresh account, `/dashboard` offers "Generate invite code"; submitting shows a 16-hex code and a `/join?code=…` link
- "Generate new code" yields a different code and the old code is rejected on redemption
- In a second browser profile, opening the link while signed out shows the invite message with sign-in/sign-up links and **no** confirm form
- In the default (confirmation-**off**) configuration: signing up in that profile → `/auth/confirm-email`, then signing in lands on `/join` — not `/` — and the confirm form appears with the right code. This is the version to run normally; it verifies the redirect without touching project settings.
- The full email round-trip (sign up → click the link in the inbox → sign in → `/join`) requires **Authentication → Email → Confirm email temporarily enabled** on the hosted project `tvmfkhnxxsnmvogplknz`. There is exactly one hosted project, shared by local work, `npm run smoke` and both CI jobs, and README states smoke "needs the hosted Supabase project with email confirmation disabled" — so **turn the toggle back off immediately after this check**, before Phase 3 or any `npm run smoke` run. Leaving it on breaks every smoke run and both CI jobs until someone notices.
- Confirming moves the account: both dashboards show the same 8-char household prefix, `2 members` and the same library counts, and the invite section reads "Linked with your partner"
- A tampered code (wrong length, non-hex) and an unknown 16-hex code each produce a readable message on `/join`, not a stack trace
- `/api/household/invite` and `/api/household/redeem` called without a session redirect rather than erroring

**Implementation Note**: Pause here for manual confirmation before Phase 3.

---

## Phase 3: Smoke test — two accounts, end to end

### Overview

`scripts/smoke.mjs` is the only place "both partners see the same household" is assertable, because isolation-test users have no password and can never sign in. The file needs a real refactor first: one module-level cookie jar, no way to carry a value between steps, and eagerly-built assertions.

### Changes Required:

#### 1. Structural refactor

**File**: `scripts/smoke.mjs`

**Intent**: Make the script able to drive two independent sessions and to assert on values discovered mid-run, without changing how the existing eight steps read.

**Contract**: Four changes, each addressing a specific blocker:

- Replace the module-level `const jar = new Map()` (`:7`) and the `request()` that closes over it with a `makeClient()` factory returning `{ request }` over its own jar. Create two: one for A, one for B. Keep `cookieHeader` / `storeCookies` semantics identical, including the `max-age=0` deletion handling.
- Add a second email alongside `smoke-${Date.now()}@example.com`. It must still match the README's `smoke-%@example.com` cleanup glob — e.g. `smoke-b-${Date.now()}`.
- Generalise `libraryLine(body)` (`:42-45`) to `testIdText(body, id)`, since the invite code and the household line now need extracting too. Keep the failure printout working.
- Allow the step tuple's third element (the expected object) to optionally be a **thunk**, resolved inside the loop — `const expected = typeof raw === "function" ? raw() : raw;`. This is what unblocks assertions on values captured earlier (`expected.body` is a RegExp built eagerly, so it cannot embed A's household prefix) while reusing the existing `status` / `location` / `body` channels. Do **not** add a fourth `check: (actual) => boolean` channel: the failure printout at `smoke.mjs:84-87` prints extracted text only when `expected.body !== undefined`, so `check`-only steps — which would be steps 9 and 10, the FR-003 cross-account equality assertions and the whole point of the phase — would print status and location alone, making the suite's two most informative failures its least diagnosable, directly against manual 3.5. With thunks, steps 9 and 10 express their assertions as `body` RegExps built from A's captured text and the existing `testIdText` printout fires automatically.

The eager-evaluation trap is the thing to get right, and it bites twice:

```js
// The `steps` array literal is evaluated at module load, so anything that depends
// on a value captured by an earlier step must be read INSIDE the step's closure —
// both the request body and the assertion.
let inviteCode = "";
// ...
["B redeems the invite", () => b.request("/api/household/redeem",
  { method: "POST", form: { code: inviteCode } }),   // read at call time, not at literal time
  { status: 302, location: "/dashboard?joined=1" }],
```

**ESLint**: `eslint.config.js:73-78` allows exactly `console`, `process`, `fetch`, `URLSearchParams` as globals for `scripts/**/*.mjs`. `Date`, `Map`, `RegExp` and `JSON` are language built-ins and fine; `crypto`, `URL`, `setTimeout`, `AbortController` and `TextDecoder` are **not** and will fail `npm run lint`. Either stay inside the allowlist or extend it deliberately in the same commit.

#### 2. The new steps

**File**: `scripts/smoke.mjs`

**Intent**: Prove FR-002 and FR-003 over HTTP.

**Contract**: Splice after the existing "dashboard renders for signed-in user with seeded library" step and before "signout clears session" (so A is still signed in). Order:

1. A's dashboard → capture A's household line and library line from `data-testid="household"` / `"library"`
2. A POST `/api/household/invite` → 302 `/dashboard`
3. A GET `/dashboard` → capture the 16-hex code from `data-testid="invite"`
4. B GET `/join?code=<captured>` → 200, invite message, **no** confirm form, and `Set-Cookie: dk_invite` present
5. B sign-up → 302 `/auth/confirm-email`
6. B sign-in → **302 `/join`** — the change 7 cookie branch, the slice's one novel auth mechanism
7. B GET `/join` with **no** query string → 200, confirm form rendered from the cookie alone (this is also the only coverage of the cookie fallback read)
8. B POST `/api/household/redeem` → 302 `/dashboard?joined=1`, and `dk_invite` cleared
9. B GET `/dashboard` → household line **equals** A's captured line with `2 members`, library line equals A's captured library line
10. A GET `/dashboard` → `2 members`, library line **unchanged** from step 1

The ordering is deliberate: B visits `/join` _before_ signing in, so the cookie exists when step 6 runs and the new redirect branch is actually exercised. The no-cookie `302 /` guard is preserved for free by A's pre-existing "signin accepts correct password → /" step — A never visits `/join`, so A's jar never holds `dk_invite`. (The cost: B's sign-in is no longer a second copy of that guard, so a regression redirecting _everyone_ to `/join` is caught by A's step alone.)

Steps 9 and 10 together are the FR-003 proof; step 10's unchanged library count is also the no-re-seed, no-duplicate-seed-set proof over HTTP.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (the globals allowlist is the likely failure)
- `npm run build` then `npm run preview`, and `BASE_URL=http://localhost:4321 npm run smoke` reports all steps passed
- The eight pre-existing steps still pass unchanged, including `signin accepts correct password → /`
- A second consecutive `npm run smoke` run passes (fresh timestamped emails, no cross-run state)

#### Manual Verification:

- A failing step prints something diagnosable — deliberately break one assertion and confirm the output names the step and shows the extracted text
- Confirm the run left exactly two new accounts and one extra memberless household on the hosted project, matching what the Phase 4 README text will claim

**Implementation Note**: Pause here for manual confirmation before Phase 4.

---

## Phase 4: Documentation and conventions

### Overview

Three documents now describe the system incorrectly, and one of them documents a maintenance command that would delete a partner's data.

### Changes Required:

#### 1. Project rules

**File**: `CLAUDE.md`

**Intent**: Record the two conventions this slice establishes, so the next slice follows them rather than re-deriving them.

**Contract**: Under the hard rules / architecture sections, add: (a) the `public` definer-RPC convention — client-callable functions live in `public` because `private` is not API-exposed, and require `security definer` + `set search_path = ''` + fully qualified names + `revoke execute … from public, anon` + `grant execute … to authenticated`; (b) that `household_invites` is write-revoked like `household_members`, carrying conforming policies to satisfy the isolation catch-all while grants keep writes to the RPCs; (c) the invite and redemption routes under §Auth flow; (d) the S-02 keying expectation from Decision 11 (macro targets keyed on `user_id`, travelling with the person through redemption).

#### 2. README

**File**: `README.md`

**Intent**: Document the new route and fix the cleanup query before it destroys data.

**Contract**: Add `/join` to the auth-routes table, noting it is intentionally unprotected. Then fix the CI section, which is now wrong in two ways: each run signs up **two** accounts, and leaves **two** households (the shared one plus the redeemer's orphan), so the stated growth rate roughly doubles. Most importantly, the documented cleanup query —

```sql
delete from public.households h
where not exists (select 1 from public.household_members m where m.household_id = h.id)
```

— now deletes exactly the pre-redemption households that Decision 1 deliberately preserves. Replace it with a version that spares households still referenced as a redemption origin, and note that it must be run until it deletes 0 rows (deleting a shared household cascades its invite rows, which only then releases the orphan it pointed at):

```sql
delete from public.households h
where not exists (select 1 from public.household_members m where m.household_id = h.id)
  and not exists (select 1 from public.household_invites i where i.redeemed_from_household_id = h.id);
```

Add a short warning naming S-01 as the reason, closing the blind spot F-02's impl-review flagged (`reviews/impl-review.md` F3).

#### 3. Tooling allowlist

**File**: `.claude/settings.json`

**Intent**: Stop prompting for the `test:seed` command this slice runs repeatedly. This closes F-02's open follow-up F2 — inherited work, included because Phase 1 and Phase 2 both run `npm run test:seed`.

**Contract**: Add the two `test:seed` entries alongside the existing `test:rls` pair, matching their exact form (`Bash(npm run test:seed)` and the expanded `npx supabase db query --linked -f supabase/tests/seed_integrity.sql`).

#### 4. Change identity

**File**: `context/changes/link-partner-household/change.md`

**Intent**: Resolve the open unknown recorded in the frontmatter notes.

**Contract**: Record that the roadmap's merge-vs-discard unknown was **deferred, not answered**, per Decision 1, and that the non-seed guard makes the deferral forward-safe. Leave the unknown's owner as the user.

### Success Criteria:

#### Automated Verification:

- `npm run lint` passes (pre-commit runs `prettier --write` on `*.{json,md}`, so formatting must be clean)
- `npm run format` leaves no diff
- The amended README cleanup query runs without error against the hosted project

#### Manual Verification:

- Run the amended cleanup query twice against the hosted project and confirm it removes the smoke-run households while leaving no orphan whose provenance is still referenced
- A reader of CLAUDE.md alone can tell why `household_invites` has policies that no grant can reach
- The README's CI accounting matches what a real smoke run actually leaves behind (verified in Phase 3)

---

## Testing Strategy

### SQL (`supabase/tests/household_isolation.sql`, rolled back)

Membership mechanics are provable only here — isolation-test users are inserted into `auth.users` with four columns and no password, so they exist to fire the trigger and can never sign in. Coverage: the four conforming policies and the catch-all; read isolation on fixture invites; direct-write denial proving the revokes; RPC grants (anon denied, `authenticated` allowed); a full redemption with before/after membership, provenance and unchanged seed counts; and six distinct rejection paths asserted by SQLSTATE (including the stale origin code) so a wrong rejection reason fails the test.

### HTTP (`scripts/smoke.mjs`)

"Both partners see the same thing" is provable only here — smoke accounts' uuids are never known to SQL. Two cookie jars, two accounts, ten new steps ending in the cross-account equality assertions.

There is **no bridge** between the two halves, by construction. Both are needed; neither substitutes for the other.

### Manual testing steps

1. Sign up a fresh account; on `/dashboard`, generate an invite code. Confirm a 16-hex code and a `/join?code=…` link appear.
2. Click "Generate new code". Confirm the code changes.
3. Copy the **old** link into a second browser profile and attempt redemption. Confirm a readable "not valid" message.
4. Copy the current link into the second profile while signed out. Confirm the invite message, the sign-in/sign-up links, no inviter identity and no confirm form.
5. Sign up in that profile, then sign in. Confirm you land on `/join` with the confirm form, not on `/`. To exercise the real inbox round-trip, first enable **Authentication → Email → Confirm email** on the hosted project, click the link from the inbox between sign-up and sign-in — and **turn the toggle back off** before Phase 3 or any `npm run smoke` run, which require it off.
6. Confirm the join. Check both dashboards: same 8-char household prefix, `2 members`, identical library counts, "Linked with your partner".
7. In the first profile, confirm no invite form is offered any more (the 2-member cap).
8. Re-POST the same code (browser back, or re-submit). Confirm "already been used".
9. Edit the URL to `/join?code=zzzz`. Confirm the zod rejection produces a readable message, not a 500.
10. As `postgres`, confirm the second profile's original household still exists with 0 members and its ~170 seed rows intact, and that the invite row's `redeemed_from_household_id` points at it.

## Performance Considerations

Nothing meaningful. Both RPCs touch single rows by unique key; the `KD006` guard is five `exists` probes against indexed `household_id` columns; `getActiveInvite` is one indexed lookup per dashboard render. The one-live-invite index keeps the table at most one unredeemed row per household. No caching, no new N+1, no rate limiting (Decision: none warranted for a two-person app).

## Migration Notes

- **Push before merge.** `npx supabase db push` then `npm run test:rls` before merging the PR — CI tests the deployed schema, not the branch's migrations (CLAUDE.md hard rule; F-02's impl-review Fix A is the precedent).
- **No backfill.** The table starts empty; existing households are unaffected. No data-only migration is needed — unlike a seed-content change, this adds no templates.
- **Rollback** is `drop function public.redeem_household_invite(text)`, `drop function public.create_household_invite()`, `drop table public.household_invites` — safe while no invite has been redeemed. **After** any redemption, dropping the table discards the `redeemed_from_household_id` provenance, which is the only record linking a memberless household to the partner who left it. Note this in the migration header.
- **One-way for users.** A redemption cannot be undone by any application code path (no update/delete surface on `household_members`). Recovery requires `postgres`.
- **Orphan growth.** Each CI smoke run now leaves two memberless households instead of one. The Phase 4 README amendment is what keeps the documented cleanup from eating real data.

## References

- Grounding research: `context/changes/link-partner-household/research.md`
- Change identity: `context/changes/link-partner-household/change.md`
- Reserved join point: `supabase/migrations/20261006120000_household_data_scope.sql:56-62`
- Definer pattern to copy: `supabase/migrations/20261006120000_household_data_scope.sql:41-54`
- Policy + revoke pairing precedent: `supabase/migrations/20261006120000_household_data_scope.sql:66-69`
- Four-policy template: `supabase/migrations/20261007120000_products_and_recipes.sql:167-179`
- Composite FKs that forbid a merge: `supabase/migrations/20261007120000_products_and_recipes.sql:82,107-108,126-129`
- Isolation catch-all: `supabase/tests/household_isolation.sql:439-484`
- Write-denial block to mirror: `supabase/tests/household_isolation.sql:179-237`
- GUC staleness trap: `supabase/tests/household_isolation.sql:36-53`
- Service conventions: `src/lib/services/household.ts:5-26`
- API-route template: `src/pages/api/auth/signup.ts:1-20`
- Page → service pattern and `data-testid` hooks: `src/pages/dashboard.astro:13-35,47-49`
- Smoke script structure: `scripts/smoke.mjs:7,23-45,47-89`
- Scripts globals allowlist: `eslint.config.js:73-78`
- Prior art on the orphan-cleanup blind spot: `context/archive/2026-10-07-seed-products-and-recipes/reviews/impl-review.md:69`
- Prior art on the composite-FK trap: `context/archive/2026-10-07-seed-products-and-recipes/reviews/plan-review.md:146-148`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `.claude/skills/10x-plan/references/progress-format.md`.

### Phase 0: Prerequisites

#### Automated

- [x] 0.1 `npm ci` completes and `node_modules` exists — edc1cd8
- [x] 0.2 `npm run lint` passes on the unmodified checkout — edc1cd8
- [x] 0.3 `npx astro check` passes on the unmodified checkout — edc1cd8
- [ ] 0.4 `npm run test:rls` passes against the hosted project
- [ ] 0.5 `npm run test:seed` passes against the hosted project

### Phase 1: Invite schema, redemption RPCs and isolation coverage

#### Automated

- [x] 1.1 Migration file name matches `YYYYMMDDHHmmss_short_description.sql` and sorts after `20261007120100` — 2bc3c2c
- [ ] 1.2 `npx supabase db push` applies the migration to the hosted project cleanly
- [ ] 1.3 `npm run test:rls` passes, including the catch-all now exercising `household_invites`
- [ ] 1.4 `npm run test:seed` still passes
- [ ] 1.5 Re-running `npx supabase db push` reports nothing to apply
- [ ] 1.6 `POST $SUPABASE_URL/rest/v1/rpc/create_household_invite` with the anon key returns 401/403, not 404

#### Manual

- [ ] 1.7 Deployed grants: `authenticated` holds `select` only on `household_invites`; `anon` can execute neither new function
- [ ] 1.8 Both new functions report `security definer` with an empty `search_path` in `pg_proc`
- [x] 1.9 Redemption block sits after every block reading the `rls_test.a_household` / `b_household` GUCs — 2bc3c2c

### Phase 2: App layer — service, API routes, cookie and pages

#### Automated

- [x] 2.1 `npm run lint` passes (`strictTypeChecked` on `rpc()` results and the error guard) — 348a3c2
- [x] 2.2 `npx astro check` passes — 348a3c2
- [x] 2.3 `npm run build` succeeds — 348a3c2
- [ ] 2.4 `npm run test:rls` still passes

#### Manual

- [ ] 2.5 Fresh account can generate an invite; dashboard shows a 16-hex code and a `/join?code=…` link
- [ ] 2.6 "Generate new code" yields a different code and the old code is rejected
- [x] 2.7 Signed-out `/join` shows the invite message with auth links and no confirm form — 348a3c2
- [ ] 2.8 Default config (confirmation off): sign-up → `/auth/confirm-email` → sign-in lands on `/join` with the right code
- [ ] 2.9 Full inbox round-trip with **Confirm email** temporarily enabled on the hosted project, **and the toggle turned back off** before Phase 3 / any `npm run smoke` run
- [ ] 2.10 Confirming the join gives both dashboards the same household prefix, `2 members` and identical library counts
- [ ] 2.11 Tampered and unknown codes produce readable messages, not stack traces
- [x] 2.12 Both new API routes redirect rather than erroring when called without a session — 348a3c2

### Phase 3: Smoke test — two accounts, end to end

#### Automated

- [x] 3.1 `npm run lint` passes (scripts globals allowlist) — a91bdfd
- [ ] 3.2 `BASE_URL=http://localhost:4321 npm run smoke` reports all steps passed against the production preview
- [ ] 3.3 The eight pre-existing steps still pass unchanged, including `signin accepts correct password → /`
- [ ] 3.4 A second consecutive `npm run smoke` run passes

#### Manual

- [x] 3.5 A deliberately broken assertion prints a diagnosable failure naming the step and the extracted text — a91bdfd
- [ ] 3.6 A run leaves exactly two new accounts and one extra memberless household on the hosted project

### Phase 4: Documentation and conventions

#### Automated

- [x] 4.1 `npm run lint` passes — 25c2cbd
- [ ] 4.2 `npm run format` leaves no diff
- [ ] 4.3 The amended README cleanup query runs without error against the hosted project

#### Manual

- [ ] 4.4 Amended cleanup query run twice removes smoke households and spares referenced origins
- [x] 4.5 CLAUDE.md alone explains why `household_invites` has policies no grant can reach — 25c2cbd
- [ ] 4.6 README's CI accounting matches what a real smoke run leaves behind

### Progress notes

**Environment constraint for this implementation run.** The run happened in a cloud container with
**no Supabase credentials** — no `SUPABASE_URL`, `SUPABASE_KEY` or `SUPABASE_ACCESS_TOKEN`, no `.env`
and no `.dev.vars`, and the CLI is not linked to `tvmfkhnxxsnmvogplknz`. CLAUDE.md forbids a local
Supabase stack, so there was no substitute. Every row that needs the hosted project, a running server
or a browser is therefore **pending hosted verification** and was deliberately left `- [ ]` rather
than claimed:

| Pending row(s)       | Blocked on                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| 0.4, 0.5             | `npm run test:rls` / `npm run test:seed` need `--linked`                                                    |
| 1.2, 1.3, 1.4, 1.5   | `npx supabase db push` and the two SQL suites                                                               |
| 1.6                  | the `curl` RPC-reachability probe needs `$SUPABASE_URL` / `$SUPABASE_KEY`                                   |
| 1.7, 1.8             | these read deployed catalogs — both were verified on the local validation cluster (below)                   |
| 2.5, 2.6, 2.8 – 2.11 | a browser against a server backed by the hosted project (2.7 and 2.12 were settled without one — see below) |
| 3.2, 3.3, 3.4, 3.6   | `npm run smoke` needs the hosted project (3.1 and 3.5 were settled here)                                    |
| 4.3, 4.4, 4.6        | the cleanup query and the smoke-run accounting need the hosted project                                      |

**The SQL was nonetheless validated, and the validation found two real defects.** A throwaway
PostgreSQL 16.15 cluster was started from the distro binaries with a hand-written Supabase-shaped
harness (`anon` / `authenticated` / `service_role` roles, an `auth` schema with `users` and `uid()`,
and Supabase's `alter default privileges … grant all … to anon, authenticated` — the thing that makes
the migrations' `revoke` statements load-bearing). This is **not** a local Supabase stack: no Docker,
no `supabase` CLI, no local project, no link. It exists only to run SQL that otherwise could not be
run at all, and it never touched the hosted project. All four migrations apply cleanly and both
`household_isolation.sql` and `seed_integrity.sql` pass end to end on it.

Ten mutations were then applied to the new migration to prove the new assertions are not vacuous —
each mutation must make `household_isolation.sql` fail. Two findings came out of this:

1. **The "no re-seed" assertion the plan specifies is vacuous.** Phase 1 change 6 step 5 asserts the
   target household's `seed_id is not null` counts still equal the `private.seed_*` counts. But
   `private.seed_household()` is `on conflict (household_id, seed_id) do nothing`, so re-seeding an
   already-seeded household inserts nothing and every count still matches. Injecting
   `perform private.seed_household(v_invite.household_id)` into the RPC left the suite **green**.
   The count assertion was kept (it does prove "no merge, no duplicate seed set") and a direct
   assertion on `pg_proc.prosrc` was added: `redeem_household_invite`'s body must not reference
   `seed_household`. That is the only non-vacuous form of the stated guarantee, and it is what makes
   the property hold once S-05 lets households delete seed rows.
2. **Three assertions were caught only by accident, with misleading messages.** The invite-insert
   denial collided with `household_invites_one_unredeemed_idx` before the privilege check could fire
   (masking the three assertions after it in the same block — fixed by inserting a redeemed row); the
   anon RPC-grant checks reported "no household for caller" instead of naming the missing revoke
   (fixed with explicit `KD007` branches); and because the validations are ordered, removing one
   check surfaced the _next_ one's message (dropping the `KD005` cap reported the `KD006` guard —
   fixed with a `when others` branch that names the code that fired and the one expected).

After the fixes all ten mutations are caught, each with a message that names the actual defect.

**Part of Phase 2 was verified over HTTP without credentials.** With no `SUPABASE_URL` /
`SUPABASE_KEY`, `createClient()` returns null and `locals.user` is always null — but that is exactly
the state the anonymous paths run in, so `npm run build && npm run preview` plus `curl` settles three
things that needed no database:

- **2.7** — `/join?code=…` signed out returns 200 with the invite message and the sign-in/sign-up
  links and **no** confirm form; `/join` with no code renders "This invite link is incomplete."; and
  `/join` with no query but a `dk_invite` cookie renders the invited state, proving the cookie
  fallback read.
- **2.12** — `POST /api/household/invite` and `POST /api/household/redeem` with no session both
  `302 → /auth/signin` rather than erroring. (Both need an `Origin` header, or Astro's CSRF check
  answers 403 first — which is also why `scripts/smoke.mjs` sends one.)
- **Plan-review F3's recorded blind spot**, which it could not check: _"Not verified whether `/join`
  sets `dk_invite` on a GET from an unauthenticated visitor in Astro's SSR response path for a 200."_
  It does — `set-cookie: dk_invite=…; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`, on a
  200, to an anonymous visitor. The whole email-round-trip mechanism hangs off this.

The redeem route's zod schema was also exercised directly against the installed zod 4.6.5, because
the order of `.trim()` / `.toLowerCase()` relative to `.regex()` is load-bearing and silently
version-dependent: whitespace-padded and UPPERCASE codes are normalised and **accepted**, while
15/17-character, non-hex, empty and missing codes are rejected. The transforms do run before the
regex check.

**Phase 3's refactor was exercised against the preview, and that found two more defects.** The script
cannot _pass_ without the hosted project, but running it proves the machinery: two independent jars,
thunks resolving at call time rather than at module load, and the failure printout. Both defects are
in assertions the plan relies on:

1. **`location: "/"` was a vacuous assertion, and the plan leans on it.** The harness compares
   `location` with `startsWith`, so `"/"` is a prefix of _every_ redirect — including `/join`.
   Plan-review F3's accepted fix says the no-pending-invite guard "is preserved for free by A's
   pre-existing `signin accepts correct password → /` step", but that step would have accepted a
   regression redirecting **everyone** to `/join`, which is precisely the regression F3 set out to
   guard. The same masking applied to `"/dashboard"`, which the `"/dashboard?error=…"` failure
   redirect is a prefix of — so a broken `create_household_invite` would have passed too. `location`
   now also accepts a RegExp for an exact assertion (mirroring how `body` already works, so no new
   assertion channel), and the five steps where a prefix could mask a failure use one. Re-running
   confirmed the two formerly-vacuous steps now fail, while `signout → /` still passes.
2. **`storeCookies` could not see Astro's cookie deletions.** The plan says to keep `storeCookies`
   semantics identical "including the `max-age=0` deletion handling". But that only covers how
   Supabase's SSR client expires cookies. Astro's own `cookies.delete()` — which
   `/api/household/redeem` uses to clear `dk_invite` — sends `expires` in the past and _deliberately
   unsets_ `max-age` (`astro/dist/core/cookies/cookies.js`). The jar would therefore have stored
   `dk_invite=deleted` instead of dropping it, so the plan's own "cookie cleared" assertion could not
   have passed, and B's jar would have kept sending a bogus code on every later request. The jar now
   honours a past `expires` as well.

Two smaller deviations, both deliberate: the cookie-set/cookie-cleared checks are asserted through
behaviour rather than through `Set-Cookie` headers (the confirm form rendering from the cookie alone,
and `/join` afterwards saying the link is incomplete), which keeps the script inside the plan's three
assertion channels and avoids the `check` channel plan-review F7 ruled out; and four steps beyond the
plan's ten were added because they were nearly free and automate manual steps 7, 8 and 9 — the
two-member cap hiding the invite form, the reused code, and the non-hex code rejected by zod rather
than by the database.

**Two Phase 4 items could not be completed as written.**

1. **Change 3 (`.claude/settings.json`) was not applied — the write was denied.** This session was not
   granted permission to write that file, and a denied call is not retried. The change is inherited
   F-02 follow-up F2, not S-01 work, so nothing in this slice depends on it. To apply it, add these
   two entries alongside the existing `test:rls` pair:

   ```json
   "Bash(npm run test:seed)",
   "Bash(npx supabase db query --linked -f supabase/tests/seed_integrity.sql)"
   ```

2. **Row 4.2 (`npm run format` leaves no diff`) is not achievable and was already failing before this
change.** The repo has never been fully Prettier-formatted: `npx prettier --check .` flags 72
files, **67 of which this change never touches** (`docs/`, `context/foundation/`, and the change
folder's own `research.md`/`plan-brief.md`/`reviews/`). The pre-change commit fails the same
check, so this is a pre-existing condition, not a regression. Running `npm run format`to satisfy
the row literally would produce a 67-file reformat diff unrelated to S-01, which is not this
slice's call to make. Instead every file this change touches is Prettier-clean — which is also
exactly what the`lint-staged`pre-commit hook enforces, since it runs`prettier --write`on staged`*.{json,css,md}` only. A repo-wide reformat is worth its own change.

**One gap found that was left unfixed, deliberately — it needs a product decision.**
`redeem_household_invite` caps the **target** household at two members but has no symmetric cap on
the caller's own household, and S-01 ships no leave/unlink path. So an **already-linked** user who
follows a third party's invite link is moved out of the couple, leaving their partner alone in the
shared household; only `KD006` can stop it, and only if the couple had added non-seed rows.
`/join` renders the confirm form for such a user. Closing it is a one-line origin-side check, but it
needs an eighth SQLSTATE and a user-facing message, so it is scope the approved plan bounded out
rather than something to add silently. The reasoning is recorded as a comment at the `KD005` check in
the migration so it cannot be lost.

**Pre-merge order still applies.** CI runs `test:rls` against the _deployed_ schema, so
`npx supabase db push` must run before this branch merges, or `test:rls` fails on a missing
`public.household_invites`. See the plan's "Critical Implementation Details" and "Migration Notes".

**Decisions taken autonomously in this non-interactive run** (the skill would normally have asked):

1. **Hosted rows left unchecked, not claimed.** Per the invoking instruction, rows needing the hosted
   project stay `- [ ]` with the table above as the record.
2. **Phase gates not paused.** The four manual-confirmation gates were skipped and every phase ran
   consecutively, as instructed. Phase manual rows that _could_ be settled from the source alone were
   settled (1.9, 4.5); the rest stay pending.
3. **Dirty-path prompt → "stage only the planned set."** The touched-file set drove every `git add`;
   nothing outside it was staged. The only out-of-set path encountered was `.astro/` (generated by
   `npx astro sync`, already gitignored).
4. **Phase 0 env files not created.** Writing `.env` / `.dev.vars` with placeholder credentials would
   fake a prerequisite rather than meet it, so neither file was created. `npm ci` plus `npx astro sync`
   were enough to make `lint` / `astro check` / `build` green, and `astro sync` turned out to be a
   genuine prerequisite the plan omits: without the generated `.astro/types.d.ts`, `npm run lint`
   fails with 20 `no-unsafe-*` errors on untouched files.
5. **Final "stragglers" prompt → "Pause."** All four phases are code-complete and committed, but
   **`change.md` stays `status: implementing`** and was deliberately _not_ flipped to `implemented`.
   24 Progress rows are still pending, and they are not cosmetic: the migration has never been
   applied to the hosted project, so `npm run test:rls` has never run against the deployed schema —
   which is the one thing CLAUDE.md's hard rule requires before this branch merges. Marking the
   change `implemented` would invite `/10x-archive` to close out work whose central gate has not run.
   The next person should, in this order: `npx supabase db push`, `npm run test:rls`,
   `npm run test:seed`, the Phase 1 `curl` probe, then `npm run smoke` against a preview, then settle
   the remaining manual rows and flip the status.
