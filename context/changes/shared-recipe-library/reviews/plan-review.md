<!-- PLAN-REVIEW-REPORT -->
# Plan Review: F-04 Shared Recipe Library Implementation Plan

- **Plan**: context/changes/shared-recipe-library/plan.md
- **Mode**: Deep (codebase verification done inline against the migrations, both SQL tests, smoke.mjs, services and CI)
- **Date**: 2026-10-08
- **Verdict**: REVISE (light: four targeted text edits; the approach itself is sound)
- **Findings**: 0 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | WARNING (F2) |
| Blind Spots | WARNING (F1, F3) |
| Plan Completeness | WARNING (F4) |

## Grounding

Grounding: 11/11 paths ✓, 12/12 symbols and line anchors ✓, brief↔plan ✓.

- **Paths checked**: the four existing migrations, both SQL tests, `scripts/smoke.mjs`, `src/lib/services/invites.ts`, `src/lib/services/recipes.ts`, `context/foundation/roadmap.md`, `CLAUDE.md`/`README.md`.
- **Anchors checked**: the F-01 `handle_new_user` body (`20261006120000_household_data_scope.sql:88-107`); the KD006 guard (`20261007120200_household_invites.sql:261-282`) and the KD006 comments (`:93`, `:236-238`, `:315`); the `private.seed_*` shape (`20261007120000_products_and_recipes.sql:246-301`), whose components already carry `unique (id, recipe_id)`; the index-built read loop (`household_isolation.sql:264-285`); the KD006 case (`:1160-1163`); the ordering comment (`:986-988`); the summary notices (`:1196`, `:1200`); `testIdBody` and `libraryLineA` in smoke.mjs; `INVITE_ERRORS.KD006`; and the `Library:` line format (`dashboard.astro:52`).
- **Claims verified**:
  - The KD006 case is the only rejection case that could mutate on a regression. With it removed, every remaining case (KD001/2/4/5/9) raises before any write.
  - The deployed app only counts the library, so the old Worker code keeps working across the `db push`.
  - `/dashboard` does not react to the `dk_invite` cookie, so the new smoke step for B before redeeming is safe at the proposed position.
  - The roadmap's F-02 notes and Open Question 2 already carry "Superseded 2026-10-08" markers.
  - No `docs/reference/contract-surfaces.md` or `context/foundation/lessons.md` exists, so those checks were skipped.
  - Progress↔Phase consistency holds: 3/3 phases, and each Success Criteria bullet has a matching `N.M` row.

## Findings

### F1 — Migration guard can fail open on nullable columns and orphan copies

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 §1 Migration, Contract step 2 (guard `do` block, condition b)
- **Detail**: The guard is the only safety on a destructive drop of 34 households' rows. The plan says to "compare every content column via `seed_id`" but does not say how.
  - **Nullable columns.** Many compared columns are nullable: `grams_per_piece`, ingredient `rounding_step_g`, `min_amount_g`, `cooked_yield_ratio`, `duration_minutes`, and step `component_id`. A natural `join … where c.col <> t.col` evaluates `null <> 5` to null, so a copy where a user cleared or set one of those columns does not count as different. Those are exactly the edits clients could make through the existing update policies (`20261007120000_products_and_recipes.sql:173-176`, and similar for the other tables).
  - **Orphan copies.** An inner join to the template also silently skips a copy whose `seed_id` matches no template.
  - **Why it matters.** Research §2 found 0 differences, so today's data is not at risk. But the guard exists to re-prove that at push time, and as specified it can pass while a modified row is destroyed.
- **Fix**: Change Contract step 2(b) to a null-safe set difference per table:
  - The template: `select id, <content cols>, <parent seed ids> from private.seed_<t>`.
  - The copies: `select c.seed_id, <content cols>, <parent copy's seed_id> from public.<t> c left join <parent copies>`.
  - Run `(copies) except (template)` and raise if it returns any row. `EXCEPT` compares with `IS NOT DISTINCT FROM` semantics, and it catches orphan copies too.
  - Also add a manual row to Phase 1. In one `begin; update public.products set grams_per_piece = null where seed_id = '5eed0001-…-000000000001' and household_id = (select id from public.households limit 1); <paste the guard do block>; rollback;` session via `npx supabase db query --linked`, confirm that the guard raises. Pick a product whose `grams_per_piece` is non-null in the template.
- **Decision**: FIXED — Fix applied: Contract step 2(b) now specifies a null-safe per-table `(copies) except (template)` set difference with a left-joined parent seed id; manual row 1.8 added (guard raises on a nulled `grams_per_piece` in a rolled-back session).

### F2 — Seed identity and the future write rule rest on unenforced conventions

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 §3 (seed test scoped by `id::text like '5eed000N-%'`); Phase 1 §2 classification catch-all ("every policy has `cmd = 'SELECT'`"); Phase 3 §1 new "Public library tables" bullet; Assumption 4
- **Detail**: After F-04, "seed row" is defined in two unrelated ways, and nothing ties them together:
  - **Tests** identify seed rows by the `5eed000N-` id prefix (seed test views).
  - **The recorded future write rule** identifies them as `created_by is null` (Phase 3 CLAUDE.md bullet, research §7.3).

  Two concrete failure modes follow once S-07 opens a write path:
  - **(a) Client-chosen ids.** PostgREST lets a client send `id` on insert whenever it holds insert on that column. A user row in the `5eed0001-` namespace would then be judged by `test:seed`, so a user's odd nutrition label fails CI. That is exactly what the prefix scoping was meant to prevent. The same row would also collide with the primary key of a later seed migration that inserts that fixed id, and abort the migration.
  - **(b) The SELECT-only catch-all.** The new classification catch-all asserts that every library policy is SELECT-only, which is correct for F-04. But the CLAUDE.md bullet records an S-07 rule that needs write policies (or a definer RPC). Without a note, the S-07 implementer meets a failing catch-all with no guidance on whether to relax it, and on what to replace it with.
