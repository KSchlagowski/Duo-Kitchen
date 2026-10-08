# Plan a 3-Day Grid (S-03) Implementation Plan

## Overview

S-03 lets a household fill 3 consecutive days × 5 meals with any recipe from the public library, mark each meal (or a whole day) for A, B or both, leave slots empty, and save and re-open the plan without solving (US-01, FR-013–FR-016, FR-020). It adds three household-scoped tables written only through one security-definer RPC, a small `listRecipes()` reader that S-05 builds on, an Astro-only `/plan` page with `POST /api/plan`, a dashboard line, isolation-test coverage and smoke steps.

The data shape separates a **dish** (one cooked batch of one recipe) from a **meal** (one filled slot). S-08 (one dish across several days) can then land by dropping one unique constraint, with no data migration and no rework of S-04's output tables.

## Current State Analysis

Nothing plan-related exists yet: no table, type, service, route or test (research §1). The building blocks are all in place:

- `public.meal_type` enum = `breakfast, second_breakfast, lunch, afternoon_snack, dinner`, already in FR-013 grid order (`supabase/migrations/20261007120000_products_and_recipes.sql:19-21`). TS mirror `MealType` is at `src/types.ts:23`.
- The public library `public.recipes(id, name, cuisine, prep_minutes, meal_types meal_type[] ≤ 2, …)` is read-only to `authenticated` (`20261008150000_shared_recipe_library.sql:312-320, 427-431`). There are 8 seed recipes with stable ids `5eed0002-0000-4000-8000-00000000000{1..8}`. One of them (`Zapiekanka makaronowa`) suggests **no** meal type.
- `private.user_household_ids()` is the only allowed way for a policy to scope by household (`20261006120000_household_data_scope.sql:41-54`).
- `household_invites` is the template for a write-revoked table: four policies plus revokes, RPC writes, a KD SQLSTATE header and RPC grants (`20261007120200_household_invites.sql:56-96, 164-165`).
- `src/lib/services/recipes.ts` has only `getRecipeLibrarySummary()`. `src/lib/services/invites.ts` holds the KD → message map and the `RpcResult` cast idiom. `src/pages/api/targets.ts` is the API-route template: auth check, `formData()` guard, zod without coercion, redirect messages.
- `PROTECTED_ROUTES = ["/dashboard", "/targets"]` sits on one line (`src/middleware.ts:4`). `/api/*` is unprotected, so every API route checks `context.locals.user` itself.
- The cloud project's latest applied migration is `20261008160000_library_revoke_maintain.sql`.

## Desired End State

- A signed-in user opens `/plan` and sees a 3-day × 5-meal grid starting at a chosen date. Each slot has a recipe picker: "— empty —", then **Suggested** recipes for that meal type, then **Other recipes**. Each slot also has an eater picker (Both / Me / Partner, with Partner only once linked). Each day has a "whole day for" shortcut.
- Saving persists the plan atomically. Re-opening `/plan` shows the saved grid preselected. Linked partners see and edit the same plan. The dashboard shows `Plan: from <date> · N of 15 meals`.
- Invalid payloads are rejected with distinct SQLSTATEs: KD010 (malformed), KD011 (unknown recipe), KD012 (eater not in household). Each maps to its own message.
- `npm run test:rls` proves isolation, write denial, grants, RPC grants, RPC behaviour, and that redemption succeeds with plans left behind. `npm run smoke` proves the end-to-end flow, including the shared plan after linking.

Verify with: `npx supabase db push` → `npm run test:rls` → `npm run test:seed` (unchanged, must still pass) → `npm run lint` → `npx astro check` → `npm run build` → preview + `npm run smoke`.

### Key Discoveries:

- Option C from research (dish + meal, `unique (dish_id)` for S-03 only) is the shape that keeps S-08 additive (research §2). S-08's migration is `alter table public.plan_meals drop constraint plan_meals_dish_id_key` plus a wider RPC payload.
- **Do not** give `plan_meals.eater_user_id` the per-person composite `(household_id, user_id) → household_members on update cascade` FK that `macro_targets` uses (`20261008120000_macro_targets.sql:31-33`). Plans are household-owned and must stay behind. With that FK, `redeem_household_invite()`'s membership `update` would cascade into `plan_meals.household_id`, violate the `(plan_id, household_id) → meal_plans` FK, and fail the redemption with 23503 (research §3).
- PG17 default privileges also grant MAINTAIN, so the revoke list must include `maintain` (`20261008160000_library_revoke_maintain.sql:3-9`).
- The isolation test's household_id catch-all (`household_isolation.sql:626-664`) and classification catch-all (`:677-754`) pick the new tables up automatically. Function grants are **not** covered and need their own assertion (hard rule).
- `rpc()` returns `any` because there is no generated `Database` type, so cast it to `RpcResult<T>` at the service boundary (`src/lib/services/invites.ts:62-67`).

