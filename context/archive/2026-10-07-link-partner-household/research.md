---
date: 2026-10-07T14:52:30+00:00
researcher: Claude (Opus 5) for Kamil Schlagowski
git_commit: 519d31c5177600a2e0be22f22c71bb01f8750840
branch: claude/inspiring-einstein-eqi4f3
repository: KSchlagowski/Duo-Kitchen
topic: "Ground S-01 link-partner-household: invite code/link + redemption that moves a partner into one shared household"
tags: [research, codebase, supabase, rls, migrations, households, invites, security-definer, rpc, smoke-test]
status: complete
last_updated: 2026-10-07
last_updated_by: Claude (Opus 5)
---

# Research: Link partner into one shared household (roadmap S-01)

**Date**: 2026-10-07T14:52:30+00:00
**Researcher**: Claude (Opus 5) for Kamil Schlagowski
**Git Commit**: `519d31c5177600a2e0be22f22c71bb01f8750840`
**Branch**: `claude/inspiring-einstein-eqi4f3` (pushed to `origin`; `origin/main` is at `17e8006`, one commit behind)
**Repository**: KSchlagowski/Duo-Kitchen

Permalink base used below: `https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/`

## Research Question

Ground the work described in `context/changes/link-partner-household/change.md` (roadmap item S-01): a user generates an invite code/link, their partner redeems it, and afterwards both see the same recipes, plans and shopping lists.

`change.md` carries the intent, the roadmap detail and five assumptions. The two it singles out as load-bearing:

> - Because `seed_household()` must never re-run on an existing household, redemption must not trigger re-seeding.
> - Invite storage will need a new household-scoped table, so the hard rules in CLAUDE.md apply […]. Redemption by a user who is *not yet* a member means the lookup path for an unredeemed invite cannot rely on `user_household_ids()` alone — **that tension is the main design question for planning.**

Plus the roadmap's non-blocking, user-owned unknown:

> What happens to data a person created in their single-person household before redeeming an invite (merge vs. discard)? — Owner: user. Block: no.

## Summary

