# F-04 Shared Recipe Library — Plan Brief

> Full plan: `context/changes/shared-recipe-library/plan.md`
> Research: `context/changes/shared-recipe-library/research.md`

## What & Why

Recipes and products become **one public library shared by every signed-in user**. No household owns a recipe or product any more. This replaces F-02's per-household seed copies. S-03 (plans), S-05 (browse), S-06 (per-person ratings) and S-07 (add product) all need to reference a library row that never moves with a household. A per-person rating pointing at a household copy would be carried into a household where that copy does not exist.

## Starting Point

The five tables carry `household_id`, `seed_id` and composite household FKs. Each of the 34 households holds its own copy of 46 products and 8 recipes, made by `private.seed_household()` from `private.seed_*` templates at sign-up. Clients can currently write their household's copies. Live data is 100% unmodified seed copies, so there is nothing to merge. `redeem_household_invite()` has a KD006 guard that counts household-owned library rows.

## Desired End State

One canonical set of library rows. The seed rows keep their stable `5eed…` ids. Every signed-in user reads the same library, and no client can write it. Sign-up creates only a household and membership. The seed function, templates and KD006 are gone. The isolation test gains a classification catch-all, so a future table can no longer escape both the household and library checks.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Who may edit/delete (roadmap Unknown) | Read-only for clients in F-04. Later: seed rows immutable, user rows editable by author + current partner | One user's mistake must not change every couple's solver inputs, and FR-011 still needs person-added products later | Research §7.3 |
| `created_by` column | Deferred to S-07 | No F-04 path writes it; a nullable `alter` later is non-blocking | Research / Plan |
| "Public" audience | All authenticated users, never `anon` | PRD lets anonymous visitors reach only sign-in, sign-up and invite redemption | Research |
| Migration shape | Guarded drop + recreate, copy from templates keeping ids, drop templates last | Reads as the final shape; the guard re-proves at push time that nothing but seed copies exists | Research §7.4 |
| Seed identity | Stable `5eed000N-…` ids become PKs; `seed_id` dropped | Tests, solver fixtures and the agent can address seed rows deterministically | Research |
| RLS | One `select … using (true)` policy + write grants revoked (both levers) | Revoke blocks writes now; the absence of write policies blocks them if a grant returns | Research §7.2 |
| KD006 | Retired, never reused; UI message removed | Households no longer own library rows, so nothing can be "left behind" | Research §7.5 |
| Seed test scoping | Temp views over public tables filtered by seed id prefix | Keeps every check textually identical, and user-added rows (S-07) can never fail CI | Plan |
| Deploy sequencing | Migration + both rewritten SQL tests in one commit, pushed right after `test:rls`/`test:seed` pass | CI tests run against the deployed schema | Research OQ4 / Plan |

## Scope

**In scope:** the migration (schema, RLS, trigger restore, redeem rewrite, seed removal); the isolation, seed-integrity and smoke test rewrites; removing KD006 from `invites.ts`; the `recipes.ts` comment; CLAUDE.md, README and roadmap updates.

**Out of scope:** any client write path to the library; `created_by`; recipe UI (S-05); ratings (S-06); plan references (S-03) and whether plans should block redemption; relaxing `unique (name)`.

## Architecture / Approach

There are now three ownership classes, each with its own automated guard:

- **Household data**: `household_id` + `user_household_ids()`, policed by the existing catch-all.
- **Per-person data**: `user_id` + a composite membership FK.
- **Public library**: no `household_id`, select-only, listed in `library_tables` and policed by the new classification catch-all.

The migration runs in this order: guard → trigger restore → redeem without KD006 → drop the seed function → drop/recreate the five tables → copy the templates → drop the templates → RLS and grants.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema + DB tests | F-04 schema on the hosted project, proven by the rewritten `test:rls` and `test:seed` | Destructive migration. Mitigated by the guard, the dry run and dropping templates last; there is also a short CI window between `db push` and the git push |
| 2. App + smoke | KD006 message removed; smoke proves unlinked accounts share one library | Low: the smoke regex depends on the captured `libraryLineA` |
| 3. Docs | CLAUDE.md, README and roadmap describe the implemented library and the future authorship rule | Stale guidance misleading S-03/S-07 if a bullet is missed |

**Prerequisites:** Supabase CLI linked to `tvmfkhnxxsnmvogplknz`; F-02 and S-01 migrations deployed (they are).
**Estimated effort:** about 1–2 sessions. Phase 1 is the bulk, mostly the isolation-test rewrite.

## Open Risks & Assumptions

- `supabase db push` applying each file in a transaction is assumed, not verified. The step ordering keeps a partial failure recoverable regardless.
- If anyone creates or edits library rows between the research and the push, the guard aborts the migration. That is intended: investigate before forcing anything.
- The authorship rule (author + current partner) is recorded but only enforced when S-07 adds `created_by`.

## Success Criteria (Summary)

- Two fresh, unlinked accounts see the identical `Library:` line, and it is still identical after they link.
- No signed-in user can write the library through PostgREST, and anonymous visitors cannot read it.
- `test:rls`, `test:seed` and `smoke` all pass in CI against the hosted project.
