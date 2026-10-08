---
date: 2026-10-08T15:54:22+02:00
researcher: Claude (Opus 5.5) for Kamil Schlagowski
git_commit: e3ce0b547e5dc2b6cc753015364e9d207348c9fa
branch: feat/plan-three-day-grid
repository: KSchlagowski/Duo-Kitchen
topic: "S-03 plan-three-day-grid: household 3-day × 5-meal plan with A/B/both marking and a minimal recipe picker, saved unsolved"
tags: [research, codebase, meal-plan, rls, household-scope, supabase, recipes, smoke, s-03, s-08]
status: complete
last_updated: 2026-10-08
last_updated_by: Claude (Opus 5.5)
---

# Research: S-03 plan-three-day-grid

**Date**: 2026-10-08T15:54:22+02:00
**Researcher**: Claude (Opus 5.5) for Kamil Schlagowski
**Git Commit**: `e3ce0b5` (on `origin/main`; the branch has no commits of its own yet)
**Branch**: `feat/plan-three-day-grid`
**Repository**: KSchlagowski/Duo-Kitchen

Permalink base for the references below: `https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/`

## Research Question

How should S-03 (roadmap: *"user can fill 3 consecutive days with up to 5 meals each, place any recipe in any slot, mark each meal or day for A, B or both, leave slots empty, and save and use the plan without solving"*, PRD US-01, FR-013–FR-016, FR-020) be built on the current codebase? It must follow the CLAUDE.md hard rules for household-scoped tables. It must leave room for S-08 (one dish across several days) without rework. It has to coexist with S-05 (browse-recipe-library), which is being built at the same time in another worktree.

Constraints from `change.md` (binding):
- S-03 owns `listRecipes()` in `src/lib/services/recipes.ts` (id, name, cuisine, prep_minutes, meal_types) and its type in `src/types.ts`, kept small.
- No changes to the five library tables or to `supabase/tests/seed_integrity.sql`. No recipe browse or detail UI.
- Plan tables are household-scoped and extend `supabase/tests/household_isolation.sql`.
- Shared files (middleware, dashboard, smoke, README route table, CLAUDE.md, roadmap) get S-03 lines in separate blocks only.
- The migration timestamp must be later than every migration already applied to the cloud project. Run `npm run test:rls` after the push.

Session mode: non-interactive. Wherever a choice was needed, the recommended option was picked and recorded as an **Assumption**.

## Summary

- **Nothing plan-related exists yet.** No table, service, type, route or test mentions plans. The building blocks S-03 needs are all present: the `public.meal_type` enum, the public `recipes` table with `meal_types meal_type[]` (≤ 2), the household helper `private.user_household_ids()`, the definer-RPC + KD-SQLSTATE pattern from S-01, and the two catch-alls in the isolation test.
- **Recommended shape (S-08-ready): three household-scoped tables.**
  - `meal_plans`: one row per 3-day cycle. `start_date` is unique per household.
  - `plan_dishes`: one cooked batch of one recipe. `recipe_id → public.recipes on delete restrict`.
  - `plan_meals`: one filled slot. Columns: `day_index 0–2`, `meal_type`, `dish_id`, `eater_user_id` (null = both).
  - S-03 enforces one meal per dish with `unique (dish_id)` on `plan_meals`. **S-08 only drops that constraint.** S-04 can attach solved batch quantities to dishes from day one, so neither S-04's output tables nor S-03's data need migrating when S-08 lands.
- **Write path: one security-definer RPC, `public.save_meal_plan(p_start_date date, p_meals jsonb)`, with client writes revoked.** This follows the `household_invites` precedent: four policies plus revokes, both kept on purpose. Reasons:
  - Saving the grid touches three tables, and PostgREST can do that atomically only through an RPC.
  - The rule "the eater is a member of this household" needs `household_members`, which no policy may query directly.
  - Slot invariants are easiest to enforce in one place.
- **Eaters are stored as `user_id`, not as letters.** This was handed off from S-02 research §8. `eater_user_id` is null for "both". It gets a plain FK to `auth.users`. **It must not** get the composite `(household_id, user_id) → household_members … on update cascade` FK that per-person tables use: plans are household-owned and stay in the origin household. With that FK, a redemption would either drag meal rows out from under their plan, or fail with 23503 and block the redemption.
- **Redemption: plans stay behind** in the redeemer's preserved, memberless origin household, like all household data. No new KD code is needed, and KD006 stays retired.
- **UI: Astro only, no island.** The protected `/plan` page is one form with 15 native `<select>` pickers. Recipes whose `meal_types` match the slot are listed first, as a hint (FR-016). Each slot has an eater choice (Both / Me / Partner), each day has a "whole day for" shortcut, and there is a start-date input. `POST /api/plan` validates with zod and calls the RPC through `src/lib/services/meal-plans.ts`.
- **Migration timestamp:** the cloud project's latest applied migration is `20261008160000` (checked 2026-10-08 with `npx supabase migration list --linked`; local and remote match, 7 of 7). Use `20261008170000_meal_plans.sql` or later, and re-check right before `db push` in case S-05 pushes first.

