-- Household meal plans (roadmap S-03, PRD US-01 / FR-013–FR-016, FR-020): 3 consecutive days x 5
-- meals, any library recipe in any slot, each meal for one member or both, empty slots allowed.
--
-- Ownership class: HOUSEHOLD-SCOPED. Plans belong to the household ("linked accounts share plans"),
-- not to a person and not to the public library. Every table carries household_id (indexed) and the
-- four helper-predicate policies.
--
-- Shape: a DISH is one cooked batch of one recipe (plan_dishes); a MEAL is one filled slot that eats
-- from a dish (plan_meals). Empty slots are absent rows; a plan with zero meals is a valid saved plan.
--
-- S-08 hand-off (one dish across several days): plan_meals_dish_id_key below enforces one meal per
-- dish for S-03 only. S-08 runs
--   alter table public.plan_meals drop constraint plan_meals_dish_id_key;
-- adds an index on plan_meals (dish_id, plan_id) (the unique index currently covers that FK), and
-- widens save_meal_plan's payload so meals can name a shared dish. No data migration, and S-04's
-- solve output can attach batch quantities to plan_dishes from day one.
--
-- WARNING -- no membership FK on plan rows. plan_meals.eater_user_id names a person, but the row is
-- household-owned and must STAY in its household when that person redeems an invite. Never give it
-- the per-person composite (household_id, user_id) -> household_members ... on update cascade FK that
-- macro_targets uses (20261008120000_macro_targets.sql): redeem_household_invite()'s single membership
-- update would cascade into plan_meals.household_id, violate plan_meals_plan_fkey, and fail the
-- redemption with 23503 whenever the redeemer has a meal marked only for them. Eater membership is
-- checked at write time by save_meal_plan (KD012) instead. Plans stay behind in the redeemer's
-- preserved origin household, like all household data.
--
-- Write-revoked: clients keep SELECT only; all writes go through public.save_meal_plan. The four
-- policies per table exist for the household_id catch-all in supabase/tests/household_isolation.sql;
-- the revokes make the write policies unreachable. Both levers are load-bearing. MAINTAIN is revoked
-- too (PG17 default privileges grant it, see 20261008160000_library_revoke_maintain.sql).
--
-- Rejection SQLSTATEs (class KD), claimed here:
--   KD007  reused from S-01: no authenticated caller, or the caller has no household
--   KD010  malformed meals payload (not an array, > 15 entries, missing key, day_index outside 0-2,
--          unknown meal_type, non-uuid id, duplicate (day_index, meal_type), null start date)
--   KD011  a recipe_id is not in the library
--   KD012  a non-null eater_user_id is not a member of the caller's household
-- KD006 stays retired (F-04); KD008/KD009 belong to S-01.
--
-- Rollback: drop function public.save_meal_plan(date, jsonb), then drop table public.plan_meals,
-- public.plan_dishes, public.meal_plans (children first).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  -- day_index 0 is start_date; the plan covers start_date .. start_date + 2.
  start_date date not null,
  created_at timestamptz not null default now(),
  -- Bumped by every save_meal_plan call; "the most recently saved plan" orders by it.
  updated_at timestamptz not null default now(),
  -- Also the household_id index the CLAUDE.md rule requires (household_id is its leading column).
  constraint meal_plans_household_start_key unique (household_id, start_date),
  -- Composite FK target, so child rows can never name another household's plan.
  constraint meal_plans_id_household_key unique (id, household_id)
);

comment on table public.meal_plans is
  'Household 3-day meal plan (S-03). Written only by public.save_meal_plan; clients have SELECT only.';

create table public.plan_dishes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  plan_id uuid not null,
  recipe_id uuid not null references public.recipes on delete restrict,
  created_at timestamptz not null default now(),
  constraint plan_dishes_plan_fkey foreign key (plan_id, household_id)
    references public.meal_plans (id, household_id) on delete cascade,
  -- Composite FK target, so a meal can only eat from a dish of its own plan.
  constraint plan_dishes_id_plan_key unique (id, plan_id)
);

comment on table public.plan_dishes is
  'One cooked batch of one library recipe within a meal plan (S-03). S-08 lets several meals share one dish.';

create index plan_dishes_household_id_idx on public.plan_dishes (household_id);
create index plan_dishes_plan_household_idx on public.plan_dishes (plan_id, household_id);
create index plan_dishes_recipe_id_idx on public.plan_dishes (recipe_id);

create table public.plan_meals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  plan_id uuid not null,
  day_index smallint not null check (day_index between 0 and 2),
  meal_type public.meal_type not null,
  dish_id uuid not null,
  -- null = both / every current member. A plain auth.users FK, deliberately NOT the per-person
  -- (household_id, user_id) -> household_members membership FK: see the header WARNING. Deleting an
  -- account turns that person's meals into "both" rather than deleting slots or orphaning dishes.
  eater_user_id uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  constraint plan_meals_plan_fkey foreign key (plan_id, household_id)
    references public.meal_plans (id, household_id) on delete cascade,
  constraint plan_meals_dish_fkey foreign key (dish_id, plan_id)
    references public.plan_dishes (id, plan_id) on delete cascade,
  -- One meal per slot. Its leading plan_id also serves plan_meals_plan_fkey's lookups.
  constraint plan_meals_slot_key unique (plan_id, day_index, meal_type),
  -- S-03 only -- S-08 drops this (one dish shared by meals on several days).
  constraint plan_meals_dish_id_key unique (dish_id)
);

