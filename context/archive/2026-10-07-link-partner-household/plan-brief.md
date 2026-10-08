# Link Partner Into One Shared Household — Plan Brief

> Full plan: `context/changes/link-partner-household/plan.md`
> Research: `context/changes/link-partner-household/research.md`

## What & Why

Roadmap slice **S-01**. One partner generates an invite code/link from their dashboard; the other redeems it and is moved into the inviter's household. Afterwards both accounts read and write the same recipes, plans and shopping lists. Covers PRD **FR-002** and **FR-003**; it is the prerequisite for S-04, because the solver needs two people.

## Starting Point

F-01 and F-02 are merged and live on the hosted project. Every account already gets a household of one at sign-up, every data table is already scoped by `household_id in (select private.user_household_ids())`, and `household_members` is already read-scoped by household rather than by user — with a comment reading *"Members see their partner's row once S-01 links them."* F-01 even reserved this slice by name: *"Membership changes happen only through security-definer functions: the sign-up trigger below now, the S-01 join function later."*

So **FR-003 needs zero schema work.** The moment one membership row moves, both accounts see one shared library. What is missing is invite storage, a client-callable function to perform the move, and the UI around both.

## Desired End State

A member of a one-person household sees a 16-hex code and a `/join?code=…` link on their dashboard. Their partner opens the link, signs up or signs in (surviving the email-confirmation round-trip), clicks one confirm button, and both dashboards then read `Household: <same prefix> · 2 members` with identical library counts. The redeemer's former household survives intact and memberless, recorded on the invite row.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Where the join function lives | A `public` `security definer` RPC — the **first function in `public` in this repo** | `private` is not API-exposed (`config.toml:13`), and no service-role key exists in the env schema, so there is no other client-callable path | Research |
| How a non-member reaches an unredeemed invite | They never read it. They call an RPC that reads it for them | The isolation catch-all makes a "read an invite by code" policy un-shippable by construction — correctly, since such a policy would expose every pending invite to every authenticated user | Research |
| Invite storage | `public.household_invites` with four conforming policies **and** writes revoked from `authenticated` | The catch-all inspects `pg_policies`, never grants — so the policies satisfy CI while the revokes keep writes to the RPCs. Exactly F-01's treatment of `household_members`, and the `select` policy gives the inviter's "show my code" UI for free | Research |
| Pre-redemption data (the roadmap's open unknown) | **Deferred, not answered**: orphan the old household, record its id on the invite, and **refuse redemption if it holds non-seed rows** | A merge is schema-forbidden (`unique (household_id, seed_id)` collides on all ~170 rows; composite FKs are `on update no action`), and there is nothing to merge — every slice that writes user data is still `proposed`. The guard makes the deferral forward-safe | Research + Plan |
| Code survives sign-up → confirm-email → sign-in | Short-lived `httpOnly` cookie set by `/join`; `signin.ts` redirects there when it is present | A threaded query param does not survive the email round-trip. Touches one route's redirect target and neither auth page | Plan |
| Invite code format | 16 hex chars from `gen_random_uuid()`, not `gen_random_bytes()` | 64 bits with **no extension dependency** — `gen_random_uuid()` resolves under `set search_path = ''`; pgcrypto lives in `extensions` and would need qualification | Plan |
| Rejection errors | Distinct custom SQLSTATEs in class `KD`, not one `P0001` | Lets the isolation test assert the precise reason (a wrong rejection propagates and fails) and the UI show a specific message | Plan |
| Two-member cap | Enforced in both RPCs, explicitly **not** a DB invariant | The RPCs are the only write path to `household_members`. "One couple" is a product statement, not a durability requirement | Plan |
| Live invites per household | One. Partial unique index on `(household_id) where redeemed_at is null`; create deletes the previous | One obvious live code. The predicate cannot include `expires_at > now()` (not immutable), which is why create deletes rather than relying on the index | Plan |
| Expiry / inviter identity / clipboard | 7 days / none shown / none | Nothing in the PRD specifies expiry; `households` has no `name` and a preview RPC would leak the inviter's email; a clipboard button would be the slice's only React island | Plan |

## Scope

**In scope:** `public.household_invites` + RLS + revokes; `create_household_invite()` and `redeem_household_invite()`; the non-seed guard and provenance stamp; isolation-test coverage (invite isolation, write denial, RPC grants, a full redemption, five rejection paths); `zod` + first validation convention; an invite service; two API routes; the invite cookie; `/join`; a dashboard invite section; a two-account smoke test; CLAUDE.md and README updates.

**Out of scope:** merging or deleting pre-redemption data; leave/unlink/transfer; roles; `households.name`; a DB-level member cap; rate limiting; code hashing; new React components or `shadcn/ui` additions; retrofitting the auth routes to zod; multi-household membership; any change to the isolation catch-all; a service-role key; any test runner.

## Architecture / Approach

Follow the choke point F-01 built: **all reads through `private.user_household_ids()`; all membership writes through definer functions.** This slice is the first consumer of the second half, and adds the one surface the design always implied — a `public` RPC, because `private` is unreachable from the API.

```
/join?code=…  ──(cookie survives the auth detour)──▶  POST /api/household/redeem
                                                            │ zod
                                                            ▼
                                            public.redeem_household_invite(code)
                                              security definer, search_path = ''
                                              validate → KD001..KD007
                                              UPDATE household_members.household_id
                                              stamp redeemed_from_household_id
                                                            │
                                      ┌─────────────────────┴─────────────────────┐
                              shared household                        old household: memberless,
                              (22 existing policies                    rows intact, recorded on
                               now resolve for both)                   the invite row
```

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 0. Prerequisites | `npm ci`, env files, `supabase link`, green baseline | None — but nothing in the research was ever executed, so the baseline is unverified |
| 1. SQL | Table, index, RLS, revokes, two RPCs, grants, isolation coverage | **Ordering is fixed**: `db push` *before* the test assertions, because CI tests the deployed schema. Pushing also makes the catch-all exercise the new table on every open branch |
| 2. App layer | zod, types, service, two routes, cookie, `/join`, dashboard section | The cookie must survive the email round-trip; `strictTypeChecked` on untyped `rpc()` results needs explicit casts |
| 3. Smoke | Two cookie jars, ten new steps proving FR-002 + FR-003 over HTTP | A genuine refactor — one module-level jar, eager assertions. The `scripts/**/*.mjs` globals allowlist is the easiest way to break CI here |
| 4. Docs | CLAUDE.md conventions, README fixes, allowlist entries | The documented cleanup query currently deletes exactly what Phase 1 preserves |

**Prerequisites:** F-01 and F-02 merged and pushed (both are). A linked CLI, `.env`/`.dev.vars`, and `node_modules` — none present in this checkout.
**Estimated effort:** ~3–4 sessions. Phase 1 is the bulk (the migration plus ~200 lines of SQL assertions); Phase 3 is a small but fiddly refactor; Phase 4 is under an hour.

## Open Risks & Assumptions

- **The deferred unknown is the user's to close.** Merge-vs-discard of pre-redemption data is recorded as deferred, not answered. The `KD006` guard makes redemption fail loudly rather than silently orphan data — but it catches *additions*, not *deletions*: a household that deleted seed rows would pass and lose those deletions. Nothing can delete seed rows today; the slice that enables it (S-05) must revisit the guard.
- **Redemption is irreversible by application code.** No update/delete surface exists on `household_members`, and leave/unlink is out of scope. A wrong redemption needs `postgres`. Mitigated by making `/join` an explicit POST, never a one-click GET.
- **The README's orphan-cleanup query is a live data-loss hazard** until Phase 4 lands. F-02's impl-review already flagged it; this slice is what makes it bite.
- **Four conforming policies that no grant can reach is deliberately subtle.** A future reader could "fix" the revokes and silently open direct writes. The guard is an executable assertion in the isolation test, not a comment.
- **Nothing in the grounding research was executed** — all SQL behaviour was read from migrations and tests, not run. Phase 0 exists to close that gap before anything is written.
- **One correction to the research**, carried into the plan: of the four table-list literals it says must gain `household_invites`, only two should. `:74` compares seed-template counts (invites have no `seed_id`) and `:279` is a cross-household *write* loop (invites are write-revoked).
- **S-02 coupling is an expectation, not a contract.** This plan records that macro targets should be keyed on `user_id` so they travel with the person through redemption; S-02 owns the table.

## Success Criteria (Summary)

- A partner can be invited and joined end to end in a browser, surviving the email-confirmation detour, and both dashboards then show the same household with `2 members` and identical library counts.
- The target household's seed row counts are unchanged by redemption, and the redeemer's former household survives with its rows intact and its id recorded.
- `lint`, `astro check`, `build`, `test:rls`, `test:seed` and a two-account `smoke` all pass — with the isolation test proving the security posture in SQL and the smoke test proving shared visibility over HTTP.