## Detailed Findings

### 1. What exists today (baseline)

- **Library, read-only and public** ([`20261008150000_shared_recipe_library.sql:312-320`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261008150000_shared_recipe_library.sql#L312-L320)):
  - `public.recipes(id, name, cuisine, prep_minutes > 0, meal_types public.meal_type[] default '{}' check cardinality ≤ 2, division_mode, created_at)`.
  - There is one `select … to authenticated using (true)` policy and every write is revoked (`:427-431`). MAINTAIN is revoked in `20261008160000_library_revoke_maintain.sql`.
- **Enum** `public.meal_type` = `breakfast, second_breakfast, lunch, afternoon_snack, dinner` ([`20261007120000_products_and_recipes.sql:19-21`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261007120000_products_and_recipes.sql#L19-L21)). This is exactly FR-013's five meals in grid order. The TS mirror is `MealType` in [`src/types.ts:23`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/types.ts#L23).
- **Seed recipes** (8, stable ids `5eed0002-0000-4000-8000-00000000000{1..8}`, [`20261007120100_seed_products_and_recipes.sql:89-106`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261007120100_seed_products_and_recipes.sql#L89-L106)). They cover every hint shape: one meal type, two meal types, and none (`Zapiekanka makaronowa` has `'{}'`). So the picker must handle a recipe that suggests no meal type: it goes under "other", never hidden (FR-016: "any recipe in any slot").
- **Recipe service** has only `getRecipeLibrarySummary()` (head-only counts) ([`src/lib/services/recipes.ts:6-23`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/lib/services/recipes.ts#L6-L23)). F-02 deliberately deferred entity interfaces "to the first reading slice (S-03/S-05) … alongside its queries" (`context/archive/2026-10-07-seed-products-and-recipes/plan.md:397`).
- **Household helper** `private.user_household_ids()` is a definer function, stable, and returns `setof uuid` ([`20261006120000_household_data_scope.sql:41-54`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261006120000_household_data_scope.sql#L41-L54)). Membership: `household_members` PK `(household_id, user_id)`, `user_id unique` (`:26-32`).
- **Routes and protection**: `PROTECTED_ROUTES = ["/dashboard", "/targets"]` on one line ([`src/middleware.ts:4`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/middleware.ts#L4)), matched by prefix (`:18`). `/api/*` is **not** protected, so every API route checks `context.locals.user` itself ([`src/pages/api/targets.ts:29-32`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/pages/api/targets.ts#L29-L32)).
- **No plan artefacts anywhere**: no `plan` table, type, service, page or smoke step. `src/components/hooks/` does not exist, and `src/components/ui/` holds only `button.tsx` and `LibBadge.astro`.

### 2. Data model options for S-08 readiness

FR-017 / S-08: *"make one cooked dish cover meals on several days, and solving still lands each person's daily totals within tolerance."* S-04 solves per day and outputs quantities to cook per ingredient, component or whole dish, plus the A/B split. The real question is where the **batch** lives.

| Option | Shape | S-08 cost | Verdict |
| --- | --- | --- | --- |
| A. Meal holds recipe | `plan_meals(day, meal_type, recipe_id, eater)` | S-08 has to add a batch entity and move recipe identity and S-04's per-meal solve output onto it. That reworks S-04's tables. | Rejected: this is exactly the rework the roadmap warns against (`roadmap.md:165`). |
| B. Meal + nullable `batch_id` | A, plus `batch_id` added later | Additive column, but S-04 would have solved per meal and S-08 re-targets the solver output to batches. | Rejected for the same reason, only less visibly. |
| **C. Dish + meal (recommended)** | `plan_dishes(recipe_id)` ← `plan_meals(day, meal_type, dish_id, eater)`, with `unique (dish_id)` in S-03 | S-08 runs `alter table plan_meals drop constraint plan_meals_dish_id_key` and widens the RPC payload so meals can name a shared dish. No data migration. | **Chosen.** S-04 attaches solved batch quantities to `plan_dishes` and the A/B split to `plan_meals`. Both already exist. |

**Assumption A1**: a dish covers meals of *one* plan only. A dish spanning two 3-day plans is out of FR-017's scope. `plan_dishes` therefore carries `plan_id`, and meals reference `(dish_id, plan_id)`.

### 3. Recommended schema (sketch for `/10x-plan`)

```sql
create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  start_date date not null,                      -- day_index 0 = start_date (FR-013 "3 consecutive days")
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, start_date),
  unique (id, household_id)                      -- composite FK target
);
-- household_id is already indexed by unique (household_id, start_date); an explicit
-- meal_plans_household_id_idx is optional (add it if the plan prefers the hard rule literally).

create table public.plan_dishes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  plan_id uuid not null,
  recipe_id uuid not null references public.recipes on delete restrict,   -- F-04 guidance (archive plan.md:354)
  created_at timestamptz not null default now(),
  foreign key (plan_id, household_id) references public.meal_plans (id, household_id) on delete cascade,
  unique (id, plan_id)                           -- composite FK target for plan_meals
);

create table public.plan_meals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  plan_id uuid not null,
  day_index smallint not null check (day_index between 0 and 2),
  meal_type public.meal_type not null,
  dish_id uuid not null,
  eater_user_id uuid references auth.users on delete cascade,   -- null = both / whole household
  created_at timestamptz not null default now(),
  foreign key (plan_id, household_id) references public.meal_plans (id, household_id) on delete cascade,
  foreign key (dish_id, plan_id) references public.plan_dishes (id, plan_id) on delete cascade,
  unique (plan_id, day_index, meal_type),        -- one meal per slot
  unique (dish_id)                               -- S-03 only: one meal per dish. S-08 drops this.
);
-- + household_id indexes on each table, and indexes for FK columns not covered by a leading unique
--   (plan_dishes.recipe_id, plan_dishes(plan_id, household_id), plan_meals(dish_id, plan_id)
--   is covered by unique(dish_id); plan_meals.eater_user_id).
```

Notes:
- **`household_id` on every table**, kept consistent by composite FKs. This is the F-02 precedent ([`20261007120000_products_and_recipes.sql:3-6`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261007120000_products_and_recipes.sql#L3-L6)), and the hard rule requires the literal column, the FK and an index. No `on update cascade` is needed: plans never change household, because no path moves household data.
- **Empty slots are absent rows** (FR-015). A plan with zero meals is valid and stays saved (FR-020).
- **Whole-day marking (FR-014) is not stored.** It is a save-time shortcut that sets every filled meal of that day to one eater value. **Assumption A2**: the PRD's "mark … a whole day" is satisfied by that shortcut. A stored per-day default would add a second source of truth for the solver to reconcile.
- **Eaters**: `eater_user_id` is null for both, or one member's `user_id`. "A"/"B" is presentation only (S-02 research §8, `context/archive/2026-10-08-set-daily-macro-targets/research.md:187`). The UI says Both / Me / Partner, like `/targets`. S-04 maps null → every current member's targets, and a uuid → that person's targets. A side effect: a plan made while alone with "Both" automatically covers the partner once they link.
  - **Do not add the per-person composite membership FK here.** `macro_targets` uses `(household_id, user_id) → household_members on update cascade` ([`20261008120000_macro_targets.sql:31-33`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261008120000_macro_targets.sql#L31-L33)) so that rows *travel* with the person. A plan meal must *not* travel. With that FK, `redeem_household_invite()`'s single membership `update` would cascade into `plan_meals.household_id`. That would then violate `(plan_id, household_id) → meal_plans` and fail the redemption with 23503 whenever the redeemer has a "me only" meal. The isolation test should prove that redemption succeeds with such a meal present (§6).
  - Membership of the eater is validated at write time by the RPC. The only way a stored eater can become a non-member is account deletion, and the `on delete cascade` from `auth.users` removes that person's single-eater meals. **Assumption A3**: deleting a partner's account drops meals marked only for them, which is acceptable because there is no leave path.
- **No `created_by` / "system" attribution** (S-13 decides; PRD Access Control). YAGNI now.

### 4. RLS, grants and the write path

**Policies**: four per table, `to authenticated`, `using`/`with check (household_id in (select private.user_household_ids()))`, no anon policies. This is the exact `household_invites` shape ([`20261007120200_household_invites.sql:66-81`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261007120200_household_invites.sql#L66-L81)). The household_id catch-all ([`household_isolation.sql:626-664`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/tests/household_isolation.sql#L626-L664)) will pick the three new tables up automatically. It requires all four commands, and every policy's qual/with_check must mention `user_household_ids`.

**Grants (recommended: write-revoked, RPC-only writes)**:
```sql
revoke all on public.<t> from anon;
revoke insert, update, delete, truncate, references, trigger, maintain on public.<t> from authenticated;
```
- `maintain` is included on purpose. `macro_targets` and `household_invites` revoke only `truncate, references, trigger`. F-04's follow-up found that PG17 default privileges also grant MAINTAIN ([`20261008160000_library_revoke_maintain.sql:3-9`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261008160000_library_revoke_maintain.sql#L3-L9)). The existing gap on `macro_targets`/`household_invites` is out of S-03's scope (see Open Questions).
- Write-revoking makes the plan tables the fourth instance of CLAUDE.md's **Write-revoked tables** rule: policies and grants are independent levers, and both are load-bearing. CLAUDE.md should get an S-03 line for that, in its own block.

**Why an RPC rather than direct PostgREST writes** (compared with S-02, which chose a direct upsert, `context/archive/2026-10-08-set-daily-macro-targets/research.md:135`):
1. **Atomicity.** One save touches `meal_plans` (upsert), `plan_dishes` and `plan_meals`. PostgREST runs one statement per request, so a failure between calls would leave a half-saved grid, or an empty one under delete-then-insert. FR-020 promises a usable plan at every step.
2. **Eater validation.** "eater ∈ current household members" needs `household_members`. A policy may not query it (hard rule), and adding a new private helper just for a policy is heavier than a check inside an RPC that already runs as definer.
3. **One place for invariants**: dish/meal 1:1 in S-03, slot uniqueness, payload shape, and later S-08's shared-dish rules and S-13's agent writes.

**RPC contract (recommended)**: `public.save_meal_plan(p_start_date date, p_meals jsonb) returns uuid` (the plan id).
- `security definer`, `set search_path = ''`, every name qualified, then `revoke execute … from public, anon; grant execute … to authenticated;` (hard rule; precedent at [`20261008150000_shared_recipe_library.sql:275-276`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261008150000_shared_recipe_library.sql#L275-L276)).
- `p_meals` is a JSON array of `{ "day_index": 0..2, "meal_type": "<enum>", "recipe_id": "<uuid>", "eater_user_id": "<uuid>" | null }`, with at most 15 entries.
- Body:
  1. Resolve the household once from `private.user_household_ids()` (KD007 if none). This mirrors `redeem_household_invite`'s "resolve once before any write" rule ([`…shared_recipe_library.sql:179-187`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261008150000_shared_recipe_library.sql#L179-L187)).
  2. Upsert `meal_plans (household_id, start_date)` and lock it `for update`, so two partners saving at once serialise. Last writer wins.
  3. Validate the payload. Raise the KD codes below **before any write** to child rows.
  4. **Slot-level diff** (recommended over delete-all-reinsert):
     - delete meals whose slot is absent or whose recipe changed;
     - update `eater_user_id` where only the eater changed;
     - insert new dish + meal pairs;
     - delete dishes left with no meal (`not exists` — this already works for S-08's shared dishes).
     Unchanged slots keep their ids, so S-04 solve results on untouched days survive an edit elsewhere in the plan.
  5. Set `updated_at = now()`.
- **New SQLSTATEs (class KD, next free numbers)**: KD007 is **reused** for "no authenticated caller / no household" because the meaning is identical, and the UI maps it once.

  | Code | Meaning |
  | --- | --- |
  | KD010 | Malformed meals payload: not an array, more than 15 entries, missing key, `day_index` outside 0–2, unknown `meal_type`, non-uuid id, or duplicate `(day_index, meal_type)`. Cast failures (22P02) are caught and re-raised as KD010 so they never surface bare. |
  | KD011 | `recipe_id` not in the library. |
  | KD012 | `eater_user_id` is not a member of the caller's household. |

  KD006 stays retired ([CLAUDE.md](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/CLAUDE.md), `src/lib/services/invites.ts:16`). S-05 is read-only, so a KD collision with the parallel slice is unlikely. The plan should still claim KD010–KD012 explicitly in the migration header, as S-01 did ([`20261007120200_household_invites.sql:88-96`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261007120200_household_invites.sql#L88-L96)).
- **Assumption A4**: there is no `delete_meal_plan` RPC in S-03. Clearing every slot and saving gives an empty plan, which is enough for FR-015/FR-020.

### 5. App layer

**`listRecipes()`**, owned by S-03 and kept small for S-05 to extend:
```ts
// src/types.ts — own block, e.g. "// Recipe picker (S-03)"
export interface RecipeListItem { id: string; name: string; cuisine: string; prepMinutes: number; mealTypes: MealType[]; }
// src/lib/services/recipes.ts
export async function listRecipes(supabase: SupabaseClient): Promise<RecipeListItem[]>
//   .from("recipes").select("id, name, cuisine, prep_minutes, meal_types").order("name")
```
- Map snake_case to camelCase at the service boundary and cast the row type, as `macro-targets.ts:8-34` does (there is no generated `Database` type, `invites.ts:62-67`).
- Order by `name` only, with no filters. Filtering and sorting are S-06's job, and the meal-type hint is applied in the page.

**Plan service** `src/lib/services/meal-plans.ts`, the single home for plan reads, the RPC call and the KD010–KD012 → message map, mirroring `invites.ts:8-37`:
- `getMealPlan(supabase, startDate?)`: reads with the embedded children, `meal_plans.select("id, start_date, updated_at, plan_meals(day_index, meal_type, eater_user_id, plan_dishes(recipe_id))")`. Without `startDate` it returns the latest plan by `start_date desc`, limit 1. RLS scopes it to the household, so there is no household filter (`household.ts:4` idiom).
- `saveMealPlan(supabase, startDate, meals)` calls `rpc("save_meal_plan", …)` and casts with `RpcResult`.
- `mealPlanErrorMessage(error)`.
- Types in `src/types.ts`, in their own S-03 block: `PlanEater = "both" | "me" | "partner"` (form-level), `PlanMeal { dayIndex, mealType, recipeId, eaterUserId: string | null }`, `MealPlan { id, startDate, updatedAt, meals: PlanMeal[] }`.

**Page `src/pages/plan.astro`** (protected), Astro only: no state or effects are needed, per the convention in CLAUDE.md §Key conventions.
- One `<form method="POST" action="/api/plan">`:
  - a `start_date` `<input type="date">`. **Assumption A5**: it defaults to the latest plan's date, or tomorrow when there is none. Changing it and saving creates or opens the plan for that date (`unique (household_id, start_date)`).
  - 3 day columns × 5 meal rows. Each slot has a `<select name="d{day}_{meal_type}_recipe">` with an empty "— empty —" option, an `<optgroup label="Suggested">` holding recipes whose `mealTypes` include the slot's meal type, then `<optgroup label="Other recipes">` holding the rest (FR-016: hint, never a restriction).
  - each slot also has `<select name="d{day}_{meal_type}_eater">` with Both / Me / Partner. "Partner" is disabled (or omitted) when the household has one member.
  - each day has a `day{n}_eater` select (`—` / Both / Me / Partner) that overrides that day's meals on save (A2).
- Shows "Saved." / error banners via `?saved=1` / `?error=`, the `/targets` pattern (`src/pages/targets.astro:49-74`).
- "Use the plan without solving" (FR-020) in S-03 means: the saved grid is shown read-back on `/plan`, with recipe names resolved from the `listRecipes()` result already loaded for the pickers, and summarised on the dashboard. S-04, S-09 and S-10 consume it later.

**API `src/pages/api/plan.ts`**, modelled on `src/pages/api/targets.ts`:
- Check `context.locals.user`, because `/api` is unprotected.
- Wrap `formData()` in a try/catch.
- zod: `start_date` is `^\d{4}-\d{2}-\d{2}$` and a valid date. Each recipe field is `""` or a uuid. Each eater is `both|me|partner`. Use an explicit enum so a blank value is never coerced, which is the lesson from S-02 (`targets.ts:6-8`).
- Resolve me → `user.id` and partner → the other member's id from `getCurrentHousehold()`. Partner is invalid while unlinked: redirect with an error.
- Build `p_meals` and call `saveMealPlan`.
- Redirect to `/plan?start=…&saved=1`, or `/plan?error=…` with the mapped message.

**Dashboard** (`src/pages/dashboard.astro`): add a separate S-03 block: one try/catch read (`getMealPlan`), a `data-testid="plan"` line (e.g. `Plan: from 2026-10-09 · 4 of 15 meals` / `Plan: none yet` / `Plan is unavailable right now.`), and an `Open plan` link. Insert it as its own block after the targets block (`:39-44` script, `:94-99` markup), so S-05's own dashboard addition merges as an adjacent hunk.

**Middleware**: add `"/plan"` to `PROTECTED_ROUTES`. Because S-05 will add a route to the same one-line array, **reformat it to one entry per line** in S-03, which merges first. S-05's rebase then becomes a one-line insert.

### 6. Isolation test extension (`supabase/tests/household_isolation.sql`)

Additions, each in its own block, following the existing ordering rules (`:811-818`):
1. **Fixtures (as postgres, in the setup block around `:103-151`)**: one plan each for A's and B's household, each with one dish and one meal. For A, one meal is `eater_user_id = null` and one is `= A`. Use explicit fixture ids in a new namespace, e.g. `00000000-0000-4000-b000-00000000a007…` / `…b007…` (the `a006`/`b006` pattern).
2. **As postgres, composite-FK proofs**: a `plan_meals` row naming B's plan with A's `household_id`, or a dish from another plan, raises `foreign_key_violation`. Mirrors `:904-918`.
3. **As A, read isolation**: sees exactly its own plan/dish/meal fixtures and none of B's, for all three tables.
4. **As A, write denial**: direct insert with valid values must raise exactly `insufficient_privilege`, with no other handler (`:331-334` rationale). Update and delete must raise or affect 0 rows. Truncate must raise.
5. **Grants block (as postgres)**: for each of the three tables, `authenticated` lacks INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, including column-level INSERT/UPDATE/REFERENCES via `has_any_column_privilege`, and has SELECT. `anon` has nothing. Mirrors `:760-791`.
6. **RPC grants**: as anon, `public.save_meal_plan(...)` raises `insufficient_privilege`. Add the KD007 branch that names the missing revoke (`:574-597` pattern). The catch-alls inspect tables only, so this assertion is mandatory (hard rule).
7. **RPC behaviour, as A**:
   - a valid save returns A's plan id and writes the expected rows;
   - a re-save that changes one slot keeps the untouched slot's `plan_meals.id` (proves the diff);
   - a save with zero meals leaves an empty plan;
   - rejections KD010 (bad `day_index`, duplicate slot, junk `meal_type`), KD011 (unknown recipe), KD012 (eater = B, who is not in A's household). Use the `when others` + P0001 re-raise idiom (`:1158-1191`).
8. **Redemption** (in the C/D section):
   - give D a plan with a "D only" meal (as postgres, before D redeems, next to `:901-918`);
   - after the redemption: the redemption **succeeded** (no membership cascade into plans), D's old plan is still in `d_household`, D now sees C's plans and **not** its old plan, and C can save a plan with `eater_user_id = D` (D is now a member).
   - also: a save by C whose eater is a user outside the household is rejected with KD012.
9. **Anon table loop** (`:601-617`): append the three table names. That array is a line S-05 is unlikely to touch.
10. **Final notice strings** (`:1376`, `:1380`): add "meal plans …". These lines are shared, but S-05 adds no RLS tables, so a conflict is unlikely.

`library_tables` (`:679`) is **not** touched, because the plan tables are household-scoped. `seed_integrity.sql` is untouched, per the constraint.

### 7. Smoke test (`scripts/smoke.mjs`)

Add S-03 steps as **two separate blocks** in the `steps` array:
- **Block 1, "S-03: A plans", after the S-02 block (`:141-178`) and before the S-01 block:**
  - anonymous `GET /plan` → 302 `/auth/signin`;
  - anonymous `POST /api/plan` → 302 `/auth/signin`;
  - A `GET /plan` → 200 and the picker contains a seed recipe option (`value="5eed0002-0000-4000-8000-000000000001"`; seed ids are stable and reserved);
  - A posts a plan with 2 filled slots → 302 `/plan?…saved=1`;
  - A posts an unknown recipe uuid → `/plan?error=` (KD011 path);
  - A posts `eater=partner` while unlinked → `/plan?error=`;
  - A's dashboard `data-testid="plan"` shows `2 of 15 meals`.
- **Block 2, "S-03: the plan is shared", after the linking steps (`:256-287`):**
  - B's dashboard and `/plan` show A's plan (FR-003: linked persons see the same plans);
  - B saves an edit with `eater=partner` (now valid, resolves to A) → saved.
- **Assumption A6**: B does **not** save a plan before redeeming. That keeps README's cleanup note true for smoke runs ("a preserved pre-redemption household holds nothing but its history"). The isolation test covers the left-behind plan instead (§6.8).
- The failure-dump id list at `:330` is a shared line. Add `"plan"` via a separate constant spread into it, or accept a one-line conflict for S-05 to resolve.

### 8. Docs and roadmap (S-03 lines only, separate blocks)

- **CLAUDE.md**:
  - an S-03 bullet under §Auth flow / architecture (tables, RPC, KD010–KD012, the eater rule and the "no membership FK on plan rows" warning, the dish/meal split and that S-08 drops `unique (dish_id)`);
  - add the plan tables to the **Write-revoked tables** paragraph as a separate sentence.
- **README**:
  - `/plan` row in the route table (`README.md` §Auth routes);
  - a sentence in §Cleaning up noting that household deletion cascades plans, and that a preserved pre-redemption household may now hold plans (strengthening the existing ⚠️ warning);
  - a smoke description sentence.
- **Roadmap**: S-03 status → `done` at archive time, and the Backlog Handoff row, by the archive step, not the implementation.

### 9. Migration timestamp

- Applied on the cloud project (2026-10-08, `npx supabase migration list --linked`): `20261006120000, 20261007120000, 20261007120100, 20261007120200, 20261008120000, 20261008150000, 20261008160000`. Local and remote are in sync.
- Recommended name: `supabase/migrations/20261008170000_meal_plans.sql`. Re-run `migration list --linked` immediately before `npx supabase db push`. If S-05 (or anything else) applied a later version in the meantime, rename to a later timestamp. Then run `npm run test:rls` (CI tests the deployed schema, not the branch, per CLAUDE.md).

## Code References

- `supabase/migrations/20261007120000_products_and_recipes.sql:19-21` — `public.meal_type` enum (the grid rows).
- `supabase/migrations/20261008150000_shared_recipe_library.sql:312-320` — `public.recipes` shape the picker reads.
- `supabase/migrations/20261008150000_shared_recipe_library.sql:184-187, 260-262` — "resolve household once", and the single membership `update` that any `on update cascade` FK would hook into.
- `supabase/migrations/20261008120000_macro_targets.sql:31-33` — the per-person composite membership FK that plan rows must **not** copy.
- `supabase/migrations/20261007120200_household_invites.sql:56-81, 88-96, 164-165` — write-revoked table template (policies + revokes), the KD header and RPC grants.
- `supabase/migrations/20261008160000_library_revoke_maintain.sql:3-15` — why MAINTAIN must be revoked too.
- `supabase/tests/household_isolation.sql:626-664` — household_id catch-all (covers new tables automatically).
- `supabase/tests/household_isolation.sql:677-754` — classification catch-all (new tables pass via `household_id`).
- `supabase/tests/household_isolation.sql:760-791, 574-597, 1158-1191` — grants, RPC-grant and KD-rejection idioms to copy.
- `supabase/tests/household_isolation.sql:901-1046` — redemption section where the "plan stays behind" assertions go.
- `src/lib/services/recipes.ts:6-23` — where `listRecipes()` goes.
- `src/lib/services/invites.ts:8-37, 62-95` — KD → message map and `RpcResult` cast pattern for `meal-plans.ts`.
- `src/lib/services/macro-targets.ts:8-34` — row → DTO mapping pattern.
- `src/pages/api/targets.ts:6-71` — API route shape (auth check, formData guard, zod without coercion, redirect messages).
- `src/pages/targets.astro`, `src/pages/dashboard.astro:17-45, 88-99` — page/data-testid/banner patterns, and the dashboard insertion point.
- `src/middleware.ts:4` — `PROTECTED_ROUTES` (reformat to one-per-line).
- `scripts/smoke.mjs:109-305, 330` — step array and failure-dump id list.

## Architecture Insights

- **Three ownership classes** (isolation test header `:13-16`, CLAUDE.md): household-scoped, per-person and public library. Plans are plainly **household-scoped** (PRD Access Control: "Linked accounts share plans"). The eater column references a *person* but does not make the row per-person, which is why it gets a plain `auth.users` FK and not the membership FK.
- **Rows that travel vs. rows that stay**: per-person rows travel through redemption via `on update cascade`, and household rows stay in the origin household. Mixing the two in one row (household-owned row + membership-cascade FK) breaks redemption. This is the main trap for S-03 and for every later household table that names a person (S-09 check-offs by person, S-13 attribution).
- **Policies and grants are independent levers.** Every write-revoked table keeps all four policies (for the catch-all) **and** the revokes (for actual denial), and the test asserts both.
- **Definer RPCs are the project's transaction boundary.** Multi-table writes use RPCs with distinct KD SQLSTATEs, mapped to messages in one service file.
- **Determinism and stable ids**: the slot-level diff keeps ids stable for unchanged slots, which suits S-04's determinism NFR and per-day re-solving.

## Historical Context (from prior changes)

- `context/archive/2026-10-08-shared-recipe-library/plan.md:353-354`: KD006 retired. "S-03 picks a new code if plans should ever block a redemption." Non-binding FK guidance: plan slots → `public.recipes on delete restrict`.
- `context/archive/2026-10-08-shared-recipe-library/research.md:271`: open question for S-03, whether a redeemer's plans block, migrate or stay behind. **Resolved here (recommended)**: they stay behind in the preserved origin household, consistent with S-01's "old household preserved memberless" decision (`roadmap.md:315`) and F-04's "households own only what is theirs".
- `context/archive/2026-10-08-set-daily-macro-targets/research.md:187` and `plan.md:47`: hand-off. "S-03 should store meal eaters as `user_id`s (or `both`), not as letters." A/B can be derived from `joined_at` order if ever needed. Adopted.
- `context/archive/2026-10-08-set-daily-macro-targets/plan-brief.md:75`: S-04 must snapshot targets for determinism. That stays S-04's job and does not affect S-03's schema.
- `context/archive/2026-10-07-seed-products-and-recipes/plan.md:397, 405`: entity interfaces and list readers were deliberately deferred to S-03/S-05. `listRecipes()` and `RecipeListItem` are that hand-off.
- `context/archive/2026-10-07-link-partner-household/research.md:160`: "merge non-seed rows" on redemption was rejected as speculative. The same reasoning applies to plans.
- No `context/foundation/lessons.md` exists, so no recorded lessons apply.

## Related Research

- `context/archive/2026-10-08-shared-recipe-library/research.md`
- `context/archive/2026-10-08-set-daily-macro-targets/research.md`
- `context/archive/2026-10-07-link-partner-household/research.md`
- `context/archive/2026-10-07-seed-products-and-recipes/research.md`
- Parallel: `.claude/worktrees/s-05-prompt-chain-183cb8/context/changes/browse-recipe-library/` (S-05; only `change.md` existed at research time).

## Coordination with S-05 (summary for the plan)

| Shared file | S-03 change | Merge note |
| --- | --- | --- |
| `src/lib/services/recipes.ts` | append `listRecipes()` | S-05 extends after rebasing. Keep the select list exactly id/name/cuisine/prep_minutes/meal_types. |
| `src/types.ts` | `RecipeListItem` + plan types in a commented S-03 block | Both slices append. S-05 resolves an adjacent-hunk conflict on rebase. |
| `src/middleware.ts` | reformat array one-per-line, add `"/plan"` | Makes S-05's route a one-line insert. |
| `src/pages/dashboard.astro` | separate plan block + link | Adjacent to targets block. |
| `scripts/smoke.mjs` | two S-03 step blocks; `"plan"` testid via a separate constant | Avoid editing the `:330` line in place if possible. |
| README / CLAUDE.md / roadmap | S-03 lines in their own blocks | Route table row `/plan`. |
| `supabase/migrations/` | `20261008170000_meal_plans.sql` or later | Re-check the cloud list before push. S-05 is not expected to add migrations, but its "photo" field (roadmap S-05 outcome) might. |

No S-03 change touches the library tables, `seed_integrity.sql`, or any recipe browse/detail UI.

## Assumptions (made in place of questions)

- **A1**: a dish belongs to one plan; cross-plan dishes are out of FR-017.
- **A2**: whole-day marking is a save-time shortcut, not stored.
- **A3**: deleting a partner's account cascades away meals marked only for them.
- **A4**: no plan-delete RPC; an empty plan is the "cleared" state.
- **A5**: `/plan` opens the latest plan by `start_date` (or `?start=`). A new date creates a new plan. There is no plan history list (scope).
- **A6**: the smoke run does not create a pre-redemption plan for B.
- **A7**: UI strings stay English, as in the rest of the app, until S-14. Day headers show the ISO date plus a weekday derived on the server.
- **A8**: an unlinked user may still plan (FR-015/FR-020). "Partner" is not offered until linked, and "Both" then means just them until a partner joins.

## Open Questions

1. **Should redemption warn about plans left behind?** The recommendation is no block and no new KD code. `/join` could add a one-line notice ("your current plans stay in your old household"). Owner: user. Non-blocking; defaults to no notice.
2. **S-04 hand-off**: should a plan save invalidate solve results? With the slot-level diff, S-04 can invalidate per day (e.g. compare `plan_meals` ids or a per-day hash). S-04 decides. S-03 only guarantees stable ids for unchanged slots.
3. **Pre-existing MAINTAIN gap** on `macro_targets` and `household_invites` (both revoke only `truncate, references, trigger`). Out of S-03 scope by the coordination rules. Worth a small follow-up migration plus isolation-test assertion, like F-04's `20261008160000`.
4. **Overlapping plans** (start dates one day apart) are allowed by `unique (household_id, start_date)`. S-09/S-10 consume one plan at a time, so this is harmless for now. Revisit if a "current plan" concept is needed.