comment on table public.plan_meals is
  'One filled slot (day_index 0-2 x meal_type) of a meal plan, eating from one dish (S-03). eater_user_id null = both.';

create index plan_meals_household_id_idx on public.plan_meals (household_id);
create index plan_meals_eater_user_id_idx on public.plan_meals (eater_user_id);

-- ---------------------------------------------------------------------------
-- Row level security + grants (write-revoked, household_invites precedent).
-- ---------------------------------------------------------------------------
alter table public.meal_plans enable row level security;
alter table public.plan_dishes enable row level security;
alter table public.plan_meals enable row level security;

revoke all on public.meal_plans from anon;
revoke all on public.plan_dishes from anon;
revoke all on public.plan_meals from anon;
revoke insert, update, delete, truncate, references, trigger, maintain on public.meal_plans from authenticated;
revoke insert, update, delete, truncate, references, trigger, maintain on public.plan_dishes from authenticated;
revoke insert, update, delete, truncate, references, trigger, maintain on public.plan_meals from authenticated;

create policy "meal_plans_select_authenticated" on public.meal_plans
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "meal_plans_insert_authenticated" on public.meal_plans
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "meal_plans_update_authenticated" on public.meal_plans
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "meal_plans_delete_authenticated" on public.meal_plans
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

create policy "plan_dishes_select_authenticated" on public.plan_dishes
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "plan_dishes_insert_authenticated" on public.plan_dishes
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "plan_dishes_update_authenticated" on public.plan_dishes
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "plan_dishes_delete_authenticated" on public.plan_dishes
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