- **Fix**: Add the reservation and the hand-off to the plan's Phase 3 CLAUDE.md "Public library tables" bullet, and as a comment above the catch-all's library section:
  - The `5eed000N-` id namespace is reserved for migrations.
  - No library write path may accept a client-supplied `id`. Use a definer RPC, or a column-level `grant insert (<cols without id>)`.
  - S-07 adds `created_by` together with `check (created_by is null or id::text not like '5eed%')`.
  - S-07 must replace the "SELECT-only" catch-all assertion with one that requires each write policy to reference `created_by` and a definer helper. It must not simply delete the assertion.

  Assessment:
  - Strength: Costs F-04 nothing (no schema change), and it turns two silent traps into explicit hand-offs at the place S-07 will read first (CLAUDE.md hard rules). It matches how this plan already records the deferred authorship rule.
  - Tradeoff: Enforcement still lands only with S-07. Until then it is documentation, but no F-04 path writes, so nothing can violate it yet.
  - Confidence: HIGH — PostgREST's acceptance of client-supplied primary keys and the PK collision on a fixed seed id are standard behaviour; the catch-all conflict follows directly from the plan's own text.
  - Blind spot: S-12/S-13 ("system"/agent rows, also `created_by is null` under the recorded rule) are not modelled here. Whether agent-created rows count as "seed" for immutability is left to S-12.
- **Decision**: FIXED — Fix applied: Phase 3 CLAUDE.md "Public library tables" bullet and a comment above the catch-all's library section now reserve the `5eed000N-` namespace, forbid client-supplied ids, record S-07's `created_by` check, and require S-07 to replace (not delete) the SELECT-only assertion.

### F3 — Isolation-test rewrite leaves three small assertion gaps

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 §2 Isolation test: grants block, the `household_invites` read-loop replacement, and the classification catch-all
- **Detail**:
  - **(a) Grants.** For `anon`, the grants block asserts only that `SELECT` is false. The migration does `revoke all … from anon`, and a partial re-grant of `INSERT` to anon would go unnoticed (RLS would still deny it, but this file asserts both levers everywhere else). `REFERENCES`/`TRIGGER` revokes from `authenticated` are also not asserted.
  - **(b) Read loop.** The replacement keeps two of the three checks of the read loop at `:256-288` (fixture `…a006` visible, `…b006` invisible). It drops the third: `select count(*) … where household_id <> a_household` = 0. That is the only check that would catch a policy leaking *other* households' invites beyond the fixture.
  - **(c) Catch-all scope.** The classification catch-all scans `relkind = 'r'` only. A partitioned table (`'p'`) escapes it. So does a `public` view, which PostgREST exposes and which bypasses RLS unless it sets `security_invoker`. The plan presents the catch-all as making ownership classes exhaustive.
- **Fix**: Make three edits in Phase 1 §2:
  - **Grants block**: loop `p in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')` for `anon` (all false), and `('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')` for `authenticated` (all false).
  - **`household_invites` check**: keep the `household_id <> a_household` count = 0 assertion alongside the two explicit-id checks.
  - **Classification catch-all**: use `c.relkind in ('r','p')`, and add `raise` if any `pg_class` row in `public` with `relkind in ('v','m')` lacks `security_invoker=true` in `reloptions` (materialized views cannot have it, so they fail outright).
- **Decision**: FIXED — Fix applied: grants block loops all seven privileges for anon and six write/ref/trigger privileges for authenticated; the `household_invites` check keeps the `household_id <> a_household` = 0 count; the catch-all scans `relkind in ('r','p')` and raises on `public` views/matviews without `security_invoker=true`.

### F4 — Phase 3 stale-reference check (3.2) will fail on legitimate text

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 Success Criteria, Automated: "No stale references remain … (check with Grep)" / Progress 3.2
- **Detail**: Besides the places the plan lists, the allowlist gets hits in three places today, and the plan neither edits nor exempts them:
  - `context/foundation/roadmap.md:99, :125` (historical "Superseded" and Risk text that names `seed_household()`);
  - this change folder's own `plan.md`, `research.md` and `plan-brief.md`;
  - the gitignored `dist/` build output (`dist/server/chunks/invites_*.mjs` carries KD006 until the next build).

  The criterion has no exact command either, so an implementer cannot tell a real stale reference from expected history. Separately, `20261007120200_household_invites.sql:192` ("reused for the KD004/KD006 checks") is a KD006 mention inside the function body being re-issued. The general "rewrite comments that mention KD006" rule covers it, but it is not among the listed anchors.
- **Fix**: Replace the 3.2 criterion text with an exact command and expected result: `rg -n "seed_household|private\.seed_|KD006" --glob '!context/**' --glob '!dist/**' --glob '!supabase/migrations/20261006*' --glob '!supabase/migrations/20261007*'` must return only the new migration's retirement notes and the `invites.ts` retirement comment. Also add `:192` to the list of comments in Phase 1 §1 step 4 that must be reworded.
- **Decision**: FIXED — Fix applied: 3.2 criterion replaced with the exact `rg` command and expected result; `:192` added to the Phase 1 §1 step 4 comment rewrites.
