-- Shared dish across days (roadmap S-08, PRD US-01 / FR-017): one cooked batch (plan_dishes row) may
-- feed meals on several days of one 3-day plan, and the days that share a batch are solved and stored
-- together as one SOLVE GROUP.
--
-- 1. plan_meals_dish_id_key (S-03's one-meal-per-dish rule) is dropped, as its own migration header
--    promised (20261008170000_meal_plans.sql). Its unique index was the only index with dish_id
--    leading, serving both the on-delete-cascade from plan_dishes and save_meal_plan's orphan probe,
--    so plan_meals_dish_plan_idx replaces it. No data migration: every existing dish has one meal.
-- 2. public.save_meal_plan is REPLACED (create or replace, so its grants and exact signature survive).
--    Each payload element may carry an optional "share_with": "<day_index>_<meal_type>" naming another
--    slot of the same payload; the slots joined (transitively) by share_with eat from ONE dish. Absent
--    or JSON null = a fresh batch, so a payload without the key behaves exactly as before. The slot
--    diff is now dish-identity aware: a meal whose grouping changed is replaced, like a recipe change.
-- 3. public.save_day_solution is DROPPED and replaced by public.save_plan_day_solutions, which writes
--    every day of a solve group in one statement. plan_day_solutions keeps exactly one write path; a
--    group's days share one fingerprint and one accepted tolerance, and a per-day RPC called once per
--    day could leave a group half-written.
--
-- Rejection SQLSTATEs (class KD). New here:
--   KD015  share_with is present but malformed: not a string of the form <0-2>_<meal_type>, or it
--          names the element's own slot
--   KD016  share_with names a slot that is not in the payload
--   KD017  share_with names a slot holding a different recipe_id
-- Reused: KD007 (no caller/household), KD010-KD012 (save_meal_plan, unchanged), KD013 (malformed
-- solutions argument), KD014 (no plan for that start date). KD006 stays retired (F-04).
--
-- Deploy order: this is a BREAKING change for the deployed Worker, which still calls the dropped
-- save_day_solution until the app half of S-08 deploys. Until then every Solve / Accept fails with the
-- app's "could not be solved right now" message; plan reads and saves are unaffected.
--
-- Rollback: drop function public.save_plan_day_solutions(date, jsonb); recreate
-- public.save_day_solution(date, int, text, int, text, jsonb) from 20261009120000_plan_day_solutions.sql
-- with its revoke/grant pair; create or replace public.save_meal_plan from
-- 20261008170000_meal_plans.sql; delete (or re-point to a fresh dish) every plan_meals row whose
-- dish_id is shared, then
--   alter table public.plan_meals add constraint plan_meals_dish_id_key unique (dish_id);
--   drop index public.plan_meals_dish_plan_idx;
-- The constraint cannot be restored while a shared dish exists.

-- ---------------------------------------------------------------------------
-- 1. One dish, several meals.
-- ---------------------------------------------------------------------------
alter table public.plan_meals drop constraint plan_meals_dish_id_key;

create index plan_meals_dish_plan_idx on public.plan_meals (dish_id, plan_id);

comment on table public.plan_meals is
  'One filled slot (day_index 0-2 x meal_type) of a meal plan, eating from one dish (S-03). Several meals of one plan may share a dish (S-08). eater_user_id null = both.';

comment on table public.plan_dishes is
  'One cooked batch of one library recipe within a meal plan (S-03). Meals on several days of the plan may eat from it (S-08); every meal of a dish has the dish''s recipe.';

comment on table public.plan_day_solutions is
  'Stored macro solve of one meal-plan day (S-04). The days that share a dish are solved and stored together (S-08). Written only by public.save_plan_day_solutions; clients have SELECT only.';

-- ---------------------------------------------------------------------------
-- 2. save_meal_plan(): the single write path for meal_plans / plan_dishes / plan_meals.
--
-- p_meals: JSON array of at most 15
--   { "day_index": 0..2, "meal_type": "<meal_type>", "recipe_id": "<uuid>", "eater_user_id": "<uuid>" | null,
--     "share_with": "<0-2>_<meal_type>" | null   -- optional }
-- Every element is read as text and checked before any cast, so a bad value raises a KD code, never a
-- bare 22P02. All validation runs before any write.
--
-- Grouping: share_with is an edge between two slots; union-find over the edges gives the groups, and
-- each group is exactly one dish. KD017 makes every member of a group hold the same recipe (equality is
-- transitive along the edges). A group's LABEL is its sorted member slots, "<day>_<meal_type>,...";
-- the diff compares a meal's existing label (the slots sharing its dish) with the desired one.
-- ---------------------------------------------------------------------------
create or replace function public.save_meal_plan(p_start_date date, p_meals jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_share_re text;
  v_household uuid;
  v_plan uuid;
  v_dish uuid;
  v_elem jsonb;
  v_days smallint[] := '{}';
  v_types public.meal_type[] := '{}';
  v_recipes uuid[] := '{}';
  v_eaters uuid[] := '{}';
  v_shares jsonb[] := '{}';
  v_parent int[] := '{}';
  v_roots int[] := '{}';
  v_labels text[] := '{}';
  v_share text;
  v_share_day smallint;
  v_share_type public.meal_type;
  v_count int;
  i int;
  j int;
  k int;
  a int;
  b int;
begin
  -- 1. Resolve the caller's household once, before any write.
  select hid into v_household from private.user_household_ids() as hid limit 1;
  if (select auth.uid()) is null or v_household is null then
    raise exception 'no household for caller' using errcode = 'KD007';
  end if;

  -- 2a. Shape (KD010). Its own sub-block: any unexpected error while parsing is relabelled KD010,
  --     and the KD011/KD012/KD015-KD017 checks below sit outside it so this catch-all cannot swallow them.
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
      -- Kept raw (absent = JSON null) and checked after KD010-KD012: KD015 is its own rule.
      v_shares := array_append(v_shares, coalesce(v_elem -> 'share_with', 'null'::jsonb));
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

  -- 2d. Grouping (KD015-KD017), then union-find. Still before any write.
  v_share_re := '^[0-2]_(' || array_to_string(enum_range(null::public.meal_type)::text[], '|') || ')$';
  for i in 1 .. cardinality(v_days) loop
    v_parent := array_append(v_parent, i);
  end loop;

  for i in 1 .. cardinality(v_days) loop
    continue when jsonb_typeof(v_shares[i]) = 'null';

    if jsonb_typeof(v_shares[i]) is distinct from 'string' or (v_shares[i] #>> '{}') !~ v_share_re then
      raise exception 'share_with must be "<0-2>_<meal_type>"' using errcode = 'KD015';
    end if;
    v_share := v_shares[i] #>> '{}';
    v_share_day := substr(v_share, 1, 1)::smallint;
    v_share_type := substr(v_share, 3)::public.meal_type;
    if v_share_day = v_days[i] and v_share_type = v_types[i] then
      raise exception 'share_with names the meal''s own slot' using errcode = 'KD015';
    end if;

    j := null;
    for k in 1 .. cardinality(v_days) loop
      if v_days[k] = v_share_day and v_types[k] = v_share_type then
        j := k;
      end if;
    end loop;
    if j is null then
      raise exception 'share_with names a slot that is not in the plan' using errcode = 'KD016';
    end if;
    if v_recipes[j] <> v_recipes[i] then
      raise exception 'share_with names a slot holding a different recipe' using errcode = 'KD017';
    end if;

    -- Union: find both roots, attach the larger index under the smaller.
    a := i;
    while v_parent[a] <> a loop a := v_parent[a]; end loop;
    b := j;
    while v_parent[b] <> b loop b := v_parent[b]; end loop;
    if a < b then
      v_parent[b] := a;
    elsif b < a then
      v_parent[a] := b;
    end if;
  end loop;

  for i in 1 .. cardinality(v_days) loop
    a := i;
    while v_parent[a] <> a loop a := v_parent[a]; end loop;
    v_roots := array_append(v_roots, a);
  end loop;

  -- Each element's desired group label: its group's member slots, sorted.
  select array_agg(lbl.label order by s.ord) into v_labels
  from unnest(v_roots) with ordinality as s(root, ord)
  cross join lateral (
    select string_agg(g.day_index::text || '_' || g.meal_type::text, ',' order by g.day_index, g.meal_type) as label
    from unnest(v_days, v_types, v_roots) as g(day_index, meal_type, root)
    where g.root = s.root
  ) lbl;
  v_labels := coalesce(v_labels, '{}');

  -- 3. Upsert the plan. The conflict update takes the row lock, so two concurrent saves of the same
  --    plan serialise; the last writer wins.
  insert into public.meal_plans (household_id, start_date)
  values (v_household, p_start_date)
  on conflict (household_id, start_date) do update set updated_at = now()
  returning id into v_plan;

  -- 4. Slot-level diff.
  -- 4a. Meals whose slot is gone, whose recipe changed, or whose grouping changed. ONE statement: the
  --     existing grouping (the slots sharing the meal's dish) is read from the statement snapshot, so
  --     the rows this delete removes cannot change the groupings it compares against. The comparison
  --     is symmetric, so afterwards every desired group is either wholly present or wholly absent.
  delete from public.plan_meals m
  using public.plan_dishes d
  where m.plan_id = v_plan
    and d.id = m.dish_id
    and not exists (
      select 1 from unnest(v_days, v_types, v_recipes, v_labels) as s(day_index, meal_type, recipe_id, label)
      where s.day_index = m.day_index and s.meal_type = m.meal_type and s.recipe_id = d.recipe_id
        and s.label = (
          select string_agg(m2.day_index::text || '_' || m2.meal_type::text, ',' order by m2.day_index, m2.meal_type)
          from public.plan_meals m2
          where m2.dish_id = m.dish_id
        )
    );

  -- 4b. Eater-only changes keep the meal's id.
  update public.plan_meals m
  set eater_user_id = s.eater_user_id
  from unnest(v_days, v_types, v_eaters) as s(day_index, meal_type, eater_user_id)
  where m.plan_id = v_plan
    and m.day_index = s.day_index
    and m.meal_type = s.meal_type
    and m.eater_user_id is distinct from s.eater_user_id;

  -- 4c. One new dish + one meal per member for every new or changed GROUP. By 4a's invariant, "the
  --     group's root slot has no meal" means "no member has one".
  for i in 1 .. cardinality(v_days) loop
    continue when v_roots[i] <> i;
    if not exists (
      select 1 from public.plan_meals m
      where m.plan_id = v_plan and m.day_index = v_days[i] and m.meal_type = v_types[i]
    ) then
      insert into public.plan_dishes (household_id, plan_id, recipe_id)
      values (v_household, v_plan, v_recipes[i])
      returning id into v_dish;

      for j in 1 .. cardinality(v_days) loop
        if v_roots[j] = i then
          insert into public.plan_meals (household_id, plan_id, day_index, meal_type, dish_id, eater_user_id)
          values (v_household, v_plan, v_days[j], v_types[j], v_dish, v_eaters[j]);
        end if;
      end loop;
    end if;
  end loop;

  -- 4d. Dishes no meal eats from any more. Last, and by `not exists`, so a dish several meals share
  --     survives as long as any of them does.
  delete from public.plan_dishes d
  where d.plan_id = v_plan
    and not exists (select 1 from public.plan_meals m where m.dish_id = d.id);

  return v_plan;
end;
$$;

revoke execute on function public.save_meal_plan(date, jsonb) from public, anon;
grant execute on function public.save_meal_plan(date, jsonb) to authenticated;

comment on function public.save_meal_plan(date, jsonb) is
  'Saves the caller''s household meal plan for p_start_date as a slot-level diff (unchanged slots keep their ids); slots joined by share_with eat from one dish. Rejects with KD007 (no caller/household), KD010 (malformed payload), KD011 (unknown recipe), KD012 (eater not in the household), KD015 (malformed or self-referencing share_with), KD016 (share_with names a slot not in the plan) or KD017 (share_with names a slot of a different recipe).';

-- ---------------------------------------------------------------------------
-- 3. save_plan_day_solutions(): the single write path for plan_day_solutions, replacing
-- save_day_solution. The solve runs in the app (pure TypeScript); this function only checks the shape
-- and upserts every day of the group for the caller's own plan in ONE statement.
--
-- p_solutions: JSON array of 1-3 objects with distinct day_index
--   { "day_index": 0..2, "status": "solved" | "needs_confirmation" | "no_fit",
--     "accepted_tolerance_pct": 10 | 15 | 20, "input_fingerprint": "<64 lowercase hex>",
--     "result": { ... } (at most 65 536 bytes) }
-- ---------------------------------------------------------------------------
drop function public.save_day_solution(date, int, text, int, text, jsonb);

create function public.save_plan_day_solutions(p_start_date date, p_solutions jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_plan uuid;
  v_elem jsonb;
  v_count int;
begin
  -- 1. Resolve the caller's household once, before any write.
  select hid into v_household from private.user_household_ids() as hid limit 1;
  if (select auth.uid()) is null or v_household is null then
    raise exception 'no household for caller' using errcode = 'KD007';
  end if;

  -- 2. Shape (KD013). Its own sub-block: any unexpected error while checking is relabelled KD013,
  --    and the KD014 check below sits outside it so this catch-all cannot swallow it.
  begin
    if p_start_date is null then
      raise exception 'start date is required' using errcode = 'KD013';
    end if;
    -- `is distinct from`: jsonb_typeof(null) is null.
    if jsonb_typeof(p_solutions) is distinct from 'array' then
      raise exception 'solutions payload is not an array' using errcode = 'KD013';
    end if;
    if jsonb_array_length(p_solutions) not between 1 and 3 then
      raise exception 'solutions payload must hold 1 to 3 days' using errcode = 'KD013';
    end if;

    for v_elem in select e from jsonb_array_elements(p_solutions) as e loop
      if jsonb_typeof(v_elem) is distinct from 'object'
        or not (v_elem ? 'day_index' and v_elem ? 'status' and v_elem ? 'accepted_tolerance_pct'
          and v_elem ? 'input_fingerprint' and v_elem ? 'result') then
        raise exception 'solution entry is not an object with day_index, status, accepted_tolerance_pct, input_fingerprint and result'
          using errcode = 'KD013';
      end if;
      if jsonb_typeof(v_elem -> 'day_index') is distinct from 'number'
        or (v_elem ->> 'day_index') !~ '^[0-2]$' then
        raise exception 'day_index must be 0, 1 or 2' using errcode = 'KD013';
      end if;
      if jsonb_typeof(v_elem -> 'status') is distinct from 'string'
        or (v_elem ->> 'status') not in ('solved', 'needs_confirmation', 'no_fit') then
        raise exception 'unknown status' using errcode = 'KD013';
      end if;
      if jsonb_typeof(v_elem -> 'accepted_tolerance_pct') is distinct from 'number'
        or (v_elem ->> 'accepted_tolerance_pct') not in ('10', '15', '20') then
        raise exception 'accepted tolerance must be 10, 15 or 20' using errcode = 'KD013';
      end if;
      if jsonb_typeof(v_elem -> 'input_fingerprint') is distinct from 'string'
        or (v_elem ->> 'input_fingerprint') !~ '^[0-9a-f]{64}$' then
        raise exception 'input fingerprint is not 64 lowercase hex characters' using errcode = 'KD013';
      end if;
      if jsonb_typeof(v_elem -> 'result') is distinct from 'object' then
        raise exception 'result is not a jsonb object' using errcode = 'KD013';
      end if;
      -- Per day, the same cap save_day_solution had.
      if octet_length((v_elem -> 'result')::text) > 65536 then
        raise exception 'result is larger than 65536 bytes' using errcode = 'KD013';
      end if;
    end loop;

    -- Distinct days: this is what makes the single upsert's conflict target safe below.
    select count(distinct e ->> 'day_index') into v_count from jsonb_array_elements(p_solutions) as e;
    if v_count <> jsonb_array_length(p_solutions) then
      raise exception 'duplicate day_index' using errcode = 'KD013';
    end if;
  exception
    when sqlstate 'KD013' then raise;
    when others then
      raise exception 'malformed solve result: %', sqlerrm using errcode = 'KD013';
  end;

  -- 3. The caller's household has a plan for that date (KD014).
  select mp.id into v_plan
  from public.meal_plans mp
  where mp.household_id = v_household and mp.start_date = p_start_date;
  if v_plan is null then
    raise exception 'no meal plan for that start date' using errcode = 'KD014';
  end if;

  -- 4. Upsert every day of the group in one statement. The conflict update takes the row locks; the
  --    last writer wins.
  insert into public.plan_day_solutions
    (household_id, plan_id, day_index, status, accepted_tolerance_pct, input_fingerprint, result)
  select v_household, v_plan, s.day_index, s.status, s.accepted_tolerance_pct, s.input_fingerprint, s.result
  from jsonb_to_recordset(p_solutions) as s(
    day_index smallint, status text, accepted_tolerance_pct smallint, input_fingerprint text, result jsonb)
  on conflict (plan_id, day_index) do update set
    status = excluded.status,
    accepted_tolerance_pct = excluded.accepted_tolerance_pct,
    input_fingerprint = excluded.input_fingerprint,
    result = excluded.result,
    solved_at = now();

  return v_plan;
end;
$$;

-- Mandatory, not cosmetic: dropping save_day_solution reset nothing for this NEW function, which
-- gets Supabase's default execute grant to public/anon.
revoke execute on function public.save_plan_day_solutions(date, jsonb) from public, anon;
grant execute on function public.save_plan_day_solutions(date, jsonb) to authenticated;

comment on function public.save_plan_day_solutions(date, jsonb) is
  'Stores the macro solve of every day of one solve group of the caller''s household meal plan for p_start_date in one statement (upsert on plan + day); returns the plan id. Rejects with KD007 (no caller/household), KD013 (malformed argument) or KD014 (no plan for that start date).';