create policy "plan_meals_select_authenticated" on public.plan_meals
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "plan_meals_insert_authenticated" on public.plan_meals
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "plan_meals_update_authenticated" on public.plan_meals
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "plan_meals_delete_authenticated" on public.plan_meals
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- ---------------------------------------------------------------------------
-- save_meal_plan(): the single write path. Upserts the household's plan for p_start_date and applies
-- the grid as a slot-level diff, so unchanged slots keep their plan_meals / plan_dishes ids (S-04's
-- per-day solve results on untouched days survive an edit elsewhere).
--
-- p_meals: JSON array of at most 15
--   { "day_index": 0..2, "meal_type": "<meal_type>", "recipe_id": "<uuid>", "eater_user_id": "<uuid>" | null }
-- Every element is read as text and checked before any cast, so a bad uuid or enum label raises
-- KD010, never a bare 22P02. All validation runs before any write.
-- ---------------------------------------------------------------------------
create function public.save_meal_plan(p_start_date date, p_meals jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_household uuid;
  v_plan uuid;
  v_dish uuid;
  v_elem jsonb;
  v_days smallint[] := '{}';
  v_types public.meal_type[] := '{}';
  v_recipes uuid[] := '{}';
  v_eaters uuid[] := '{}';
  v_count int;
  i int;
begin
  -- 1. Resolve the caller's household once, before any write.
  select hid into v_household from private.user_household_ids() as hid limit 1;
  if (select auth.uid()) is null or v_household is null then
    raise exception 'no household for caller' using errcode = 'KD007';
  end if;

  -- 2a. Shape (KD010). Its own sub-block: any unexpected error while parsing is relabelled KD010,
  --     and the KD011/KD012 checks below sit outside it so this catch-all cannot swallow them.
  begin
    if p_start_date is null then
      raise exception 'start date is required' using errcode = 'KD010';
    end if;
    -- `is distinct from`, not `<>`: jsonb_typeof(null) is null, and a null payload must not slip
    -- through and wipe the plan.
    if jsonb_typeof(p_meals) is distinct from 'array' then
      raise exception 'meals payload is not an array' using errcode = 'KD010';
    end if;
    if jsonb_array_length(p_meals) > 15 then
      raise exception 'meals payload has more than 15 entries' using errcode = 'KD010';
    end if;

    for v_elem in select e from jsonb_array_elements(p_meals) as e loop
      if jsonb_typeof(v_elem) is distinct from 'object'
        or not (v_elem ? 'day_index' and v_elem ? 'meal_type' and v_elem ? 'recipe_id' and v_elem ? 'eater_user_id') then
        raise exception 'meal entry is not an object with day_index, meal_type, recipe_id and eater_user_id'
          using errcode = 'KD010';
      end if;
      if jsonb_typeof(v_elem -> 'day_index') is distinct from 'number'
        or (v_elem ->> 'day_index') !~ '^[0-2]$' then
        raise exception 'day_index must be 0, 1 or 2' using errcode = 'KD010';
      end if;
      if jsonb_typeof(v_elem -> 'meal_type') is distinct from 'string'
        or not ((v_elem ->> 'meal_type') = any (enum_range(null::public.meal_type)::text[])) then
        raise exception 'unknown meal_type' using errcode = 'KD010';
      end if;
      if jsonb_typeof(v_elem -> 'recipe_id') is distinct from 'string'
        or (v_elem ->> 'recipe_id') !~ v_uuid_re then
        raise exception 'recipe_id is not a uuid' using errcode = 'KD010';
      end if;
      if jsonb_typeof(v_elem -> 'eater_user_id') not in ('null', 'string')
        or (jsonb_typeof(v_elem -> 'eater_user_id') = 'string' and (v_elem ->> 'eater_user_id') !~ v_uuid_re) then
        raise exception 'eater_user_id is neither null nor a uuid' using errcode = 'KD010';
      end if;

      v_days := array_append(v_days, (v_elem ->> 'day_index')::smallint);
      v_types := array_append(v_types, (v_elem ->> 'meal_type')::public.meal_type);
      v_recipes := array_append(v_recipes, (v_elem ->> 'recipe_id')::uuid);
      v_eaters := array_append(v_eaters, (v_elem ->> 'eater_user_id')::uuid);
    end loop;

    select count(*) into v_count
    from (select distinct s.day_index, s.meal_type from unnest(v_days, v_types) as s(day_index, meal_type)) d;
    if v_count <> cardinality(v_days) then
      raise exception 'duplicate (day_index, meal_type) slot' using errcode = 'KD010';
    end if;
  exception
    when sqlstate 'KD010' then raise;
    when others then
      raise exception 'malformed meals payload: %', sqlerrm using errcode = 'KD010';
  end;

  -- 2b. Every recipe is in the library (KD011).
  if exists (
    select 1 from unnest(v_recipes) as r(recipe_id)
    where not exists (select 1 from public.recipes pr where pr.id = r.recipe_id)
  ) then
    raise exception 'unknown recipe' using errcode = 'KD011';
  end if;

  -- 2c. Every named eater is a member of the caller's household (KD012).
  if exists (
    select 1 from unnest(v_eaters) as e(user_id)
    where e.user_id is not null
      and not exists (
        select 1 from public.household_members hm
        where hm.household_id = v_household and hm.user_id = e.user_id
      )
  ) then
    raise exception 'eater is not a member of the household' using errcode = 'KD012';
  end if;

  -- 3. Upsert the plan. The conflict update takes the row lock, so two concurrent saves of the same
  --    plan serialise; the last writer wins.
  insert into public.meal_plans (household_id, start_date)
  values (v_household, p_start_date)
  on conflict (household_id, start_date) do update set updated_at = now()
  returning id into v_plan;

  -- 4. Slot-level diff.
  -- 4a. Meals whose slot is gone or whose recipe changed.
  delete from public.plan_meals m
  using public.plan_dishes d
  where m.plan_id = v_plan
    and d.id = m.dish_id
    and not exists (
      select 1 from unnest(v_days, v_types, v_recipes) as s(day_index, meal_type, recipe_id)
      where s.day_index = m.day_index and s.meal_type = m.meal_type and s.recipe_id = d.recipe_id
    );

  -- 4b. Eater-only changes keep the meal's id.
  update public.plan_meals m
  set eater_user_id = s.eater_user_id
  from unnest(v_days, v_types, v_eaters) as s(day_index, meal_type, eater_user_id)
  where m.plan_id = v_plan
    and m.day_index = s.day_index
    and m.meal_type = s.meal_type
    and m.eater_user_id is distinct from s.eater_user_id;

  -- 4c. A new dish + meal for every new or changed slot.
  for i in 1 .. cardinality(v_days) loop
    if not exists (
      select 1 from public.plan_meals m
      where m.plan_id = v_plan and m.day_index = v_days[i] and m.meal_type = v_types[i]
    ) then
      insert into public.plan_dishes (household_id, plan_id, recipe_id)
      values (v_household, v_plan, v_recipes[i])
      returning id into v_dish;

      insert into public.plan_meals (household_id, plan_id, day_index, meal_type, dish_id, eater_user_id)
      values (v_household, v_plan, v_days[i], v_types[i], v_dish, v_eaters[i]);
    end if;
  end loop;

  -- 4d. Dishes no meal eats from any more. Last, and by `not exists`, so it stays correct once S-08
  --     lets several meals share one dish.
  delete from public.plan_dishes d
  where d.plan_id = v_plan
    and not exists (select 1 from public.plan_meals m where m.dish_id = d.id);

  return v_plan;
end;
$$;

revoke execute on function public.save_meal_plan(date, jsonb) from public, anon;
grant execute on function public.save_meal_plan(date, jsonb) to authenticated;

comment on function public.save_meal_plan(date, jsonb) is
  'Saves the caller''s household meal plan for p_start_date as a slot-level diff (unchanged slots keep their ids). Rejects with KD007 (no caller/household), KD010 (malformed payload), KD011 (unknown recipe) or KD012 (eater not in the household).';