## What We're NOT Doing

- No recipe browse or detail UI, and no recipe filters or sorting (S-05 / S-06). `listRecipes()` stays at id/name/cuisine/prep_minutes/meal_types, ordered by name.
- No change to the five library tables or to `supabase/tests/seed_integrity.sql`.
- No solving, solve-result tables or targets snapshot (S-04). No shopping list or cooking sessions (S-09 / S-10).
- No shared dish across slots (S-08). The RPC payload has no dish key, and `unique (dish_id)` enforces 1:1.
- No stored per-day eater default: the "whole day for" control is a save-time shortcut (Assumption A2).
- No plan history list, no plan delete RPC, no "current plan" concept. An empty saved plan is the cleared state (A4, A5).
- No warning on `/join` about plans left in the old household (research Open Question 1, default: no notice).
- No fix for the pre-existing MAINTAIN gap on `macro_targets` / `household_invites` (research Open Question 3, a separate follow-up).
- No preserved form state on a rejected save. The page re-renders the stored plan with the error banner. The UI never offers the inputs that would be rejected, so this is only reached by tampering or races.
- No `created_by` / agent attribution (S-13). No roadmap status change (done by the archive step).
- No React island: the page needs no client state.

## Implementation Approach

Database first, proven by the isolation test against the cloud project. Then the app layer (types, services, API, page, middleware, dashboard), verified by lint, type checks and a manual run. Then smoke steps and docs. Every edit to a file shared with the parallel S-05 slice goes in its own commented S-03 block, so S-05's rebase sees adjacent hunks, not interleaved ones.

**Assumptions** (non-interactive session; recommended options picked):

