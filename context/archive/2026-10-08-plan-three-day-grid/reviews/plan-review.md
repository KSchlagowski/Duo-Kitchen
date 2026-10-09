<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Plan a 3-Day Grid (S-03) Implementation Plan

- **Plan**: context/changes/plan-three-day-grid/plan.md
- **Mode**: Deep
- **Date**: 2026-10-08
- **Verdict**: REVISE
- **Findings**: 0 critical, 5 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

Grounding: 9/9 paths ✓ (`src/middleware.ts`, `src/types.ts`, `src/lib/services/recipes.ts`, `src/lib/services/invites.ts`, `src/lib/services/household.ts`, `src/pages/dashboard.astro`, `src/pages/api/targets.ts`, `scripts/smoke.mjs`, `supabase/tests/household_isolation.sql`; the three new files do not exist yet, as expected), 7/7 symbols ✓ (`PROTECTED_ROUTES`, `getCurrentHousehold`, `RpcResult`, `errorCode`, `private.user_household_ids`, `redeem_household_invite`'s single membership `update`, latest migration `20261008160000`), brief↔plan ✓, Progress↔Phase ✓ (3/3 phases, 26/26 criteria mapped, no checkboxes in phase bodies). No `context/foundation/lessons.md` or `docs/reference/contract-surfaces.md`, so those checks were skipped.

What I verified in the code:
- The claim that a membership composite FK would break redemption holds. `redeem_household_invite()` moves a member with one `update public.household_members set household_id = …` (`20261008150000_shared_recipe_library.sql:260-262`). An `on update cascade` FK would rewrite `plan_meals.household_id`, and the `(plan_id, household_id) → meal_plans` FK would then reject it with 23503.
- KD001–KD009 are taken (`invites.ts:10-20`), so KD010–KD012 are free.
- `/api/*` is unprotected and protection matches by prefix (`middleware.ts:4, 18`), so the plan's own auth check in `api/plan.ts` is required.
- The smoke runner treats a string `location` as a **prefix** match (`smoke.mjs`, the runner loop), which matters for F4.
- The project uses zod `^4.6.5`, where `z.uuid()` is RFC-strict. This also matters for F4.

## Findings

### F1 — `/plan` renders an editable form after a failed read, so saving can overwrite stored data

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 §5 Page (Reads, each in try/catch)
- **Detail**: The plan says only that a `listRecipes` failure hides the form. It does not say what happens when the other two reads fail, and both cases destroy data on the next save:
  - **`getMealPlan` fails.** The page falls back to the A5 default start (tomorrow, or `?start=`) with a blank grid. If the user saves, the RPC diff deletes every meal of the stored plan for that date. The summary line says "Plan is unavailable right now", but the form still invites a save.
  - **`getCurrentHousehold` fails.** `isLinked` becomes false, so no "Partner" `<option>` is rendered. Any stored meal whose eater is the partner maps to `partner` in the plan's mapping (`otherwise partner`). With no matching option, the browser selects the first option ("Both"), so the next save silently changes every partner-only meal to Both. The API would also fail to resolve `partner` because it calls the same read.
- **Fix**: In Phase 2 §5, render the `<form>` only when all three reads succeed. On any failure, show the matching "… unavailable right now." banner and no form. Add a fourth manual check to 2.x: "with a read failing, no form is rendered". In Phase 2 §4, a failed `getCurrentHousehold` must redirect with the generic save error rather than treating the user as unlinked.
- **Decision**: FIXED — Fix in plan (form rendered only when all three reads succeed; API redirects with the generic error on a failed `getCurrentHousehold`; manual check 2.11 added). Already present from the interrupted run, verified, not re-applied.

### F2 — "Latest plan by `start_date`" plus no delete path makes one mistyped date permanent

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Assumptions A4 and A5; Phase 2 §3 `getMealPlan` (no `startDate` → `order start_date desc limit 1`); Phase 2 §7 Dashboard
- **Detail**: `start_date` has no bound in zod or in the RPC, and there is no delete path (A4). Suppose a user saves one plan under a typo such as `2062-10-09`. From then on `/plan` and the dashboard both open that plan by default, forever. Clearing it does not help: an empty plan still exists and is still "latest", so the dashboard shows `Plan: from 2062-10-09 · 0 of 15 meals`. The only way out is `?start=` in the URL. FR-020 ("always save and use a plan") works in principle, but in practice the default view is stuck.
- **Fix A ⭐ Recommended**: Make the default plan the most recently **saved** one: `order("updated_at", { ascending: false })` in `getMealPlan` when there is no `startDate`. Change A5 and the dashboard line to match.
  - Strength: A stray plan stops being the default as soon as the user saves the plan they meant. `save_meal_plan` already bumps `updated_at` on every save (Phase 1, body step 3), so no schema change is needed. The smoke flow still passes, because B's shared-block save is the most recent and A's dashboard reads it. Manual check 2.9 still holds through `?start=`.
  - Tradeoff: The meaning of "latest" changes from "furthest forward" to "last touched". The dashboard can show an older plan if someone just edited it.
  - Confidence: HIGH — this is a one-line query change, and every existing assertion in the plan is order-agnostic or saves in sequence.
  - Blind spot: An index on `(household_id, updated_at)` is not needed at this size, and the plan does not need to add one.
- **Fix B**: Bound `start_date` in the API zod schema (for example today − 30 days … today + 365 days) and raise KD010 for an out-of-range `p_start_date` in the RPC.
  - Strength: Typos never reach the database, and the bound also guards non-UI callers (S-13's agent).
  - Tradeoff: A wrong date inside the window still sticks under "latest by `start_date`". The smoke fixture `planStart = 2031-01-06` falls outside a one-year window and would have to become relative, which brings back the time-zone edge the plan avoided on purpose.
  - Confidence: MEDIUM — it only narrows the problem.
  - Blind spot: The right window for the PRD is not stated anywhere.
- **Decision**: FIXED — Fix A (default plan = most recently saved: `getMealPlan` orders by `updated_at desc`; A5, page and dashboard wording updated).

### F3 — `eater_user_id … on delete cascade` leaves orphan dishes and drops slots from the surviving partner's plan

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1 §1 Contract (`plan_meals.eater_user_id → auth.users on delete cascade`); Assumption A3
- **Detail**: When an account is deleted, the cascade removes only the `plan_meals` rows. Each removed meal's `plan_dishes` row stays behind with zero meals. The RPC's last diff step (Critical Implementation Details) maintains the invariant "every dish has at least one meal", but account deletion bypasses the RPC, so the orphans persist until someone saves that plan again. S-04 is meant to attach solved batch quantities to `plan_dishes` (Key Discoveries), so it would see dishes nobody eats. On top of that, the surviving partner loses those slots from the shared plan without notice. Under A8 ("Both = every current member"), keeping the meal for the people who remain would be more consistent.
- **Fix A ⭐ Recommended**: Use `eater_user_id uuid null references auth.users on delete set null`. A deleted person's meals become "Both", which by A8 means the remaining member. Rewrite A3 to say so. Optionally add one isolation-test assertion: as postgres, delete a fixture user and check that their meal's eater is now null and the dish count is unchanged.
  - Strength: No orphan rows, no silent slot loss, and no trigger. It matches the existing `created_by … on delete set null` precedent on `household_invites`.
  - Tradeoff: The survivor's plan keeps meals that were meant only for the deleted person. They can clear those slots by hand.
  - Confidence: HIGH — a one-keyword change, and the KD012 write-time check is unaffected because null is always valid.
  - Blind spot: Deleting a fixture `auth.users` row inside the rolled-back test has not been tried. The C/D section's users are the safest candidates.
- **Fix B**: Keep `on delete cascade` and state the orphan-dish state in the migration header and CLAUDE.md. S-04 would then have to ignore dishes with no meals, and the RPC's orphan sweep cleans them up on the next save.
  - Strength: No change to A3's product decision.
  - Tradeoff: It pushes an invariant exception onto S-04 and S-09 (shopping lists from dishes) and still drops the survivor's slots.
  - Confidence: MEDIUM — it relies on every later consumer remembering the caveat.
  - Blind spot: S-09's aggregation shape is not designed yet.
- **Decision**: FIXED — Fix A (`eater_user_id … on delete set null`; A3 rewritten; isolation item 8 asserts that a deleted user's meal becomes eater null with the dish count unchanged).

### F4 — The smoke rejection steps use prefix-only `&error=` checks, so the KD011 and partner paths are not proven

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §1 Smoke steps ("A posts an unknown recipe uuid → location prefix `/plan?start=<planStart>&error=`", "A posts `eater=partner` while unlinked → `…&error=`"); Phase 2 §4 step 4
- **Detail**: A string `location` in `smoke.mjs` is a prefix match. As written, both steps would pass for **any** error, including the zod `INVALID_PLAN` message and the generic fallback. That covers the most likely implementation slip: an "unknown" uuid that is not RFC-valid. Zod 4's `z.uuid()` rejects such a value before the RPC is called (for example `…-0000-0000-…`, whose version nibble is 0). So the Desired End State promise "each maps to its own message" would go unproven over HTTP. Phase 2 §4 step 4 also does not say where the partner-while-unlinked redirect goes, or in which order its query parameters appear, yet the smoke step needs `start=` first. The existing smoke file already asserts exact encoded messages for invite errors (`location: \`/join?error=${encodeURIComponent("That invite code has already been used.")}\``).
- **Fix**:
  - In Phase 3 §1, assert exact locations: `` `/plan?start=${planStart}&error=${encodeURIComponent("One of the chosen recipes no longer exists.")}` `` and `` `/plan?start=${planStart}&error=${encodeURIComponent("You can mark meals for your partner once you're linked.")}` ``.
  - Use an RFC-valid unknown uuid (for example `00000000-0000-4000-8000-0000000000ff`).
  - In Phase 2 §4, state that every redirect after `start_date` parses has the form `/plan?start=<date>&error=<msg>` (start first).
- **Decision**: FIXED — Fix in plan (exact encoded smoke locations for KD011 and partner-while-unlinked, an RFC-valid unknown uuid, and a Phase 2 §4 rule that redirects take the form `/plan?start=<date>&error=<msg>`, start first).

### F5 — The deliberate-break check (1.5) cannot work as written and would touch production

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 Success Criteria → Manual Verification (Progress 1.5)
- **Detail**: The step says to "temporarily comment out one revoke … confirm `npm run test:rls` fails … restore it and re-push". `test:rls` runs against the deployed cloud schema. Once the migration has been pushed (criterion 1.2), editing the file changes nothing, because `db push` does not re-apply an applied version. The only way to make the edit count would be to push a weakened schema to the hosted production project. The parenthetical "(or run the check inside a rolled-back `db query` session)" is the right idea, but it does not say how to do it.
- **Fix**: Replace the step with a concrete rolled-back procedure:
  1. Copy `supabase/tests/household_isolation.sql` to the scratchpad.
  2. Insert `grant maintain on public.plan_meals to authenticated;` directly after its first `begin;` line. In a second copy, insert `grant execute on function public.save_meal_plan(date, jsonb) to anon;` instead.
  3. Run each copy with `npx supabase db query --linked -f <copy>`.
  4. Expect the descriptive grant or RPC-grant failure. The file ends in `rollback;`, so nothing is committed, and nothing is ever pushed.
- **Decision**: FIXED — Fix in plan (rolled-back scratchpad-copy procedure with `grant maintain` / `grant execute … to anon`, run via `db query --linked -f`; Progress 1.5 title aligned).

### F6 — Isolation-test fixtures and ordering clash with the plan's own constraints

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §2 Contract items 1, 7 and 8
- **Detail**: Three gaps an implementer would hit while writing the test:
  - **(a) Item 1.** "One plan + one dish + one meal … A gets a second meal". Under `plan_meals_dish_id_key unique (dish_id)` the second meal needs its own second dish, or the fixture insert fails with `unique_violation`.
  - **(b) Item 8.** It asserts that "D sees C's plans" right after the redemption, but C has no plan until the later "C saves a plan with `eater_user_id = D`" step, so the assertion is vacuous or fails.
  - **(c) Item 7.** The RPC-behaviour saves run as A and rewrite A's household rows. If they target the fixture plan's `start_date`, the exact-count read-isolation assertions in item 3 break, depending on order.
- **Fix**: Amend the three items:
  - item 1: "A's plan has two dishes, each with one meal (eater null / eater A)";
  - item 8: insert one C fixture plan as postgres before D redeems, next to D's, and assert D sees exactly that one afterwards;
  - item 7: RPC saves use a `start_date` distinct from every fixture plan, and the block sits after item 3.
- **Decision**: FIXED — Fix in plan (items 1, 7 and 8 amended: two dishes for A, RPC saves on distinct dates after item 3, C fixture plan before redemption).

### F7 — A SQL-null `p_meals` can slip past a naive "not an array" check and wipe the plan

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1 Contract, body step 2 (KD010 list); Phase 1 §2 item 7 (KD010 cases)
- **Detail**: `jsonb_typeof(null)` is null. A check written the natural way, `if jsonb_typeof(p_meals) <> 'array' then raise … 'KD010'`, therefore does not fire for a SQL-null `p_meals`. `jsonb_array_elements(null)` then yields zero rows, and the diff deletes every meal: a valid-looking "clear the plan" through a malformed call. Any future caller, such as S-13's agent, could pass `p_meals: null`. The plan lists "`p_start_date` null" but not `p_meals` null, and the KD010 test cases do not include it either.
- **Fix**: In the body-step-2 KD010 list, add "`p_meals` is null (use `jsonb_typeof(p_meals) is distinct from 'array'`)". Add `save_meal_plan(<date>, null)` → KD010 to the item 7 rejection cases.
- **Decision**: FIXED — Fix in plan (KD010 list covers a null `p_meals` via `is distinct from 'array'`; `save_meal_plan(<date>, null)` added to item 7 cases).
