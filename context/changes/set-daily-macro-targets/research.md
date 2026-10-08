---
date: 2026-10-08T11:31:00+02:00
researcher: Claude (Opus 5.5)
git_commit: b1f95f3fa7078ca861d5d6f12e92d4fac3592c34
branch: main
repository: KSchlagowski/Duo-Kitchen
topic: "S-02 set-daily-macro-targets — how to let each person enter their own daily kcal/protein/fat/carb targets and see their partner's"
tags: [research, codebase, supabase, rls, household, macro-targets, s-02]
status: complete
last_updated: 2026-10-08
last_updated_by: Claude (Opus 5.5)
---

# Research: S-02 — Set daily macro targets

**Date**: 2026-10-08T11:31:00+02:00
**Researcher**: Claude (Opus 5.5)
**Git Commit**: b1f95f3fa7078ca861d5d6f12e92d4fac3592c34
**Branch**: main
**Repository**: KSchlagowski/Duo-Kitchen

## Research Question

Roadmap S-02 (`context/foundation/roadmap.md:130-140`): *"user can manually enter their own daily calorie, protein, fat and carb targets and see their partner's."* PRD refs US-01, FR-004 (`context/foundation/prd.md:84`). Prerequisite F-01 (done). The research asks what the current codebase offers for this, which constraints apply, and which design to recommend. `change.md` carries no extra constraints beyond "pick the best recommended options instead of asking me".

**Session mode**: non-interactive. Where the skill would ask, the recommended option is chosen and stated inline as an **Assumption** or **Decision (recommended)**. No `context/foundation/lessons.md` exists, so there were no lesson priors.

## Summary

Nothing for macro targets exists yet: no table, type, service, route or UI. Every building block S-02 needs is already in place and has a precedent:

- **RLS pattern**: `private.user_household_ids()` plus the four-policy template (`20261007120000_products_and_recipes.sql:166-179`).
- **Isolation test**: its catch-all automatically checks every new `public` table that has a `household_id` column (`household_isolation.sql:484-522`).
- **Form → POST → redirect flow**: zod parsing and the `?error=` convention (`src/pages/api/household/redeem.ts`).
- **Service layer**: `src/lib/services/`.

The one non-obvious design problem is **redemption**. CLAUDE.md requires per-person data to be keyed on `user_id`, scoped by `household_id`, and to "travel with the person through a redemption". But `redeem_household_invite()` only moves the `household_members` row (`20261007120200_household_invites.sql:296-298`). A targets row with a plain `household_id` would be **stranded** in the redeemer's old, now memberless household. The partner could not see it, and the redeemer could not see it either.

**Recommended fix**: a composite foreign key `(household_id, user_id) → public.household_members (household_id, user_id) on update cascade on delete cascade`. When redemption updates the membership row's `household_id`, Postgres moves the targets row along with it in the same statement. This needs no change to the definer function. It also guarantees at the schema level that a targets row can only exist for a member of the household it claims. Future per-person tables (S-06 ratings) can reuse the pattern.

Recommended shape, in brief:

- **Table**: one `public.macro_targets` row per person (PK `user_id`), integer kcal and gram columns, CHECK ranges, `updated_at`.
- **Read access**: a household-wide select policy, so the partner can see the row.
- **Write access**: insert/update/delete policies restricted to `user_id = auth.uid()` *and* the household helper.
- **Write path**: a direct RLS-guarded upsert from a new service (no RPC).
- **UI**: a server-rendered `/targets` page with a plain HTML form (no React island), added to `PROTECTED_ROUTES`, and a summary line plus link on the dashboard.
- **Tests**: extend the isolation test (including a "targets follow the redeemer" assertion) and the smoke test.

## Detailed Findings

### 1. What exists today (baseline)