- A1: A dish belongs to one plan (`plan_dishes.plan_id`). Cross-plan dishes are outside FR-017.
- A2: "Mark a whole day" = a per-day control that, on save, overwrites the eater of every filled meal of that day. It is not stored.
- A3: Deleting a partner's account turns meals marked only for them into "Both" (`eater_user_id → auth.users on delete set null`), which by A8 means the remaining member. No dish is orphaned and no slot silently disappears; the survivor can clear those slots by hand.
- A4: There is no delete-plan path. Saving with every slot empty leaves an empty plan.
- A5: `/plan` opens `?start=<date>` if given and valid, else the most recently saved plan (`updated_at desc`, bumped by every save), else a blank grid for **tomorrow in `Europe/Warsaw`** (the household's locale). Saving under a new start date creates a new plan (`unique (household_id, start_date)`). Overlapping plans are allowed.
- A6: In the smoke run, B does not save a plan before redeeming, so README's cleanup note stays true for smoke data. The isolation test covers left-behind plans.
- A7: UI strings stay in English. Day headers show ISO date plus weekday, computed with UTC date arithmetic so no time-zone shift can move a day.
- A8: An unlinked user may plan. "Partner" is not offered until linked. "Both" (`eater_user_id null`) means "every current member", so it automatically covers a partner who links later.
- A9: KD007 is reused for "no authenticated caller / no household", because its meaning is identical to S-01's. Its user-facing text in the plan service is plan-specific.
- A10: Last writer wins when both partners save at once. The upsert row lock serialises the two saves, and no optimistic-concurrency token is added.

## Critical Implementation Details

**Validate the payload without bare casts.** A bad uuid or enum text would raise `22P02` and surface as a generic error, breaking the "distinct SQLSTATE per reason" rule. Read `p_meals` elements as **text** (`jsonb_array_elements` + `->>`). Check shape with `jsonb_typeof`, uuid and `day_index` with regexes, and `meal_type` against `enum_range(null::public.meal_type)::text[]`, then cast. Keep that parse step in its own `begin … exception when others then raise … using errcode = 'KD010'` sub-block, separate from the KD011/KD012 checks, so the catch-all cannot swallow and relabel them. Run all validation before any write.

**PostgREST embed ambiguity.** `plan_meals` has FKs to both `meal_plans` and `plan_dishes`, and `plan_dishes` also references `meal_plans`. PostgREST may report `PGRST201` (ambiguous embed) on `meal_plans → plan_meals` or `plan_meals → plan_dishes`. Name every FK constraint explicitly in the migration (e.g. `plan_meals_plan_fkey`, `plan_meals_dish_fkey`, `plan_dishes_plan_fkey`) so the service can disambiguate with `plan_meals!plan_meals_plan_fkey(…)` if needed. Check the embed against the cloud project in Phase 2.

**Diff order inside the RPC.** Delete the meals whose slot is gone or whose recipe changed. Update the eater where only the eater changed. Insert a new dish + meal for each new or changed slot. Finally delete the plan's dishes that have no meal (`not exists`). Deleting dishes last is what keeps the step correct once S-08 lets several meals share one dish.

## Phase 1: Database — plan tables, RPC and isolation test

### Overview

One migration creates the three household-scoped, write-revoked tables and the `save_meal_plan` RPC. The isolation test is extended in the same phase, because CI tests the deployed schema and the hard rule requires a push plus a `test:rls` run before merge.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/20261008170000_meal_plans.sql` (re-check `npx supabase migration list --linked` right before pushing. If anything later than `20261008160000` was applied, for example by S-05, rename to a later timestamp.)

**Intent**: Create `meal_plans`, `plan_dishes` and `plan_meals`, their RLS policies and revokes, and the single write path `public.save_meal_plan`. The header documents the ownership class, the "no membership FK" rule, the S-08 hand-off and the claimed SQLSTATEs.

**Contract**:

- `public.meal_plans(id uuid pk default gen_random_uuid(), household_id uuid not null → public.households on delete cascade, start_date date not null, created_at, updated_at timestamptz not null default now(), unique (household_id, start_date), unique (id, household_id))`. The household_id index is the leading column of `unique (household_id, start_date)`. Say so in a comment.
- `public.plan_dishes(id pk, household_id not null → households on delete cascade, plan_id uuid not null, recipe_id uuid not null → public.recipes on delete restrict, created_at, constraint plan_dishes_plan_fkey foreign key (plan_id, household_id) → meal_plans (id, household_id) on delete cascade, unique (id, plan_id))`.
- `public.plan_meals(id pk, household_id not null → households on delete cascade, plan_id uuid not null, day_index smallint not null check (day_index between 0 and 2), meal_type public.meal_type not null, dish_id uuid not null, eater_user_id uuid null → auth.users on delete set null (A3), created_at, constraint plan_meals_plan_fkey (plan_id, household_id) → meal_plans (id, household_id) on delete cascade, constraint plan_meals_dish_fkey (dish_id, plan_id) → plan_dishes (id, plan_id) on delete cascade, unique (plan_id, day_index, meal_type), constraint plan_meals_dish_id_key unique (dish_id))`. Name the `unique (dish_id)` constraint explicitly and comment it "S-03 only — S-08 drops this".
- Indexes: `household_id` on `plan_dishes` and `plan_meals`; `plan_dishes (plan_id, household_id)`; `plan_dishes (recipe_id)`; `plan_meals (plan_id, household_id)` is covered by the leading `plan_id` of the slot unique, so add one only if the implementer finds it is not; `plan_meals (eater_user_id)`.
- **No** `(household_id, user_id) → household_members` FK on `plan_meals`. Put a comment at the column that explains why (see Key Discoveries).
- RLS enabled on all three tables, each with four policies (`select`/`insert`/`update`/`delete`) `to authenticated`, `using` / `with check (household_id in (select private.user_household_ids()))`. No anon policies.
- Per table: `revoke all … from anon;` and `revoke insert, update, delete, truncate, references, trigger, maintain … from authenticated;` (select stays granted).
- `public.save_meal_plan(p_start_date date, p_meals jsonb) returns uuid`, `language plpgsql`, `security definer`, `set search_path = ''`, every name fully qualified, then `revoke execute … from public, anon; grant execute … to authenticated;`.
  - Payload: a JSON array of at most 15 `{ "day_index": 0..2, "meal_type": "<enum>", "recipe_id": "<uuid>", "eater_user_id": "<uuid>" | null }`.
  - Body order:
    1. Resolve the caller's household once, before any write → KD007 if `auth.uid()` is null or there is no household.
    2. Validate. KD010: `p_start_date` null, `p_meals` null or not an array (use `jsonb_typeof(p_meals) is distinct from 'array'`, since `jsonb_typeof(null)` is null and a `<>` check would let a null payload through and wipe the plan), more than 15 elements, an element that is not an object, a missing key, `day_index` not 0–2, unknown `meal_type`, non-uuid ids, or a duplicate `(day_index, meal_type)`. KD011: some `recipe_id` not in `public.recipes`. KD012: some non-null `eater_user_id` not in `public.household_members` for the resolved household.
    3. `insert into meal_plans … on conflict (household_id, start_date) do update set updated_at = now() returning id`. The conflict update takes the row lock, so two concurrent saves serialise (A10).
    4. Apply the slot diff in the order given in Critical Implementation Details.
    5. Return the plan id.
- Header comment: claims KD010–KD012, reuses KD007, notes that KD006 stays retired, and says KD008/KD009 belong to S-01.

#### 2. Isolation test extension

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Prove isolation, write denial, grants, RPC grants, RPC behaviour and the "plans stay behind on redemption" rule. Each addition is its own commented `S-03` block placed next to the matching existing section, following the file's ordering rules (`:811-818`).

**Contract** (blocks, mirroring the cited idioms):

1. Fixtures (as postgres, setup block `:103-151`): one plan + one dish + one meal for A's household and for B's household, using new fixed ids (`…a007…` / `…b007…` namespace). A's plan has two dishes, each with one meal (eater null / eater A), because `plan_meals_dish_id_key` allows only one meal per dish.
2. Composite-FK proofs (as postgres, like `:904-918`): a `plan_meals` row with A's `household_id` naming B's plan raises `foreign_key_violation`, and so does a meal naming a dish from another plan.
3. Read isolation (as A): exactly A's fixture rows in all three tables, none of B's.
4. Write denial (as A): direct `insert` with otherwise-valid values raises exactly `insufficient_privilege` with no other handler (`:331-334` rationale). `update` / `delete` raise or affect 0 rows. `truncate` raises.
5. Grants (as postgres, like `:760-791`): for each table, `authenticated` has SELECT and lacks INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, including column-level via `has_any_column_privilege`. `anon` has nothing.
6. RPC grants (like `:574-597`): as anon, calling `public.save_meal_plan` raises `insufficient_privilege`. The KD007 branch names the missing revoke. Also assert `has_function_privilege('anon', …, 'execute')` is false and true for `authenticated`.
7. RPC behaviour (as A; the block sits after item 3, and every save uses a `start_date` distinct from every fixture plan, so the exact-count read assertions stay order-independent):
   - a valid 2-meal save returns A's plan id and writes the expected rows;
   - a re-save changing one slot's recipe keeps the other slot's `plan_meals.id` and removes the orphaned dish;
   - an eater-only change keeps the meal id;
   - an empty `[]` save leaves the plan row with zero meals and zero dishes;
   - KD010 for `day_index` 3, a duplicate slot, junk `meal_type`, a non-uuid recipe id, a non-array payload and `save_meal_plan(<date>, null)`;
   - KD011 for an unknown recipe uuid;
   - KD012 for eater = B.
   Use the `when others` + P0001 re-raise idiom (`:1158-1191`) so a wrong SQLSTATE fails the test.
8. Redemption (C/D section, `:901-1046`): before D redeems, give D a plan with a "D only" meal and give C one fixture plan (both as postgres). After the redemption, assert that it **succeeded**, that D's old plan still has `household_id = d_household`, and that D (as authenticated) sees exactly C's one fixture plan and not its old one. Then C saves a plan with `eater_user_id = D` (accepted) and with an outside user (KD012). Finally, as postgres, delete a C/D fixture user whose meal is eater-specific and assert that the meal's `eater_user_id` is now null and the plan's dish count is unchanged (A3, `on delete set null`).
9. Append the three table names to the anon table loop (`:601-617`). Add "meal plans" to the final notice strings (`:1376`, `:1380`).

`library_tables` (`:679`) stays untouched.

### Success Criteria:

#### Automated Verification:

- Migration timestamp is later than every cloud-applied migration: `npx supabase migration list --linked`
- Migration applies to the hosted project: `npx supabase db push`
- Household isolation test passes, including all new S-03 blocks: `npm run test:rls`
- Seed integrity test still passes unchanged: `npm run test:seed`

#### Manual Verification:

- Deliberate-break check (rolled back, never pushed): copy `supabase/tests/household_isolation.sql` to the scratchpad twice. In the first copy insert `grant maintain on public.plan_meals to authenticated;` directly after its first `begin;` line; in the second insert `grant execute on function public.save_meal_plan(date, jsonb) to anon;` instead. Run each with `npx supabase db query --linked -f <copy>` and confirm it fails with the descriptive grant / RPC-grant message. The file ends in `rollback;`, so nothing is committed.
- Reviewer reads the migration header and confirms that the "no membership FK on plan rows" warning and the S-08 hand-off are stated.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: App layer — types, services, `/plan` page, API, middleware, dashboard

### Overview

Wire the plan into the app: a recipe list reader, a plan service, the form page, the POST endpoint, route protection and a dashboard summary line.

### Changes Required:

#### 1. Types

**File**: `src/types.ts`

**Intent**: Add the DTOs in one commented `// Recipe picker and meal plan (S-03)` block at the end of the file, so S-05 appends next to it.

**Contract**: `RecipeListItem { id; name; cuisine; prepMinutes: number; mealTypes: MealType[] }`, `PlanEater = "both" | "me" | "partner"` (form level), `PlanMeal { dayIndex: 0 | 1 | 2; mealType: MealType; recipeId: string; eaterUserId: string | null }`, `MealPlan { id; startDate: string; updatedAt: string; meals: PlanMeal[] }`.

#### 2. Recipe list reader

**File**: `src/lib/services/recipes.ts`

**Intent**: Append `listRecipes()` under an S-03 comment. It is the minimal reader S-05 extends.

**Contract**: `listRecipes(supabase: SupabaseClient): Promise<RecipeListItem[]>`, with `.from("recipes").select("id, name, cuisine, prep_minutes, meal_types").order("name")`, mapping snake_case to camelCase (pattern: `src/lib/services/macro-targets.ts:8-34`). It throws on error. No filters.

#### 3. Plan service

**File**: `src/lib/services/meal-plans.ts` (new)

**Intent**: The single home for plan reads, the RPC call and the KD → message map, mirroring `src/lib/services/invites.ts`.

**Contract**:

- `getMealPlan(supabase, startDate?: string): Promise<MealPlan | null>`: `meal_plans` with embedded `plan_meals(day_index, meal_type, eater_user_id, plan_dishes(recipe_id))`. If `startDate` is given, filter `eq("start_date", …)`; otherwise order by `updated_at desc` with `limit(1)` (the most recently **saved** plan, A5 — so a stray mistyped date stops being the default as soon as the intended plan is saved). Use `maybeSingle()`. RLS scopes the query to the household, so there is no household filter. Disambiguate the embed with the named FKs if PostgREST reports `PGRST201`.
- `saveMealPlan(supabase, startDate: string, meals: PlanMeal[]): Promise<string>`: `rpc("save_meal_plan", { p_start_date, p_meals })`, mapping DTOs to the snake_case payload and casting with a local `RpcResult<string>`. It throws on error or null data.
- `mealPlanErrorMessage(error: unknown): string`: map KD007 ("You need to be signed in to save a plan."), KD010 ("That plan could not be read. Please try again."), KD011 ("One of the chosen recipes no longer exists.") and KD012 ("A meal is marked for someone who isn't in your household."). Otherwise fall back to a generic "Your plan could not be saved. Please try again." Use the same `errorCode` guard idiom as `invites.ts:26-32`.

#### 4. API route

**File**: `src/pages/api/plan.ts` (new)

**Intent**: Validate the grid form and save it through the service, modelled on `src/pages/api/targets.ts`.

**Contract**: `POST` only.

1. Redirect to `/auth/signin` when `context.locals.user` is missing.
2. Guard `formData()` with try/catch.
3. zod:
   - `start_date` matches `^\d{4}-\d{2}-\d{2}$` and round-trips through `Date.UTC` (a real calendar date);
   - for each `d{0..2}_{meal_type}_recipe`: `""` or a uuid;
   - for each `d{n}_{meal_type}_eater`: `z.enum(["both","me","partner"])`, defaulting to `both` only when the field is absent;
   - for each `day{n}_eater`: `"" | both | me | partner`.
   Build the 15 keys from a `MEAL_TYPES` constant in enum order.
4. Resolve `me` → `user.id` and `partner` → the other member from `getCurrentHousehold()`. A `partner` choice while unlinked redirects with "You can mark meals for your partner once you're linked." If `getCurrentHousehold()` itself fails, redirect with the generic save error ("Your plan could not be saved. Please try again.") — never treat the user as unlinked.
5. Apply a non-empty day override to that day's filled meals. Empty recipe fields are dropped (FR-015).
6. Call `saveMealPlan`. On success redirect to `/plan?start=<date>&saved=1`. On error redirect to `/plan?start=<date>&error=<mealPlanErrorMessage>`; validation failures use `/plan?error=<INVALID_PLAN>`, with `start` included when it parsed. Every redirect after `start_date` parses (including the partner-while-unlinked and failed-household cases in step 4) has the exact form `/plan?start=<date>&error=<encodeURIComponent(msg)>`, `start` first. Log failures with `console.error`, as `targets.ts` does.

#### 5. Page

**File**: `src/pages/plan.astro` (new)

**Intent**: Server-rendered grid form that also is the read-back of the saved plan (FR-020 "use without solving").

**Contract**:

- Reads, each in try/catch:
  - `listRecipes`;
  - `getCurrentHousehold`, which drives `isLinked` and the partner id;
  - `getMealPlan(start)`, where `start` comes from a valid `?start=` or is omitted for the most recently saved plan.
- The `<form>` is rendered **only when all three reads succeed**. On any failure, show the matching "… unavailable right now." banner and no form, so a save can never overwrite the stored plan from a blank grid or remap partner-only meals to Both.
- Start-date default per A5.
- A `data-testid="plan-summary"` line: `Plan: from <date> · N of 15 meals`, `Plan: none yet`, or `Plan is unavailable right now.`
- One `<form method="POST" action="/api/plan">`:
  - `start_date` `<input type="date">`;
  - 3 day sections. The header shows the ISO date + weekday (A7) and a `day{n}_eater` select ("—" / Both / Me / Partner*);
  - 5 meal rows per day, in enum order with human labels;
  - each slot has `d{n}_{meal}_recipe` (empty option, then `<optgroup label="Suggested">` with recipes whose `mealTypes` include the slot, then `<optgroup label="Other recipes">` with the rest; a recipe with no meal types always goes in Other) and `d{n}_{meal}_eater` (Both / Me / Partner*);
  - saved values are preselected. The eater is mapped `null → both`, `user.id → me`, otherwise `partner`.
  - \* "Partner" options are rendered only when `isLinked`.
- `?saved=1` / `?error=` banners use the `/targets` pattern (`src/pages/targets.astro:49-74`). Native controls with `<label>`s, no island. Use `cn()` for any conditional classes. If `listRecipes` fails, show "Recipes are unavailable right now."; if `getCurrentHousehold` or `getMealPlan` fails, show the matching unavailable banner — in every failure case, no form.

#### 6. Middleware

**File**: `src/middleware.ts`

**Intent**: Protect `/plan`. Reformat `PROTECTED_ROUTES` to one entry per line in the same edit, so S-05's route becomes a one-line insert.

**Contract**: `PROTECTED_ROUTES` contains `"/dashboard"`, `"/targets"`, `"/plan"`, each on its own line.

#### 7. Dashboard

**File**: `src/pages/dashboard.astro`

**Intent**: Summarise the most recently saved plan (A5) in its own S-03 block, after the targets block in both the script (after `:39-44`) and the markup (after `:94-99`).

**Contract**: one try/catch `getMealPlan(supabase)`; a `data-testid="plan"` line with the same three label variants as `plan-summary`; and an `<a href="/plan">` reading "Open plan", or "Start a plan" when the read succeeded and found none.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Type checking passes: `npx astro check`
- Production build succeeds: `npm run build`
- Existing smoke steps still pass against the preview: `npm run build && npm run preview` + `npm run smoke`

#### Manual Verification:

- On `/plan` as a fresh user: the grid shows 3 dated days × 5 meals. Each picker lists "Suggested" before "Other recipes", and `Zapiekanka makaronowa` appears under "Other recipes" in every slot. No "Partner" option is shown while unlinked.
- Filling 2 slots and saving shows "Saved.". Re-opening `/plan` shows those 2 slots preselected, and the dashboard reads `Plan: from <date> · 2 of 15 meals`.
- A day's "whole day for: Me" choice saves every filled meal of that day as "Me".
- Clearing every slot and saving leaves `Plan: from <date> · 0 of 15 meals` (the plan still exists).
- Changing the start date and saving creates a second plan. `/plan?start=<old date>` still opens the first one.
- A tampered POST (an unknown recipe uuid, via devtools) shows the KD011 message, not a generic error.
- With a read failing (e.g. `getMealPlan` forced to throw), no form is rendered and the matching unavailable banner is shown.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Smoke test and documentation

### Overview

Add the S-03 flow to the end-to-end smoke run, then document the new tables, RPC, route and rules in the shared docs, each in its own block.

### Changes Required:

#### 1. Smoke steps

**File**: `scripts/smoke.mjs`

**Intent**: Prove the plan flow over HTTP for one user, then the sharing for two linked users. The steps go in two commented blocks, with a fixed far-future `planStart` date constant (e.g. `2031-01-06`) so no time-zone edge can shift it.

**Contract**:

- Block "S-03: A plans", after the S-02 block (after `:178`) and before the S-01 block:
  - B (still anonymous) `GET /plan` → 302 `/auth/signin`;
  - anonymous `POST /api/plan` → 302 `/auth/signin`;
  - A `GET /plan` → 200, the body contains `value="5eed0002-0000-4000-8000-000000000001"`, and `plan-summary` shows `Plan: none yet`;
  - A posts 2 filled slots → 302, location exactly `/plan?start=<planStart>&saved=1`;
  - A posts an RFC-valid unknown recipe uuid (e.g. `00000000-0000-4000-8000-0000000000ff`, so zod's strict `z.uuid()` passes it to the RPC) → location exactly `` `/plan?start=${planStart}&error=${encodeURIComponent("One of the chosen recipes no longer exists.")}` ``;
  - A posts `eater=partner` while unlinked → location exactly `` `/plan?start=${planStart}&error=${encodeURIComponent("You can mark meals for your partner once you're linked.")}` ``;
  - A's dashboard `plan` testid shows `Plan: from <planStart> · 2 of 15 meals`.
- Block "S-03: the plan is shared", after the linking steps (after `:287`):
  - B's dashboard shows the same `plan` line;
  - B's `/plan` shows A's seed recipe selected (`<option[^>]*value="5eed…001"[^>]*selected`);
  - B saves 3 slots with one slot `eater=partner` → saved;
  - A's dashboard shows `3 of 15 meals`;
  - A's `/plan` shows that slot's eater select with `me` selected (partner resolution proven from both sides).
- Failure dump: put the S-03 testids (`"plan"`, `"plan-summary"`) in a separate `S03_TEST_IDS` constant spread into the `:330` array, so the shared line changes by one token.

#### 2. CLAUDE.md

**File**: `CLAUDE.md`

**Intent**: Record the S-03 architecture and the write-revoked status, as separate S-03 additions.

**Contract**:

- A new `- Meal plans (S-03): …` bullet under §Auth flow, after the macro-targets bullet. It covers:
  - the three tables and the dish/meal split;
  - that S-08 drops `plan_meals_dish_id_key`;
  - the `save_meal_plan` RPC and the slot-level diff with stable ids;
  - KD010–KD012 and KD007 reuse;
  - `eater_user_id` null = both;
  - the warning: never add the membership composite FK to plan rows, because plans stay behind on redemption;
  - `/plan`, `POST /api/plan`, `src/lib/services/meal-plans.ts`, and `listRecipes()` in `recipes.ts`.
- In the **Write-revoked tables** hard rule, one appended sentence: `meal_plans`, `plan_dishes` and `plan_meals` (S-03) follow the same pattern, writes only via `public.save_meal_plan`, and their revoke list includes `maintain`.

#### 3. README

**File**: `README.md`

**Intent**: Document the route, the smoke coverage and the cleanup implication.

**Contract**:

- A `/plan` row in the §Auth routes table: "Household 3-day meal plan (shared with your partner)".
- One sentence in §Smoke test describing the S-03 steps.
- In §Cleaning up, one sentence: deleting a household cascades its plans, and a preserved pre-redemption household may now hold the redeemer's plans. This reinforces the ⚠️ warning; the smoke run itself creates no pre-redemption plans (A6).

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Formatting is clean for docs: `npx prettier --check README.md CLAUDE.md`
- Full smoke run passes against the production preview: `npm run build && npm run preview` + `npm run smoke`
- Isolation test still passes: `npm run test:rls`

#### Manual Verification:

- Two-browser check: A and B linked, B edits a slot on `/plan`, and A sees the change after a reload.
- Reviewer confirms that each shared-file edit (middleware, dashboard, smoke, README, CLAUDE.md, types, recipes service) is a self-contained S-03 block suitable for S-05's rebase.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- The project has no unit-test runner (CLAUDE.md §Commands), so none are added. Pure helpers (form → `PlanMeal[]` mapping, day override, weekday labels) stay small and are covered by smoke and manual steps.

### Integration Tests:

- `supabase/tests/household_isolation.sql`: database-level isolation, grants, RPC grants, RPC behaviour (diff stability, empty plan, KD010/KD011/KD012) and redemption with plans left behind (Phase 1 §2).
- `scripts/smoke.mjs`: HTTP-level protection, save, rejection paths, dashboard summary and the shared plan after linking (Phase 3 §1).

### Manual Testing Steps:

1. A fresh account opens `/plan`. Check the picker grouping and that no Partner option is shown.
2. Save 2 slots. Check the read-back and the dashboard line.
3. Apply a whole-day shortcut. Check that every filled meal of that day shows the chosen eater.
4. Clear all slots and save. The plan exists with 0 meals.
5. Link a partner. The partner sees and edits the same plan, and "Partner" now appears and resolves correctly from each side.

## Performance Considerations

At most 15 meals and 15 dishes per plan, and one RPC call per save. `listRecipes()` is unbounded but small: 8 seed recipes now, and the user-added library growth arrives with S-07. If the library grows past a few hundred rows, S-05/S-06 pagination applies. The page renders 15 copies of the option list; acceptable at this size.

## Migration Notes

The migration is additive (new tables, a new function) and needs no backfill. Rollback, if ever needed, is a follow-up migration dropping the function and the three tables (children first). There is no production plan data before this slice. Re-check the cloud migration list before `db push` because S-05 runs in parallel.

## References

- Related research: `context/changes/plan-three-day-grid/research.md`
- Write-revoked template: `supabase/migrations/20261007120200_household_invites.sql:56-96, 164-165`
- Per-person FK that must not be copied: `supabase/migrations/20261008120000_macro_targets.sql:31-33`
- MAINTAIN revoke rationale: `supabase/migrations/20261008160000_library_revoke_maintain.sql:3-9`
- API route template: `src/pages/api/targets.ts`
- KD map / RpcResult idiom: `src/lib/services/invites.ts:8-37, 62-95`
- Isolation idioms: `supabase/tests/household_isolation.sql:331-334, 574-617, 626-664, 760-791, 901-1046, 1158-1191`
- Smoke structure: `scripts/smoke.mjs:109-305, 330`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Database — plan tables, RPC and isolation test

#### Automated

- [ ] 1.1 Migration timestamp is later than every cloud-applied migration
- [ ] 1.2 Migration applies to the hosted project
- [ ] 1.3 Household isolation test passes, including all new S-03 blocks
- [ ] 1.4 Seed integrity test still passes unchanged

#### Manual

- [ ] 1.5 Deliberate-break check: an added grant makes the rolled-back isolation test fail descriptively
- [ ] 1.6 Migration header states the no-membership-FK warning and the S-08 hand-off

### Phase 2: App layer — types, services, `/plan` page, API, middleware, dashboard

#### Automated

- [ ] 2.1 Linting passes
- [ ] 2.2 Type checking passes
- [ ] 2.3 Production build succeeds
- [ ] 2.4 Existing smoke steps still pass against the preview

#### Manual

- [ ] 2.5 Fresh user sees the dated grid with Suggested/Other grouping and no Partner option
- [ ] 2.6 Saving 2 slots reads back on /plan and the dashboard
- [ ] 2.7 Whole-day shortcut sets every filled meal of that day
- [ ] 2.8 Clearing every slot leaves an empty saved plan
- [ ] 2.9 A new start date creates a second plan; the old one stays reachable
- [ ] 2.10 A tampered unknown recipe shows the KD011 message
- [ ] 2.11 With a read failing, no form is rendered

### Phase 3: Smoke test and documentation

#### Automated

- [ ] 3.1 Linting passes
- [ ] 3.2 Formatting is clean for docs
- [ ] 3.3 Full smoke run passes against the production preview
- [ ] 3.4 Isolation test still passes

#### Manual

- [ ] 3.5 Two-browser check: partner edits are visible to the other partner
- [ ] 3.6 Shared-file edits are self-contained S-03 blocks