- **The tension in `change.md:28` has a clean answer, and F-01 already reserved it.** The F-01 migration says in a comment, verbatim: *"Membership changes happen only through security-definer functions: the sign-up trigger below now, **the S-01 join function later**."* ([20261006120000:56-62](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L56-L62)). The redeemer never needs to *read* the invite row: they call a `security definer` function that reads it on their behalf. No RLS policy has to expose an unredeemed invite to a non-member.
- **But that function cannot live in `private`.** `supabase/config.toml:13` exposes only `public` and `graphql_public`, which is exactly why every existing definer helper sits in `private` ([comment at 20261006120000:7-9](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L7-L9)). A client-callable redemption RPC must be declared in `public`, and there is **no function in `public` anywhere in the repo today** — S-01 introduces the first one. The alternative (an Astro API route using a service-role client) is not available: `astro.config.mjs` declares only `SUPABASE_URL` and the anon `SUPABASE_KEY`, and no service-role key exists in the env schema, `.env.example` or `wrangler.jsonc`. **This is the one genuinely new architectural surface in the slice.**
- **The isolation test's catch-all forces the design, and in the right direction.** [household_isolation.sql:439-484](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L439-L484) fails CI for *any* `public` table with a `household_id` column that lacks RLS, lacks a policy for any of SELECT/INSERT/UPDATE/DELETE `to authenticated`, or carries **any** policy whose `qual || with_check` does not contain the literal string `user_household_ids`. A "redeemer reads the invite by code" policy is therefore un-shippable by construction. The exemption list is a single hardcoded name (`c.relname <> 'household_members'`, [:457](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L457)).
- **The recommended shape reuses F-01's own treatment of `household_members` exactly**: `public.household_invites` with `household_id`, all four boilerplate `to authenticated` policies through the helper (satisfying the catch-all), **plus** `revoke insert, update, delete, truncate, references, trigger … from authenticated` so only definer functions can write it. The catch-all inspects `pg_policies` only, never grants, so the policies satisfy it while the revokes make them unreachable. `select` stays granted, which gives the inviter's "show / revoke my code" UI for free. See §2.
- **Redemption is a `move`, not a `join`.** `household_members.user_id` is `unique` ([:26-32](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L26-L32), comment: `-- unique: one household per person`). A second membership row raises `unique_violation` (23505). So redemption must `update public.household_members set household_id = <target> where user_id = auth.uid()`, which leaves the redeemer's own household **memberless but alive**, holding its full ~170-row seed copy.
- **The "merge vs. discard" unknown costs nothing to defer right now, and the plan should say so explicitly.** No slice that writes user data has shipped: S-02 (targets), S-03 (plans), S-07 (products) and S-05 (recipe edits) are all `proposed`. The only rows in a solo household today are the seed copy, and both households hold an identical copy keyed by the same `seed_id`. So *today* there is nothing to merge and nothing to lose. Conversely, a merge is actively hard: `unique (household_id, seed_id)` makes re-pointing seed rows collide, and the composite FKs `(recipe_id, household_id)` / `(component_id, household_id)` default to `on update no action`, so changing a parent's `household_id` raises `foreign_key_violation` — the exact failure the F-02 plan review hit ([plan-review.md F5](#historical-context-from-prior-changes)). Recommendation: **leave the emptied household intact and record the link**, which is non-destructive, cheap, and keeps both future answers open. See §4.
- **Nothing in the data layer needs to change for FR-003.** Every policy on the five data tables is already `household_id in (select private.user_household_ids())` and the `household_members` select policy is already scoped by `household_id`, not `user_id` — with the comment *"Members see their partner's row once S-01 links them"* ([:77-83](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L77-L83)). The moment the membership row moves, both accounts see one shared library. "Both see the same recipes" requires **zero** schema work beyond the move.
- **The app layer has fewer precedents than CLAUDE.md implies.** `zod` is **not installed** and no route validates input (all three auth routes use `form.get("x") as string`). No API route returns JSON — every one returns `context.redirect()` with errors URL-encoded into `?error=`. No component anywhere calls `fetch()`. `src/components/ui/` contains **only `button.tsx`**. There is no `database.types.ts` and no `Database` generic, so services hand-cast every field. See §7 and §10.
- **Verification needs real work in three files, and one of them is easy to break.** The isolation test's household ids are stashed once in transaction-local GUCs and re-read by eight later blocks, so a mid-test redemption makes them stale; the expect-denial idiom catches `insufficient_privilege` but not a definer function's custom `P0001`; and `scripts/smoke.mjs` has a **single module-level cookie jar** and no way to pass a value between steps, so "A invites, B redeems, both see 2 members" needs a genuine refactor. ESLint's `scripts/**/*.mjs` block whitelists exactly four globals (`console`, `process`, `fetch`, `URLSearchParams`) — adding `crypto`, `setTimeout` or `URL` to the smoke script fails `npm run lint`. See §8.
- **Prerequisite state is good.** F-01 and F-02 are both merged to `main` and both migrations are **applied to the hosted project** (recorded in the F-02 plan's "Hosted Verification" block: `db push`, `test:rls`, `test:seed` and the backfill all passed). Still open from F-02: advisors (1.2), the smoke runs, all manual rows, and two `.claude/settings.json` allowlist entries. This checkout has **no `node_modules`, no `.env`/`.dev.vars` and is not linked**, so the implementer runs `npm ci` and `npx supabase link --project-ref tvmfkhnxxsnmvogplknz` first.

## Detailed Findings

### 1. What S-01 plugs into: the deployed F-01 + F-02 schema

Three migrations exist, all applied to the hosted project (`tvmfkhnxxsnmvogplknz`):

| File | What it owns |
|---|---|
| `20261006120000_household_data_scope.sql` (135 lines) | `private` schema, `households`, `household_members`, `private.user_household_ids()`, 2 select policies, `private.handle_new_user()` + `on_auth_user_created` trigger, idempotent backfill |
| `20261007120000_products_and_recipes.sql` (394 lines) | 4 enums, 5 household tables + 20 policies, 5 `private.seed_*` templates, `private.seed_household()`, trigger `create or replace` |
| `20261007120100_seed_products_and_recipes.sql` (306 lines) | 46 products / 8 recipes / 14 components / 68 ingredients / 33 steps of template content + a backfill |

Membership DDL, verbatim ([20261006120000:26-32](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L26-L32)):

```sql
create table public.household_members (
  household_id uuid not null references public.households on delete cascade,
  -- unique: one household per person
  user_id uuid not null unique references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
```

Consequences that bind S-01:

- `household_members_user_id_key` (unique on `user_id`) makes "a user in two households" **structurally impossible**. Redemption is an `update` of one row, not an `insert`. A second row fails with `unique_violation` (23505).
- PK `(household_id, user_id)` already permits N members per household, and `user_household_ids()` returns `setof uuid` consumed as `in (select …)` — **the whole policy layer is already written for multi-member households**. No policy changes are needed.
- **Nothing caps a household at two members**: no check, no trigger, no partial unique index. "At launch the app serves a single couple" (PRD §User & Persona) is not a DB invariant today.
- `households` has **no `name`** and no `owner_id`; clients cannot read `auth.users`. An invite screen saying "join X's kitchen" has nothing to display but `id.slice(0, 8)`, which is what `dashboard.astro:31` already does.
- No `role`/`is_owner` column — PRD §Access Control: *"Flat role model inside a household (no admin/member split)"*. No role column should be added.
- No leave/transfer path exists: no update or delete policy or function on `household_members`, so a join is **not undoable** by any code path short of `postgres`.

What already anticipates this slice:

- [20261006120000:56-62](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L56-L62) — the reserved implementation shape, quoted in the Summary.
- [20261006120000:34](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L34) — `comment on table public.household_members is 'Links an account to its household. Written only by security-definer functions.'`
- [20261006120000:78](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L78) — `-- Members see their partner's row once S-01 links them.`
- `src/pages/dashboard.astro:29-31` already pluralizes `${memberCount} member${memberCount === 1 ? "" : "s"}`, and `src/lib/services/household.ts:8` already selects `household_members(user_id, joined_at)`. The dashboard will read "2 members" with no app change.

Sign-up trigger, current body ([20261007120000:370-394](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261007120000_products_and_recipes.sql#L370-L394)) — `after insert on auth.users`, `for each row`, inside the sign-up transaction: household → membership → `perform private.seed_household(new_household_id)`. **A failure here blocks sign-up**, which `npm run smoke` catches.

**Redemption does not and must not touch this trigger.** The trigger fires on `auth.users` inserts only; redemption writes `household_members`. So `seed_household()` is never re-entered and `change.md`'s third assumption holds for free — but the plan should still *assert* it (see §8), because the guarantee is incidental rather than enforced.

### 2. The central design question: how a non-member reaches an unredeemed invite

The catch-all at [household_isolation.sql:439-484](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L439-L484) is the binding constraint. It loops every `public` relkind `'r'` with a `household_id` attribute, excluding only `household_members`, and raises on:

1. `relrowsecurity` false;
2. a missing policy for any of SELECT/INSERT/UPDATE/DELETE with `'authenticated' = any(p.roles)`;
3. **any** policy on the table with `anon`/`public` in roles, **or** whose `coalesce(p.qual,'') || coalesce(p.with_check,'')` does not `like '%user_household_ids%'`.

Rule 3 is the one that matters. A policy letting the redeemer select an invite by code cannot reference `user_household_ids()` — they are not a member yet — so it would fail CI by construction.

Three ways out:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| **A ⭐** `public.household_invites`, write-revoked | `household_id not null`; all four boilerplate `to authenticated` policies through the helper; **`revoke insert, update, delete, truncate, references, trigger … from authenticated`**; `select` stays granted; writes only via `public` definer RPCs | Catch-all passes **unmodified**; exactly F-01's treatment of `households`/`household_members`; inviter's "show my code / revoke" UI comes free from the select policy; one table, one FK, `on delete cascade` with the household | The insert/update/delete policies are inert boilerplate that exists only to satisfy the test — needs a SQL comment saying so, or a reader will think clients can write |
| **B** exempt the table from the catch-all | Add `household_invites` to the exemption predicate at [:457](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L457) and give the redeemer a code-based select policy | No boilerplate; the redeemer can read their own invite before joining | A policy like `using (redeemed_at is null and expires_at > now())` exposes **every pending invite's `household_id` and code to every authenticated user** — a real leak; widens the automated net's blind spot; changing the exemption is a reviewable but load-bearing edit |
| **C** `private.household_invites`, no public table | Token table in `private` (never API-reachable, no RLS needed — the precedent is the five `private.seed_*` tables at [20261007120000:242-245](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261007120000_products_and_recipes.sql#L242-L245)); three `public` RPCs: create, redeem, list-mine | Tightest: invite codes never leave the DB except through a function; mirrors how `household_members` is itself exempted as "read-only for clients by design" | Catch-all never sees it, so isolation coverage must be hand-written (template exists: [:332-351](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L332-L351) proves A cannot read `private.seed_*` or execute `seed_household()`); needs a third RPC for the inviter's read path; departs from the CLAUDE.md "household-scoped table" hard rule in letter |

**Recommendation: A.** It is the only option that needs no change to a shared test and no amendment to a hard rule, and it recovers the inviter's read path for free. C is defensible if the planner wants invite codes out of PostgREST entirely; B should be rejected.

Note the mechanism that makes A work: **the catch-all reads `pg_policies`, never `information_schema` grants.** So policies can exist for the test while `revoke` makes them unreachable — precisely the belt-and-braces pattern at [20261006120000:66-69](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L66-L69).

### 3. Where the redemption function lives — the one new architectural surface

`supabase/config.toml:13` — `schemas = ["public", "graphql_public"]`. The `private` schema comment states the consequence outright ([20261006120000:7-9](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L7-L9)):

```sql
-- Private schema: not exposed through the API (see supabase/config.toml [api].schemas),
-- so security-definer helpers kept here are not callable as RPC endpoints.
```

So the client-callable path must be a function in `public`. Two candidates, and only one is available:

- **`public` `security definer` RPC, called via `supabase.rpc(...)`.** Available. There is **no precedent** — all four existing definer functions live in `private` and are revoked from every client role. The closest grant precedent is the helper's pair at [:53-54](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L53-L54): `revoke execute … from public, anon;` then `grant execute … to authenticated;`. Supabase's default privileges grant `execute` on new `public` functions to `anon`/`authenticated`/`service_role`, so the `revoke` is **mandatory, not cosmetic**.
- **Astro API route with a service-role client.** Not available. `astro.config.mjs:17-22` declares only `SUPABASE_URL` and `SUPABASE_KEY` (both `access: "secret", optional: true`), `.env.example` has the same two, `wrangler.jsonc` has no `vars`, and `src/lib/supabase.ts` has no admin factory. Adding a service-role key means a new secret in three places (env schema, repo secrets, Cloudflare) and moves authorization out of the DB — a strictly worse fit than a definer RPC.

Required discipline for the new `public` functions, from the F-01 plan's "Critical Implementation Details" and the existing bodies: `security definer`, `set search_path = ''`, every name fully qualified (`public.household_members`, `auth.uid()`), `revoke execute … from public, anon`, `grant execute … to authenticated`. Also: with `search_path = ''`, `gen_random_uuid()` resolves (pg13+ built-in) but **`gen_random_bytes()` must be written `extensions.gen_random_bytes()`** — pgcrypto lives in `extensions` on Supabase, and `extra_search_path` (`config.toml:15`) applies to API requests, not to a definer function with an empty search path.

Note the catch-all inspects tables only, so **a new `public` RPC is covered by no existing assertion**. Its grants need hand-written isolation-test coverage (anon cannot execute; `authenticated` can; a bad code raises; a stale code raises).

Suggested surface (names follow the existing `<table>_<op>_<role>` / snake_case style):

- `public.create_household_invite()` → inserts a row for `(select auth.uid())`'s household with a server-generated code and `expires_at`; returns the code. Doing creation in an RPC (rather than a plain insert under the insert policy) keeps code entropy, expiry and "one active invite per household" server-controlled, and pairs with the §2 Option A revokes.
- `public.redeem_household_invite(p_code text)` → validates and performs the move; returns the target `household_id` (or raises).

### 4. What happens to the redeemer's old household (the roadmap Unknown)

This is the user-owned, non-blocking unknown. Research finding: **as of this slice it is moot, and the plan should state that rather than solve it.**

Why it is moot today:

- Every slice that writes user data is still `proposed`: S-02 (macro targets), S-03 (plans), S-05 (recipe edits), S-07 (add product), S-09 (shopping list). No UI inserts, updates or deletes anything.
- So a solo household's entire contents are the seed copy — and the target household holds a byte-identical copy, keyed by the same `seed_id` values.

Why a true merge is expensive, not just unnecessary:

- `unique (household_id, seed_id)` on all five tables ([20261007120000:50](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261007120000_products_and_recipes.sql#L50) and siblings) means re-pointing the redeemer's seed rows into the target household collides on **every one of the ~170 rows**. F-02's plan review said exactly this: *"the brief says the household 'holds two seed sets' when a partner joins. Both unique keys forbid that, so S-01 must dedupe before moving rows."*
- Child tables carry composite FKs — `foreign key (recipe_id, household_id) references public.recipes (id, household_id)` ([:82](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261007120000_products_and_recipes.sql#L82), and similar on ingredients/steps) — with the default `on update no action`. Changing a parent's `household_id` therefore raises `foreign_key_violation` before any policy is consulted. F-02's plan review F5 hit precisely this failure mode on a test fixture.
- `recipe_ingredients.product_id` is `on delete restrict`, so deletion order matters too (proven safe for a whole-household cascade by [seed_integrity.sql:331-338](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/seed_integrity.sql#L331-L338)).

Options, with the one that satisfies `change.md`'s "should at minimum not silently destroy it":

| Option | Behaviour | Assessment |
|---|---|---|
| **Leave it orphaned ⭐** | Move the membership; do nothing else. The old household survives memberless with its rows. Record the provenance, e.g. `household_invites.redeemed_from_household_id`, so a later merge slice can find it. | Non-destructive, one `update`, reversible by `postgres`, defers the unknown without foreclosing either answer. **Caveat:** the README's documented smoke cleanup `delete from public.households h where not exists (select 1 from public.household_members m where m.household_id = h.id)` would delete exactly these households. F-02's impl-review already flagged this as a blind spot: *"once S-01 can leave a household temporarily memberless, revisit the query."* The README must gain a warning in this slice. |
| **Delete it in the RPC** | `delete from public.households where id = <old>` cascades through all five tables. | Clean and prevents orphan growth, but irreversibly destroys data and makes the user-owned unknown a *decision taken in code* rather than deferred. F-02's plan review F8 noted S-01 "will be the first code to do this, on live data." |
| **Merge non-seed rows** | `update … set household_id = <target> where seed_id is null`, in FK-safe order. | Correct eventual answer, but needs deferrable or cascading FKs (or a parent+children rewrite in one statement), and there is nothing to merge until S-02/S-03/S-05/S-07 ship. Pure speculative work now. |
| **Refuse if non-seed data exists** | Raise unless the redeemer's household has only `seed_id is not null` rows. | A good *guard* to add alongside option 1 — it makes the slice forward-safe: once later slices create real data, redemption fails loudly instead of silently orphaning something the user cares about. Cheap (five `exists` checks) and self-documenting. |

**Recommendation: orphan + guard** (options 1 and 4 together), with the README caveat. State in the plan that merge-vs-discard is still the user's call and that this slice deliberately takes neither.

Note the related effect on CI: with two accounts per smoke run and B joining A, **every CI run will leave one extra memberless seeded household** on top of the one it already leaves. The README's CI accounting ("that account's household keeps its seeded copy of the products and recipes (~170 rows)") becomes wrong and the growth rate roughly doubles.

### 5. Invite table shape and code handling

A table shape consistent with the house style (`gen_random_uuid()` PK, `created_at timestamptz not null default now()`, `comment on table`, lowercase SQL, 2-space indent):

- `id uuid primary key default gen_random_uuid()`
- `household_id uuid not null references public.households on delete cascade` — the hard rule
- `code text not null unique` — the bearer credential
- `created_by uuid not null references auth.users on delete cascade` (attribution; PRD has no requirement, but it costs nothing and S-12 will want attribution)
- `created_at timestamptz not null default now()`, `expires_at timestamptz not null`
- `redeemed_at timestamptz`, `redeemed_by uuid references auth.users on delete set null`
- `redeemed_from_household_id uuid references public.households on delete set null` — the provenance handle from §4
- An index on `household_id`: the F-02 precedent satisfies this implicitly via a leading-column composite unique (`-- Also serves as the household_id index.`, [:49-50](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261007120000_products_and_recipes.sql#L49-L50)). With no `seed_id` here, an **explicit `create index … on public.household_invites (household_id)`** is required.
- Optional: a partial unique index `(household_id) where redeemed_at is null` to enforce one live invite per household. This makes "generate a new code" either idempotent or an explicit revoke-then-create — a UX decision for the plan.

Code generation and secrecy:

- Entropy: `encode(extensions.gen_random_bytes(8), 'hex')` (16 hex chars) or a base32 alphabet excluding look-alikes if the code is to be read aloud. `replace(gen_random_uuid()::text, '-', '')` also works with no extension dependency. In an Astro route, `crypto.randomUUID()` is available in the Workers runtime — but generating server-side in TypeScript loses the atomicity of the RPC and reopens the "user supplies their own weak code" path that §2 Option A's revokes close.
- Storing the code in plaintext is acceptable here: the table is readable only by the inviter's own household, which is who needs to see it. A hash would block the inviter's "show me my code" UI without an extra column. Worth one sentence in the plan, not a mechanism.
- Short expiry (e.g. 7 days) plus single-use plus 64+ bits of entropy is the whole threat model for a two-person app. No rate limiting exists anywhere in the stack today and none is warranted.

Validation the RPC must perform — each should raise a distinct, message-bearing error:

1. caller is authenticated (`auth.uid()` not null);
2. code exists, `redeemed_at is null`, `expires_at > now()`;
3. the target household is not already the caller's own household (redeeming your own invite);
4. the target household has fewer than 2 members (the "single couple" cap — enforced here because the RPC is the only write path; note this is **not** a DB invariant, which the plan should say explicitly);
5. the caller's current household holds no non-seed rows (the §4 guard);
6. then, atomically: `update public.household_members set household_id = <target>, joined_at = now() where user_id = (select auth.uid())`; stamp `redeemed_at`, `redeemed_by`, `redeemed_from_household_id`.

### 6. FR-003 needs no data-layer work

Once the membership row points at the target household, `private.user_household_ids()` returns the shared id and all 22 existing policies follow. Verified shape, identical across `products`, `recipes`, `recipe_components`, `recipe_ingredients`, `recipe_steps` ([20261007120000:167-179](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261007120000_products_and_recipes.sql#L167-L179) for `products`):

```sql
create policy "products_select_authenticated" on public.products
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
```

The roadmap's framing — *"sign-up/sign-in (FR-001) already exist, so this slice only adds invite and redemption"* — is accurate.

### 7. App layer: what exists, and what S-01 must invent

Precedents (all verified):

- **Client factory** `src/lib/supabase.ts:5-21` — `createClient(requestHeaders: Headers, cookies: AstroCookies)`, **returns `null`** when env vars are missing. Every caller null-checks; this is the most repeated branch in the codebase. No service-role/admin client, no `Database` generic.
- **Middleware** `src/middleware.ts:4` — `const PROTECTED_ROUTES = ["/dashboard"];`, matched with `startsWith`. `context.locals.user` is the only local (`src/env.d.ts`): **no `locals.supabase`, no `locals.householdId`**. `/api/*` is *not* protected, so `/api/auth/signup` works anonymously — and any new invite endpoint must check `locals.user` itself.
- **API routes** (`src/pages/api/auth/{signin,signup,signout}.ts`) — uppercase `export const POST: APIRoute = async (context) => {…}`, single `context` arg, no `prerender` export anywhere, input from `request.formData()` with `form.get("x") as string`, and **every response is `context.redirect()`**; errors are URL-encoded into `?error=` on the originating page.
- **Services** `src/lib/services/{household,recipes}.ts` — client as first positional param typed bare `SupabaseClient`, **errors thrown not returned**, snake→camel mapped by hand with `as string` casts, named return types from `@/types`. Both carry a comment that RLS does the scoping. **No service performs a write yet.**
- **Pages** read `Astro.url.searchParams.get("error")` and pass it as a `serverError` prop; `ServerError.tsx` renders it. `dashboard.astro:13-35` is the page → service pattern, with `try/catch` around each service call and a neutral fallback string plus `console.error` under an `// eslint-disable-next-line no-console -- …` comment.
- **Islands** — only `SignInForm.tsx` / `SignUpForm.tsx`, both progressive enhancement over a native `<form method="POST" action="/api/...">`. **No component anywhere calls `fetch()`.** `SubmitButton.tsx:12` gets pending state from `useFormStatus()`, which **only works for native form submission** — a fetch-based invite form cannot reuse it without an explicit `pending` prop.

Gaps S-01 must fill (each is a real decision, not a lookup):

1. **zod is not installed** (`node_modules/zod` absent; the four `package-lock.json` hits are transitive). CLAUDE.md mandates zod for API routes, so S-01 both installs it and sets the first schema convention.
2. **No JSON-response precedent.** Simplest consistent choice: keep the redirect-with-`?error=` pattern and render the generated code server-side on a page/dashboard section with a `data-testid`, so no new response convention and no `fetch()` island is needed. That also keeps the smoke test's assertion style unchanged.
3. **`src/components/ui/` has only `button.tsx`.** No `input`, `label`, `card`, `alert`, `dialog`, `toast`/`sonner`. Either `npx shadcn@latest add …` or reuse the hand-rolled `FormField` / `ServerError`.
4. **Unauthenticated redemption.** PRD §Access Control: *"Unauthenticated users can reach only sign-in / sign-up / invite redemption."* A page at e.g. `/join` is unprotected by default (good), but the code must survive the sign-up → confirm-email → sign-in detour. Threading `?invite=<code>` through both auth pages is fragile across the email round-trip; a short-lived `httpOnly` cookie set by `/join` is more robust. This is the main UX design decision in the slice.
5. **No inviter identity to display** (§1): no `households.name`, and clients cannot read `auth.users`. MVP answer: show no inviter name. A `public.household_invite_preview(p_code text)` definer RPC returning `{ valid, expires_at, inviter_email }` is possible but leaks an email to any code holder (arguably fine — they were sent it).
6. **Household resolution** happens per request via `getCurrentHousehold(supabase)`; nothing is cached and `household_id` is otherwise implicit via RLS. An invite service that needs the household id explicitly must call it (or a narrower new service).

### 8. Verification: three files to change, and where it bites

**`supabase/tests/household_isolation.sql`** (497 lines, `begin;` … `rollback;`, plain `do $$` blocks with `raise exception`, no pgTAP, no assert helper).

- Test users are inserted directly into `auth.users` with four columns and **no password** ([:23-26](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L23-L26)), so they exist only to fire the trigger and **can never sign in over HTTP**.
- Impersonation idiom ([:126-131](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L126-L131)): `set local role authenticated;` then `select set_config('request.jwt.claims', json_build_object('sub', <uid>, 'role', 'authenticated')::text, true);`. Back to postgres with `reset role`.
- **GUC staleness is the trap.** Household ids are discovered from the trigger once and stashed at [:36-53](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L36-L53) (`perform set_config('rls_test.a_household', …, true)`), then re-read by eight later blocks via `current_setting`. After a redemption the redeemer's stashed id points at a now-memberless household. Use **fresh users C and D** for the redemption block, placed *after* the existing assertions, and keep `before`/`after` ids in separate GUCs. The existing `expected 1` membership assertions ([:41-49](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L41-L49), [:159-162](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L159-L162)) are about the *sign-up trigger* and survive that way.
- **The expect-denial idiom does not catch a definer function's errors.** The established form is `begin … raise exception '<msg>'; exception when insufficient_privilege then null; end;` ([:186-190](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L186-L190)), with a row-count variant for RLS silent no-ops ([:192-199](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L192-L199)). A redeem RPC rejecting a bad code raises `P0001` (plpgsql `raise exception`). The plan should define **one** convention for this — e.g. `exception when sqlstate 'P0001' then null` or dedicated `errcode`s per rejection reason — rather than inventing it per assertion.
- Four separate `tables text[]` / `foreach … array[…]` literals ([:74](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L74), `:246`, `:279`, `:427`) must each gain `household_invites`; they are not shared. Fixture ids follow `00000000-0000-4000-b000-00000000<a|b>00<1..5>` with a single-digit `%s` format — invites take `…a006`/`…b006`.
- Assertions worth adding: inviter sees only own-household invites; redeemer (pre-join) sees **zero** invites; anon sees zero and cannot execute either RPC; direct `insert`/`update`/`delete`/`truncate` on `household_invites` as `authenticated` raises `insufficient_privilege` (mirroring [:179-237](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L179-L237)); after redemption C and D share one household and each sees the *same* row counts across all five data tables; **seed counts in the target household are unchanged** (proving no re-seed); the second redemption of the same code raises; an expired code raises; redeeming into a 2-member household raises.
- The final `raise notice` summary ([:491](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/household_isolation.sql#L491)) and success `select` list the covered areas and should be extended.

**`supabase/tests/seed_integrity.sql`** (353 lines) runs entirely as `postgres` with no test users and no impersonation; it creates a household directly (`insert into public.households (id) values ('00000000-0000-4000-c000-000000000001');`) and calls `private.seed_household(hh)` twice to prove idempotence ([:301-312](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/tests/seed_integrity.sql#L301-L312)). Its dominant idiom differs from the isolation test's — aggregate offenders with `string_agg` then raise if non-null. S-01 likely needs no change here, but it is the natural home for a "redemption does not re-copy templates" assertion if the planner prefers to keep that out of the isolation file.

**`scripts/smoke.mjs`** (92 lines, zero deps) is where "both see the same household" is the *only* assertable end-to-end. Four structural changes, none cosmetic:

1. **A second cookie jar.** `const jar = new Map()` is module-level ([:7](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/scripts/smoke.mjs#L7)) and `request()` closes over it. Either parametrise it or refactor into a `makeClient()` factory. A second email is needed too (`email` is `smoke-${Date.now()}@example.com`, evaluated once at module load; a `smoke-b-…` sibling still matches the README's `smoke-%@example.com` cleanup glob).
2. **Value-carrying between steps.** The runner discards `actual` after asserting ([:74-89](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/scripts/smoke.mjs#L74-L89)), so the invite code must be captured into a module-level `let` inside a step's own closure — and the redeem step's `form` must be built *inside* its closure, since the `steps` array literal is evaluated eagerly.
3. **A generic extractor.** `libraryLine(body)` ([:42-45](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/scripts/smoke.mjs#L42-L45)) is hardcoded to one `data-testid` and is used only in the failure printout. Generalise to `testIdText(body, id)`.
4. **A lazy assertion.** `expected.body` is a RegExp built eagerly, so it cannot embed A's household prefix. The smallest unblocking change is an optional `check: (actual) => boolean` field on the step tuple.
5. **ESLint trap.** `eslint.config.js:73-78` gives `scripts/**/*.mjs` an explicit globals allowlist of exactly `console`, `process`, `fetch`, `URLSearchParams`. Using `crypto`, `setTimeout`, `URL`, `AbortController` or `TextDecoder` in the smoke script trips `no-undef` and fails `npm run lint`. **This is the easiest way to break CI while editing this file.**

Suggested step order to splice after the existing "dashboard renders for signed-in user with seeded library": A dashboard → capture household prefix; A creates invite → capture code; switch to jar B → sign up B → sign in B → B's dashboard shows B's *own* household; B redeems → 302; B's dashboard shows A's prefix and `2 members`; switch to jar A → A's dashboard shows `2 members` and an unchanged library count.

**CI** (`.github/workflows/ci.yml`, 60 lines): two parallel jobs on push/PR to `main`. `smoke` runs `npm ci` → `supabase link` → `npm run test:rls` → `npm run test:seed` → write `.env`/`.dev.vars` → `npm run build` → preview + `npm run smoke`. **`npx supabase db push` appears nowhere.** Practical consequence: the `household_invites` migration must be pushed to the hosted project **before** the PR adding the isolation assertions, or `test:rls` fails on a missing table — and once pushed, the catch-all starts exercising the new table on *every* open branch. CLAUDE.md already states the rule; it bites concretely here.

Note also: `node-version: 22` in CI vs. `.nvmrc`'s `22.14.0`; `.sql` files are in **neither** lint-staged glob (`package.json:59-66`), so migrations and tests are linted by nothing; `no-console` is a `warn` and `npm run lint` has no `--max-warnings 0`, so console statements don't fail CI; ESLint runs `tseslint.configs.strictTypeChecked` (`eslint.config.js:17`), so an untyped `supabase.rpc(...)` result will trip `no-unsafe-assignment`/`no-unsafe-member-access` and needs an explicit cast at the boundary, exactly as `src/lib/services/household.ts:19-24` does today.

### 9. Interactions with other slices and docs

- **S-02 (set-daily-macro-targets), parallel.** If targets are keyed on `user_id`, they travel with the user through redemption. If they are household-scoped, redemption would strand them. S-01's plan should state the expectation so S-02 doesn't contradict it. Each person keeps their own targets and ratings per PRD §Access Control.
- **S-04 (solve-daily-macros)** lists S-01 as a prerequisite because the solver needs two people. Nothing in S-01 should model "person A vs. person B" labels — that is S-02/S-04 territory; the flat membership rows plus per-user targets are the whole model.
- **S-06 (rate-and-filter-recipes)** depends on S-01 for "see your partner's rating". Ratings will be a new table keyed on `(household_id, recipe_id, user_id)` — the member-sees-partner read path S-01 unlocks.
- **S-12 (agent-recipe-import)** extends `private.user_household_ids()` (the documented extension point at [:39](https://github.com/KSchlagowski/Duo-Kitchen/blob/519d31c5177600a2e0be22f22c71bb01f8750840/supabase/migrations/20261006120000_household_data_scope.sql#L39)) so the "system" identity reaches a household. An invite/authorization mechanism built here is *not* that mechanism, but the `public` definer-RPC precedent S-01 sets is likely what S-12 reuses.
- **F-03 (deploy-and-install-skeleton)** is independent, but an invite *link* is only truly useful once the production URL is stable — it already is (`https://duo-kitchen.mediewilnp.workers.dev`).
- **Docs to update in this slice**: CLAUDE.md (the new `public` RPC convention and that `household_invites` is write-revoked like `household_members`; the invite/redemption routes under §Auth flow), README.md (the auth-routes table gains the join route; the **CI section's orphan-household accounting and the cleanup-query caveat** from §4), and `.claude/settings.json` still owes the two `test:seed` allowlist entries from F-02's open follow-up.

## Code References

- `supabase/migrations/20261006120000_household_data_scope.sql:7-14` – `private` schema is not API-exposed; `usage` granted to `authenticated` only
- `supabase/migrations/20261006120000_household_data_scope.sql:26-32` – `household_members` DDL; `unique (user_id)` = one household per person
- `supabase/migrations/20261006120000_household_data_scope.sql:41-54` – `private.user_household_ids()`: `stable`, `security definer`, `set search_path = ''`, grant pattern
- `supabase/migrations/20261006120000_household_data_scope.sql:56-69` – "the S-01 join function later" + the belt-and-braces revokes to copy
- `supabase/migrations/20261006120000_household_data_scope.sql:71-83` – the two select policies; "Members see their partner's row once S-01 links them"
- `supabase/migrations/20261006120000_household_data_scope.sql:113-135` – idempotent backfill idiom
- `supabase/migrations/20261007120000_products_and_recipes.sql:49-51` – `unique (household_id, seed_id)` doubling as the `household_id` index; `unique (id, household_id)` for composite FKs
- `supabase/migrations/20261007120000_products_and_recipes.sql:82,107-108,126-129` – composite FKs (`on update no action`) that block re-pointing `household_id`
- `supabase/migrations/20261007120000_products_and_recipes.sql:146,154-164` – why TRUNCATE is revoked; the per-table revoke block
- `supabase/migrations/20261007120000_products_and_recipes.sql:167-179` – the four-policy template to copy verbatim
- `supabase/migrations/20261007120000_products_and_recipes.sql:242-245` – `private.seed_*` tables need no RLS (precedent for §2 Option C)
- `supabase/migrations/20261007120000_products_and_recipes.sql:312-368` – `private.seed_household()`, "new or empty households only"
- `supabase/migrations/20261007120000_products_and_recipes.sql:370-394` – current sign-up trigger body (household → membership → seed)
- `supabase/tests/household_isolation.sql:10-16` – the file's own template + impersonation recipe
- `supabase/tests/household_isolation.sql:23-26` – test users: 4 columns, no password, fires the trigger
- `supabase/tests/household_isolation.sql:36-53` – household ids stashed once in transaction-local GUCs (the staleness trap)
- `supabase/tests/household_isolation.sql:179-237` – direct-write denial block to mirror for invites
- `supabase/tests/household_isolation.sql:332-351` – how a `private` object's unreachability is asserted (Option C template)
- `supabase/tests/household_isolation.sql:439-484` – the catch-all; `:457` the single-name exemption; `:473-481` the `user_household_ids` text check
- `supabase/tests/seed_integrity.sql:290-312` – household created directly + `seed_household()` run twice for idempotence
- `supabase/tests/seed_integrity.sql:331-338` – household delete cascade proven safe through the `restrict` product FK
- `supabase/config.toml:13` – API exposes `public`, `graphql_public` only
- `scripts/smoke.mjs:7` – the single module-level cookie jar
- `scripts/smoke.mjs:23-45` – `request()` (returns `body`) and the single hardcoded extractor
- `scripts/smoke.mjs:47-89` – step tuples `[name, run, expected{status,location?,body?}]` and the runner
- `.github/workflows/ci.yml:36-47` – link + `test:rls` + `test:seed`; no `db push` anywhere
- `package.json:5-16` – scripts; `:59-66` lint-staged globs exclude `.sql` and `.mjs`
- `eslint.config.js:17` – `strictTypeChecked`; `:73-78` the four-global allowlist for `scripts/**/*.mjs`
- `astro.config.mjs:17-22` – `env.schema`: only `SUPABASE_URL` / `SUPABASE_KEY`, both optional secrets
- `src/lib/supabase.ts:5-21` – client factory returning `null`; no admin client
- `src/middleware.ts:4` – `PROTECTED_ROUTES = ["/dashboard"]`, `startsWith` matching; `/api/*` unprotected
- `src/env.d.ts` – `Locals` carries only `user`
- `src/pages/api/auth/signup.ts:1-20` – the API-route template (formData, no zod, redirect-only)
- `src/lib/services/household.ts:5-26` – service conventions and the hand-cast snake→camel mapping
- `src/pages/dashboard.astro:13-35,47-49` – page → service pattern, neutral fallbacks, `data-testid` hooks
- `src/components/auth/SignInForm.tsx:12-43,86` – island = progressive enhancement over a native form; no `fetch()`
- `src/components/auth/SubmitButton.tsx:12` – `useFormStatus()`, native submit only

## Architecture Insights

- **One choke point, one rule, one escape hatch.** All *reads* funnel through `private.user_household_ids()`; all *membership writes* funnel through `security definer` functions. S-01 is the first consumer of the second half of that design, and F-01 wrote the comment reserving it. Following the pattern costs almost nothing; deviating costs a shared test or a hard rule.
- **The catch-all is the architecture, enforced.** It converts "follow the household pattern" from a convention into a CI gate, and it deliberately has no way to express "a non-member may read this row". That pushes every cross-household operation into a definer function — which is the correct security posture, reached by making the alternative untestable.
- **`private` for objects the client must not reach; `public` for the one function it must call.** S-01 introduces this second category. The grant pair (`revoke execute … from public, anon` / `grant execute … to authenticated`) is mandatory because Supabase's default privileges on `public` functions are permissive.
- **Policies and grants are independent levers.** Policies satisfy the catch-all; grants decide what is actually reachable. F-01 already uses both together on `households`/`household_members`; §2 Option A is the same move applied to a table that the catch-all *does* inspect.
- **`seed_id` is the join seam between households, and also the thing that forbids merging them.** `unique (household_id, seed_id)` makes copies idempotent and addressable, and simultaneously guarantees that two seeded households can never be unioned by re-pointing rows. Any future merge slice must drop or re-key one side's seed rows first.
- **A memberless household is already treated as garbage** by the documented cleanup query, while S-01's least-destructive option deliberately creates one. These two facts must be reconciled in the README or data will be deleted by a documented maintenance step.
- **The verification stack has no bridge between SQL and HTTP.** Isolation-test users have no password and can never sign in; smoke accounts' uuids are never known to SQL. Membership mechanics are provable only in SQL; "both partners see the same thing" is provable only in `smoke.mjs`. Both halves are needed.

## Historical Context (from prior changes)

- `context/archive/2026-10-06-household-data-scope/plan.md:33` — explicitly out of F-01 scope: *"Invite / join / leave flows, or what happens to a partner's solo household on join (S-01)."*
- `context/archive/2026-10-06-household-data-scope/plan.md:69,73` — `unique(user_id)` enforces one household per person; no insert/update/delete policies on either table, *"writes happen only via definer functions: the trigger now, the S-01 join function later"*.
- `context/archive/2026-10-06-household-data-scope/plan.md:47-50` — the definer discipline S-01 must copy: `security definer` + `set search_path = ''` + fully qualified names; revoke `execute` from `public`/`anon`; never query `household_members` inside a policy; prefer `in (select fn())` for initPlan evaluation.
- `context/archive/2026-10-06-household-data-scope/plan-brief.md:22,24,60` — *"Clean join point for S-01 invites"*; *"Changes go only through definer functions (trigger now, S-01 join later)"*; *"The partner's solo household when they join is S-01's decision; nothing here blocks either choice."*
- `context/archive/2026-10-06-household-data-scope/reviews/impl-review.md` F2 (Fix A) — CI tests the deployed schema, so `db push` then `test:rls` before merging; the catch-all was added as part of that fix. F1 narrowed `.claude/settings.json` so ad-hoc `db query --linked` now prompts.
- `context/archive/2026-10-07-seed-products-and-recipes/research.md:213` — already anticipated this slice: *"under per-household seeding, a partner joining a household brings a duplicate seed set. S-01's 'merge vs. discard' Unknown should account for it, for example by discarding seed-origin rows."*
- `context/archive/2026-10-07-seed-products-and-recipes/plan-brief.md:35,82` — `seed_id` exists partly as *"a handle for S-01 dedupe"*; *"When a partner joins (S-01), the household holds two seed sets. S-01 must discard seed-origin rows (`seed_id is not null`) from one side."*
- `context/archive/2026-10-07-seed-products-and-recipes/reviews/plan-review.md:109` — corrects that brief: *"Both unique keys forbid that, so S-01 must dedupe **before** moving rows."* And `:179` — *"S-01 (discarding a household when a partner joins) will be the first code to do this, on live data."*
- `context/archive/2026-10-07-seed-products-and-recipes/reviews/plan-review.md:146-148` (F5) — the concrete precedent for the composite-FK trap: changing a row's `household_id` fails with `foreign_key_violation` under `on update no action`, before any RLS assertion runs.
- `context/archive/2026-10-07-seed-products-and-recipes/reviews/impl-review.md:69` (F3) — the orphan cleanup query, with the blind spot stated: *"once S-01 can leave a household temporarily memberless, revisit the query."*
- `context/archive/2026-10-07-seed-products-and-recipes/follow-ups/review-fixes.md` — two items still open (F1 hosted verification rows/manual rows; F2 the `test:seed` allowlist entries). The F-02 plan's "Hosted Verification" block records that `db push`, `test:rls`, `test:seed` and the backfill did run against the hosted project, so **the schema S-01 builds on is live**.
- `context/foundation/shape-notes.md:24,203` — *"invite code / link generated by one partner, redeemed by the other"*, with the explicitly *"rejected alternative for household linking: seeding the link directly in the database."* PRD FR-002's Socrates note records that hand-linking was the cheaper option and the invite flow is a deliberate user decision.
- `context/foundation/prd.md:153` — *"Unauthenticated users can reach only sign-in / sign-up / invite redemption."* `:150-151` — flat role model; each person keeps their own macro targets and ratings, visible to the partner.

## Related Research

- `context/archive/2026-10-07-seed-products-and-recipes/research.md` — the only prior `research.md`. Its §1 (F-01 schema), §3 (cloud-only seeding), §5 (isolation test and catch-all) and Open Question 3 (S-01's duplicate seed set) are the direct inputs to this document. F-01 went straight to plan with no research artifact.

## Assumptions (stated because this session is non-interactive)

1. **Intent = `change.md` + roadmap S-01.** Outcome, PRD refs (US-01, FR-001, FR-002, FR-003) and the scoping caveat (*"sign-up/sign-in already exist, so this slice only adds invite and redemption"*) are taken as written. No slice beyond invite + redemption is in scope.
2. **The one-household-per-account model stays.** Redemption moves the redeemer into the inviter's household (`change.md` assumption 1). `household_members_user_id_key` is not dropped. Nothing in the PRD or roadmap suggests multi-household membership, and dropping that constraint would also break `getCurrentHousehold`'s `.maybeSingle()`.
3. **Redemption goes through a `public` `security definer` RPC**, because `private` is not API-exposed and no service-role key exists. This is the research's main recommendation, not a user decision; the alternative (adding a service-role secret) is noted and rejected on cost and posture.
4. **Invite storage = §2 Option A** (`public.household_invites`, four boilerplate policies, writes revoked). Option C is a legitimate alternative if the planner prefers invite codes out of PostgREST; Option B is rejected.
5. **The redeemer's emptied household is left intact and recorded, not merged and not deleted**, plus a guard that refuses redemption if it holds non-seed rows. This keeps the user-owned merge-vs-discard unknown genuinely open and satisfies `change.md`'s "at minimum not silently destroy it". **This is the decision most worth confirming with the user before planning.**
6. **A two-member cap is enforced inside the RPC, not as a DB invariant.** PRD says one couple; the RPC is the only write path, so a check there is sufficient. If the user wants a real invariant, that is a counting trigger and should be an explicit plan item.
7. **No inviter name is displayed** in the MVP redemption screen, since `households` has no `name` and clients cannot read `auth.users`.
8. **Verification stays in the existing three files** (`household_isolation.sql`, `smoke.mjs`, and `seed_integrity.sql` if needed). No test runner is introduced — consistent with F-01's and F-02's explicit decisions.
9. **zod is installed in this slice** because CLAUDE.md mandates it for API routes and it is currently absent. S-01 therefore sets the first validation convention.

## Open Questions

1. **Merge vs. discard of pre-redemption data** — the roadmap's user-owned unknown. §4 recommends deferring it (orphan + guard) and explains why it is cost-free to defer *today* and expensive to solve. Confirm with the user. If "merge" is chosen later, it needs deferrable or cascading composite FKs, or a parent+children rewrite, plus seed-row deduping by `seed_id`.
2. **Invite storage option A vs. C** (§2) — whether invite codes may live in an API-reachable `public` table at all. A is recommended; C is tighter and costs one extra RPC plus hand-written test coverage.
3. **How the code survives sign-up → email confirmation → sign-in** (§7.4): query param threaded through both auth pages, or a short-lived `httpOnly` cookie set by the unprotected `/join` page. The cookie is more robust across the email round-trip; both change the auth pages.
4. **One live invite per household, or many?** A partial unique index `(household_id) where redeemed_at is null` makes "generate" idempotent or forces an explicit revoke. UX decision.
5. **Invite expiry window** — 24 h, 7 d, or none. Nothing in the PRD specifies it.
6. **Does the redemption screen show who invited you?** Requires either a `households.name` column (scope creep) or a preview RPC that returns the inviter's email to any code holder.
7. **Is `revoke`-on-a-policied-table too subtle?** §2 Option A deliberately ships four policies that no grant can reach. It passes the catch-all and matches F-01, but a future reader may "fix" the revokes. Decide whether a SQL comment is enough or whether the catch-all should instead learn about grants.
8. **Error convention for definer-function rejections** (§8): one `P0001` catch-all, or distinct `errcode`s per reason so the test and the UI can distinguish "expired" from "already used" from "household full". Affects both the isolation test and the `?error=` messages.
9. **Leave / unlink** — not in the PRD or the roadmap, and impossible today (no update/delete path on `household_members`). Confirm it is out of scope; if a user redeems the wrong invite there is no recovery short of `postgres`.
10. **README cleanup query** — it deletes memberless households, which is exactly what §4's recommendation creates. Does the slice amend the query, add a warning, or both?
11. **S-02 coupling** (§9): are macro targets keyed on `user_id` (travel with the user) or on `household_id` (stranded by redemption)? S-01 should record the expectation even though S-02 owns the table.
12. **Unverified tooling detail**: this checkout has no `node_modules`, no `.env`/`.dev.vars` and is not linked, so nothing in this document was executed against the hosted project or a local Postgres. All SQL behaviour above is read from the migrations and tests, not run. F-02's precedent for closing that gap was PGlite in the scratchpad plus hosted runs before merge.