- **Schema**: four migrations. None of them mention targets ([`supabase/migrations/`](https://github.com/KSchlagowski/Duo-Kitchen/tree/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/supabase/migrations)).
- **Types**: [`src/types.ts`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/src/types.ts) has `HouseholdMember { userId, joinedAt }`, `Household`, `HouseholdInvite`, enums and `RecipeLibrarySummary`. There is no profile, display name or A/B label type.
- **Services**: `household.ts` (`getCurrentHousehold`, which returns members' `user_id`/`joined_at`), `invites.ts` and `recipes.ts`. All are thin and return hand-mapped DTOs. There is no generated `Database` type, so `rpc()`/`from()` results are cast at the service boundary ([`invites.ts:62-67`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/src/lib/services/invites.ts#L62-L67)).
- **Pages**: `dashboard.astro` is the only protected page ([`src/middleware.ts:4`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/src/middleware.ts#L4) `PROTECTED_ROUTES = ["/dashboard"]`, prefix match). It renders household/library/invite lines as `<p data-testid=…>`, which the smoke test parses.
- **No React islands outside auth forms.** S-01 deliberately added none ([`dashboard.astro:91`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/src/pages/dashboard.astro#L91)).

### 2. RLS and data-model constraints (CLAUDE.md + precedent)

- **Household-scoped table rule**: `household_id uuid not null references public.households on delete cascade`, indexed. Per-operation policies `to authenticated` going through `private.user_household_ids()`. No `anon`. Never query `household_members` inside a policy.
- **The isolation catch-all** ([`household_isolation.sql:484-522`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/supabase/tests/household_isolation.sql#L484-L522)) iterates over every `public` table with a `household_id` column. It requires:
  - RLS enabled;
  - a SELECT/INSERT/UPDATE/DELETE policy (or ALL) for `authenticated`;
  - no policy for `anon`/`public`;
  - every policy's `qual || with_check` containing `user_household_ids`.

  A policy of the form `household_id in (select private.user_household_ids()) and user_id = (select auth.uid())` passes, because the substring check is satisfied.
- **Grants precedent for client-writable tables** ([`20261007120000_products_and_recipes.sql:154-164`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/supabase/migrations/20261007120000_products_and_recipes.sql#L154-L164)): `revoke all … from anon` and `revoke truncate, references, trigger … from authenticated`. TRUNCATE bypasses RLS, so it is revoked.
- **Per-person data rule** (CLAUDE.md §Auth flow, recorded by S-01 Decision 11, [`archive/2026-10-07-link-partner-household/plan.md:65`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/context/archive/2026-10-07-link-partner-household/plan.md#L65)): data is keyed on `user_id`, scoped by `household_id`, and travels with the person through redemption. The plan-brief notes this is *"an expectation, not a contract… S-02 owns the table"* (`plan-brief.md:82`).

### 3. The redemption problem, and options

[`redeem_household_invite()`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/supabase/migrations/20261007120200_household_invites.sql#L294-L298) moves a person with one statement:

```sql
update public.household_members
set household_id = v_invite.household_id, joined_at = now()
where user_id = (select auth.uid());
```

Suppose B set targets while still alone. Their row then carries B's old `household_id`, and after redemption:

- `private.user_household_ids()` returns the shared household, so **B can no longer read their own targets**. Neither can A.
- An upsert keyed on `user_id` hits the stale row. The UPDATE policy's `using` fails, so PostgREST either updates 0 rows or the conflict path raises an RLS error. **B is stuck.**
- The KD006 guard ([`:273-282`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/supabase/migrations/20261007120200_household_invites.sql#L261-L282)) does not count this table. It only counts `seed_id is null` rows of the five library tables, so it would not stop the redemption either.

| Option | How | Verdict |
| --- | --- | --- |
| **A. Composite FK with `on update cascade`** | `foreign key (household_id, user_id) references public.household_members (household_id, user_id) on update cascade on delete cascade`. The target is the existing PK `(household_id, user_id)` ([`20261006120000:26-32`](https://github.com/KSchlagowski/Duo-Kitchen/blob/b1f95f3fa7078ca861d5d6f12e92d4fac3592c34/supabase/migrations/20261006120000_household_data_scope.sql#L26-L32)). | **Recommended.** The move is automatic and atomic in the same statement. The definer function is not touched. The schema also enforces "only a member of household H can have a targets row in H", which closes the "insert with a forged household_id" path independently of RLS. Referential-integrity actions bypass RLS and run as the table owner, so the cascade works inside the definer call. The pattern generalizes to S-06 ratings. |
| B. Explicit `update public.macro_targets …` inside `redeem_household_invite()` | `create or replace` the function and add a step 2b. | Works, but it reopens the most delicate function in the repo (lock ordering, snapshot comments). Every future per-person table must also remember to be added, which is the same "literal list nobody tests" hazard the KD006 comment warns about (`:271-272`). |
| C. No `household_id`; policy on `user_id` via a membership lookup | `using (user_id in (select … household_members …))` | **Forbidden.** It breaks the CLAUDE.md household-scoped rule and the catch-all, and queries `household_members` in a policy. |
| D. Copy targets to the new household on redeem / discard on redeem | — | Loses data or duplicates it. Rejected. |

**Decision (recommended)**: Option A. Also keep the plain `household_id … references public.households on delete cascade` FK and the `household_id` index that CLAUDE.md requires. They are redundant with the composite FK, but the rule is literal and the index serves the policy.

**Assumption**: with A, `on delete cascade` from `household_members` removes a person's targets when their account is deleted (`household_members.user_id … on delete cascade` → targets). That is the desired behaviour. The README smoke cleanup (`delete from auth.users where email like 'smoke-%'`) therefore also removes smoke targets, and the README cleanup section needs no change.

### 4. Recommended table shape

```sql
create table public.macro_targets (
  user_id uuid primary key references auth.users on delete cascade,   -- one current row per person
  household_id uuid not null references public.households on delete cascade,
  kcal int not null check (kcal between 1 and 9999),
  protein_g int not null check (protein_g between 0 and 999),
  fat_g int not null check (fat_g between 0 and 999),
  carbs_g int not null check (carbs_g between 0 and 999),
  updated_at timestamptz not null default now(),
  foreign key (household_id, user_id)
    references public.household_members (household_id, user_id)
    on update cascade on delete cascade
);
create index macro_targets_household_id_idx on public.macro_targets (household_id);
```

Decisions (recommended), each with its reason:

- **One row per person, PK `user_id`, no history.** FR-004 asks only for the current target. S-04's determinism NFR (*"same plan and targets always produce the same output"*, `prd.md:135`) is S-04's to honour by snapshotting the targets it solved against. S-02 should not pre-build history. *Open for S-04*, listed below.
- **Integers, all four columns `not null`.** Targets are typed by hand ("2200 kcal, 160 g protein"). Sub-gram precision is meaningless for a ±10% tolerance. The solver needs all four, so a partial row has no use: "not set" is the absence of a row. Carbs and fat may be `0` (keto and similar) and kcal may not. The upper bounds are sanity guards, not dietary policy (PRD §Non-Goals: no calculators). They match the zod schema exactly so the form and the database agree.
- **`updated_at` is set explicitly by the upsert** (`updated_at: new Date().toISOString()`), not by a trigger. That avoids introducing the repo's first non-auth trigger for one column. **Alternative**: a `moddatetime`-style trigger; rejected as unnecessary.
- **No `id` column.** The isolation test's id-indexed fixture loop (`household_isolation.sql:251-281`) cannot include this table, so it gets its own block (§7). That is cheaper than adding a surrogate key only to fit the test template.

### 5. RLS policies and grants

- `alter table … enable row level security`; `revoke all … from anon`; `revoke truncate, references, trigger … from authenticated`, per the products precedent.
- **select**: `using (household_id in (select private.user_household_ids()))`. The partner sees the row (PRD §Access Control: *"each person keeps their own macro targets … (visible to the partner)"*, `prd.md:150`).
- **insert**: `with check (household_id in (select private.user_household_ids()) and user_id = (select auth.uid()))`.
- **update**: the same predicate in both `using` and `with check`.
- **delete**: `using (… and user_id = (select auth.uid()))`. The catch-all needs a DELETE policy. A self-delete (clearing one's targets) is harmless, so the grant is kept rather than revoked. The UI does not expose it in this slice.

**Decision (recommended)**: a partner **cannot edit** the other person's targets. FR-004 says *"Person can manually enter **their** daily targets"*. The flat role model (`prd.md:151`) means neither person administers the other. It does not mean shared ownership of per-person data. **Alternative considered**: household-wide write (simpler policies, lets one partner type both sets of numbers); rejected because it contradicts "their own" in the roadmap outcome.

**Write path**: a direct PostgREST upsert, not an RPC. Unlike `households`/`household_members`/`household_invites`, nothing here needs server-controlled invariants beyond what RLS, CHECK constraints and the composite FK already enforce. Products, which are also client-writable, set the precedent. An RPC would add a definer function, a grant assertion and KD codes for no gain. `insert … on conflict (user_id) do update` needs the select, insert and update policies, and all three exist.

### 6. App layer (service, route, page)

- **Service** `src/lib/services/macro-targets.ts`. CLAUDE.md says pages and API routes never call `supabase.from` directly.
  - `getHouseholdMacroTargets(supabase): Promise<MacroTargets[]>`: `select user_id, kcal, protein_g, fat_g, carbs_g, updated_at`. RLS scopes it to the household, so there is no filter, matching `household.ts:4`.
  - `saveMyMacroTargets(supabase, userId, input)` resolves the caller's `household_id`. It reads it from `household_members` with `.eq("user_id", userId).single()`; the select policy allows reading one's own row. It then upserts with `onConflict: "user_id"`. Redemption cannot race between the two calls into a wrong state: the composite FK rejects a stale household id with `23503`, which surfaces as the generic error.
  - **Alternative**: resolve via `getCurrentHousehold()`. That also works but over-fetches members.
- **Types** (`src/types.ts`): `MacroTargets { userId; kcal; proteinG; fatG; carbsG; updatedAt }` and an input DTO without `userId`/`updatedAt`.
- **API route** `src/pages/api/targets.ts` (`POST`), cloned from `redeem.ts`:
  - **Auth guard**: `/api/*` is not protected, so return `redirect("/auth/signin")` when `!locals.user`.
  - **Body parsing**: wrap `request.formData()` in try/catch (`redeem.ts:22-30`).
  - **Validation**: `z.object({ kcal: z.coerce.number().int().min(1).max(9999), protein_g: …min(0).max(999), … })` with `safeParse`. Empty strings must fail: use `z.coerce` on a trimmed non-empty string, or use `z.string().regex(/^\d+$/)` then transform, so that `Number("") === 0` cannot slip through as a valid fat or carb value of `0`. This is a **pitfall worth a test**.
  - **Outcome**: on failure, `redirect("/targets?error=…")`; on success, `redirect("/targets?saved=1")`. That matches the S-01 `?joined=1` and `?error=` conventions (*"there is no JSON-response convention here"*, `redeem.ts:7-9`).
- **Page** `src/pages/targets.astro`. Add `"/targets"` to `PROTECTED_ROUTES`.
  - **"Your targets"**: a form with four `<input type="number" min max step="1" required>` fields, pre-filled from your row.
  - **"Partner's targets"**: read-only. Shows "Not set yet" when the partner has no row, and "Not linked yet" when the household has one member. `getCurrentHousehold()` supplies the member list and `Astro.locals.user.id` tells *you* from the *partner*.
  - The four values are `<p data-testid="targets-mine">` and `<p data-testid="targets-partner">` lines for the smoke test.
  - **Decision (recommended)**: `.astro` only, no React island. There is no client state the form needs (CLAUDE.md §Astro vs React). Tailwind classes go through `cn()` where they are conditional.
- **Dashboard**: one `data-testid="targets"` line ("Targets: 2200 kcal · P 160 g · F 70 g · C 230 g" or "Targets: not set") plus a link to `/targets`. The README auth-routes table gets a `/targets` row.
- **Consistency hint (decision, recommended, non-blocking)**: when `|4·P + 4·C + 9·F − kcal| / kcal > 10%`, show a soft note under the form: *"Your macros add up to N kcal, which differs from your calorie target by more than 10%. The solver may not be able to hit all four."*
  - It is computed in the page, never enforced in zod or SQL, because the PRD says the app never blocks the user.
  - It is not a BMR/TDEE calculator; it only checks the user's own numbers against each other.
  - It matters because S-04 must land **each** of the four daily totals within ±10%. Inconsistent targets make that impossible, and the user would otherwise only find out at solve time.
  - The 4/4/9 factors are an approximation. That is acceptable for a hint.

### 7. Tests

- **`supabase/tests/household_isolation.sql`** (mandatory per CLAUDE.md):
  1. Setup (as postgres, before the A/B read blocks): insert one targets row each for A and B in their own households.
  2. As A: sees exactly its own row and 0 of B's. Cannot insert or update a row in B's household (`insufficient_privilege` / 0 rows). Cannot insert a row with `user_id` = B even with A's `household_id`; the composite FK or the RLS `with check` rejects it.
  3. Add `'macro_targets'` to the anon read loop (`:464-465`). Do **not** add it to the id-indexed loops (`:257`, `:291`), which need an `id` column.
  4. **Redemption carries targets** (the key new assertion), in the S-01 section:
     - Before D redeems C's code, insert D's targets in `d_household`.
     - After redemption, assert D's row has `household_id = c_household`, and that `d_household` holds 0 targets rows.
     - As C: C sees D's row (partner visibility) but cannot update or delete it (0 rows).
     - As D: D can still update its own row.
  5. The catch-all needs no change; it picks the table up automatically and is the guard that all four policies exist.
  6. Update the final notice strings.
- **No new RPC**, so no new anon-grant assertion is needed. The CLAUDE.md note that every new function needs its own grant assertion does not apply.
- **`scripts/smoke.mjs`**:
  - A posts targets → `302 /targets?saved=1`.
  - `/targets` shows A's values in `targets-mine`, and in `targets-partner` shows "Not linked yet".
  - Later, after B joins, B's `/targets` shows A's values in `targets-partner`.
  - An invalid post (empty kcal) → `302 /targets?error=…`.
  - `/targets` anonymous → `302 /auth/signin`.
  - Add `"targets"` / `"targets-mine"` / `"targets-partner"` to the debug id list (`smoke.mjs:245`).
- **`npm run test:seed`**: unaffected.
- **Migration**: `supabase/migrations/20261008120000_macro_targets.sql`. Workflow per CLAUDE.md: `npx supabase db push`, then `npm run test:rls` before merging, because CI tests the deployed schema.

### 8. Scope edges

- **Display names / A/B labels.** The F-01 plan deferred *"display names, A/B labels, macro targets"* to S-02 (`archive/2026-10-06-household-data-scope/plan.md:34`). The S-02 roadmap outcome mentions only targets. **Decision (recommended)**: no display names or A/B labels in S-02. The UI says "You" / "Your partner". Partner email is not readable by clients (`auth.users` is not exposed). **Hand-off to S-03**: store "who eats this meal" as `user_id`s (or `both`), not as letters. "A/B" is then only a presentation concern; derive it from `household_members.joined_at` order (the inviter joined first; redeem sets `joined_at = now()`), or add a display-name column when the UI needs one.
- **No onboarding prompt** to set targets (PRD §Deferred: onboarding guide).
- **No i18n**: strings are English, like the rest of the app, until S-14.

## Code References

- `supabase/migrations/20261006120000_household_data_scope.sql:26-32`: `household_members` PK `(household_id, user_id)`, `user_id unique`, cascades. This is the composite-FK target.
- `supabase/migrations/20261006120000_household_data_scope.sql:41-54`: `private.user_household_ids()`.
- `supabase/migrations/20261007120000_products_and_recipes.sql:148-179`: RLS enable, revokes, the four-policy template.
- `supabase/migrations/20261007120200_household_invites.sql:294-298`: the membership move that would strand a plain household-scoped targets row.
- `supabase/migrations/20261007120200_household_invites.sql:261-282`: the KD006 non-seed count. It does not need `macro_targets`, because targets travel and are not left behind.
- `supabase/tests/household_isolation.sql:251-281, 459-475, 484-522, 598-808`: the id-indexed loops, the anon loop, the catch-all, and the redemption section to extend.
- `src/lib/services/household.ts:5-26`: the household + members read used to tell you from the partner.
- `src/lib/services/invites.ts:24-37, 62-67`: the error-code narrowing and service-boundary cast idioms.
- `src/pages/api/household/redeem.ts:7-53`: the zod + formData + `?error=` redirect template.
- `src/pages/dashboard.astro:39-103`: the data-testid line pattern and the plain form POST.
- `src/middleware.ts:4`: `PROTECTED_ROUTES`.
- `scripts/smoke.mjs:41-61, 66-69, 245`: request helper, `testIdText`, debug id list.

## Architecture Insights

- **Composite FKs carry the data model's invariants.** F-02 used `(x_id, household_id)` FKs so that child rows can never cross households. S-02 extends the idea to people: `(household_id, user_id) → household_members` both proves membership and makes per-person rows follow a membership move. **Recommendation for the plan**: record this in CLAUDE.md §Auth flow next to the per-person rule: *"per-person tables carry a composite FK `(household_id, user_id) → public.household_members on update cascade on delete cascade`, which is what makes them travel through `redeem_household_invite()`"*. Then S-06 ratings inherit it instead of rediscovering the stranding bug.
- **Three write models now coexist, and S-02 picks the lightest that is still safe**:
  - definer-RPC-only, for membership and invites;
  - direct RLS writes, for library data;
  - direct RLS writes plus an owner predicate, which is new: per-person data.
- **Policies use `(select auth.uid())`**, the init-plan form, as the existing definer functions do (`:117`, `:298`).

## Historical Context (from prior changes)

- `context/archive/2026-10-07-link-partner-household/research.md:258, 359`: identified the S-02 coupling. *"If targets are keyed on `user_id`, they travel with the user through redemption. If they are household-scoped, redemption would strand them."* Caveat: keying on `user_id` alone does **not** make them travel when `household_id` is also stored for RLS. Something must update it, which is what this research's Option A supplies.
- `context/archive/2026-10-07-link-partner-household/plan.md:65` (Decision 11) and `plan-brief.md:82`: the expectation recorded, explicitly left to S-02 to implement.
- `context/archive/2026-10-07-link-partner-household/plan.md:103`: S-01 excluded targets, plans, ratings and the solver.
- `context/archive/2026-10-06-household-data-scope/plan.md:34`: F-01 deferred "display names, A/B labels, macro targets" to S-02. Labels are scoped out here (§8).
- `context/archive/2026-10-07-seed-products-and-recipes/`: origin of the composite-FK and revoke-truncate precedents.

## Related Research

- `context/archive/2026-10-07-link-partner-household/research.md`
- `context/archive/2026-10-07-seed-products-and-recipes/research.md`

## Open Questions

None block planning. All are recorded with a recommended default:

1. **Target history for determinism (S-04).** S-02 keeps only the current row. S-04 should snapshot the targets used for a solve alongside the solution. *Owner: S-04.*
2. **A/B labels and display names.** Deferred (§8). S-03 should key meal eaters on `user_id`. *Owner: S-03.*
3. **Consistency hint threshold.** 10% on 4/4/9 is a heuristic. The plan may drop the hint if time is short; it is non-blocking either way.
4. **Hosted-project verification of the cascade.** Postgres semantics say the referential-integrity `on update cascade` runs as the table owner and bypasses RLS, so it fires inside `redeem_household_invite()`. The isolation-test assertion in §7.4 is what proves it on the hosted project, so that assertion must not be cut.
