-- Household isolation test (roadmap F-01).
--
-- Proves the sign-up trigger and the household RLS pattern: each account gets exactly its own
-- household, can read only that household, cannot write membership tables directly, and anon
-- sees nothing. Everything runs in one transaction that is always rolled back.
--
-- Run: npm run test:rls   (supabase db query --linked -f supabase/tests/household_isolation.sql)
-- Targets the hosted project; the rollback means no test data is ever committed.
--
-- Template for later household-scoped tables: as postgres, seed a row for each household; then,
-- impersonating user A, assert A sees only its own rows and cannot read/write B's.
--
-- Three ownership classes (F-04): household-scoped tables (household_id + the helper predicate),
-- per-person tables (household-scoped, plus the owner predicate), and the PUBLIC LIBRARY (products,
-- recipes and their children): no household_id, one SELECT policy for authenticated, no client
-- writes. The classification catch-all below fails on any public table that fits none of them.
--
-- Impersonation:
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('sub', <uid>, 'role', 'authenticated')::text, true);
-- Switch back to postgres with `reset role`.

begin;

-- ---------------------------------------------------------------------------
-- Library snapshot (as postgres), taken BEFORE any sign-up: ordered `table=count;` string, so the
-- block after the inserts can prove that signing up creates no library rows (F-04).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n int;
  counts text := '';
begin
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I', t) into n;
    counts := counts || t || '=' || n || ';';
  end loop;
  perform set_config('rls_test.library_counts', counts, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Setup (as postgres): two accounts; the sign-up trigger creates their households.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-a000-00000000000a', 'user-a@rls-test.local', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000b', 'user-b@rls-test.local', 'authenticated', 'authenticated');

-- Trigger: exactly one membership each, in distinct households.
do $$
declare
  a_count int;
  b_count int;
  a_household uuid;
  b_household uuid;
begin
  select count(*), min(household_id::text)::uuid into a_count, a_household
  from public.household_members where user_id = '00000000-0000-4000-a000-00000000000a';
  select count(*), min(household_id::text)::uuid into b_count, b_household
  from public.household_members where user_id = '00000000-0000-4000-a000-00000000000b';

  if a_count <> 1 then
    raise exception 'trigger: user A has % memberships, expected 1', a_count;
  end if;
  if b_count <> 1 then
    raise exception 'trigger: user B has % memberships, expected 1', b_count;
  end if;
  if a_household = b_household then
    raise exception 'trigger: users A and B share household %, expected distinct households', a_household;
  end if;

  -- Expose the ids to later blocks (transaction-local settings are readable by any role).
  perform set_config('rls_test.a_household', a_household::text, true);
  perform set_config('rls_test.b_household', b_household::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Public library (F-04), as postgres: signing up created no library rows (no per-household seed
-- copy), then ONE non-seed fixture chain (product -> recipe -> component -> ingredient -> step) that
-- every authenticated user must see. Fixture ids: 00000000-0000-4000-b000-00000000c00<1..5>
-- (1 product, 2 recipe, 3 component, 4 ingredient, 5 step).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n int;
  counts text := '';
begin
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I', t) into n;
    counts := counts || t || '=' || n || ';';
  end loop;
  if counts <> current_setting('rls_test.library_counts') then
    raise exception 'sign-up: library counts changed from % to % -- the sign-up trigger must create no library rows',
      current_setting('rls_test.library_counts'), counts;
  end if;
end;
$$;

do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  b_household uuid := current_setting('rls_test.b_household')::uuid;
  t text;
  n int;
  counts text := '';
begin
  insert into public.products (id, name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, aisle)
  values ('00000000-0000-4000-b000-00000000c001', 'RLS test product', 100, 10, 2, 10, 'other');

  insert into public.recipes (id, name, cuisine, prep_minutes, division_mode)
  values ('00000000-0000-4000-b000-00000000c002', 'RLS test recipe', 'test', 10, 'whole_dish');

  insert into public.recipe_components (id, recipe_id, position, name)
  values ('00000000-0000-4000-b000-00000000c003', '00000000-0000-4000-b000-00000000c002', 1, 'C');

  insert into public.recipe_ingredients (id, component_id, product_id, position, base_amount_g)
  values ('00000000-0000-4000-b000-00000000c004', '00000000-0000-4000-b000-00000000c003',
    '00000000-0000-4000-b000-00000000c001', 1, 100);

  insert into public.recipe_steps (id, recipe_id, position, instruction, timing, component_id)
  values ('00000000-0000-4000-b000-00000000c005', '00000000-0000-4000-b000-00000000c002', 1,
    'Step C', 'fresh', '00000000-0000-4000-b000-00000000c003');

  -- Re-snapshot with the fixture chain included: this is what every authenticated user must see.
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I', t) into n;
    counts := counts || t || '=' || n || ';';
  end loop;
  perform set_config('rls_test.library_counts', counts, true);

  -- Invites (S-01), fixture ids …a006 / …b006. One live bearer code per household, so they
  -- occupy each household's household_invites_one_unredeemed_idx slot. Inserted as postgres because
  -- authenticated has no insert grant -- which the denial block below asserts.
  insert into public.household_invites (id, household_id, code, created_by, expires_at)
  values
    ('00000000-0000-4000-b000-00000000a006', a_household, 'a0a0a0a0a0a0a001',
      '00000000-0000-4000-a000-00000000000a', now() + interval '7 days'),
    ('00000000-0000-4000-b000-00000000b006', b_household, 'b0b0b0b0b0b0b002',
      '00000000-0000-4000-a000-00000000000b', now() + interval '7 days');

  -- Macro targets (S-02): one per-person row each. No id column, so these are keyed by user_id.
  insert into public.macro_targets (user_id, household_id, kcal, protein_g, fat_g, carbs_g)
  values
    ('00000000-0000-4000-a000-00000000000a', a_household, 2200, 160, 70, 230),
    ('00000000-0000-4000-a000-00000000000b', b_household, 1800, 120, 60, 180);

  -- Meal plans (S-03), fixture ids …a007 (plan) / …a017, …a027 (dishes) / …a037, …a047 (meals) for
  -- A, and …b007 / …b017 / …b037 for B. S-08 adds one SHARED dish on A's plan, …a057, eaten by two
  -- meals on different days, …a067 (day 0 lunch) and …a077 (day 1 lunch). A's plan leaves (2, dinner)
  -- free on purpose: the write-revoke probe below inserts there. Inserted as postgres: authenticated
  -- has no write grant on these tables.
  insert into public.meal_plans (id, household_id, start_date)
  values
    ('00000000-0000-4000-b000-00000000a007', a_household, '2030-01-01'),
    ('00000000-0000-4000-b000-00000000b007', b_household, '2030-01-01');

  insert into public.plan_dishes (id, household_id, plan_id, recipe_id)
  values
    ('00000000-0000-4000-b000-00000000a017', a_household, '00000000-0000-4000-b000-00000000a007',
      '5eed0002-0000-4000-8000-000000000001'),
    ('00000000-0000-4000-b000-00000000a027', a_household, '00000000-0000-4000-b000-00000000a007',
      '00000000-0000-4000-b000-00000000c002'),
    ('00000000-0000-4000-b000-00000000a057', a_household, '00000000-0000-4000-b000-00000000a007',
      '5eed0002-0000-4000-8000-000000000003'),
    ('00000000-0000-4000-b000-00000000b017', b_household, '00000000-0000-4000-b000-00000000b007',
      '5eed0002-0000-4000-8000-000000000001');

  insert into public.plan_meals (id, household_id, plan_id, day_index, meal_type, dish_id, eater_user_id)
  values
    ('00000000-0000-4000-b000-00000000a037', a_household, '00000000-0000-4000-b000-00000000a007',
      0, 'breakfast', '00000000-0000-4000-b000-00000000a017', null),
    ('00000000-0000-4000-b000-00000000a047', a_household, '00000000-0000-4000-b000-00000000a007',
      1, 'dinner', '00000000-0000-4000-b000-00000000a027', '00000000-0000-4000-a000-00000000000a'),
    ('00000000-0000-4000-b000-00000000a067', a_household, '00000000-0000-4000-b000-00000000a007',
      0, 'lunch', '00000000-0000-4000-b000-00000000a057', null),
    ('00000000-0000-4000-b000-00000000a077', a_household, '00000000-0000-4000-b000-00000000a007',
      1, 'lunch', '00000000-0000-4000-b000-00000000a057', null),
    ('00000000-0000-4000-b000-00000000b037', b_household, '00000000-0000-4000-b000-00000000b007',
      0, 'lunch', '00000000-0000-4000-b000-00000000b017', null);

  -- Shopping-list checks (S-09): one row on each fixture plan, both for the first product (by id) of
  -- seed recipe …0001, which both plans cook. Keyed by (plan_id, product_id), so no id column.
  -- Inserted as postgres: authenticated has no write grant on this table.
  insert into public.shopping_list_checks (household_id, plan_id, product_id)
  select hh, plan, (
    select ri.product_id
    from public.recipe_ingredients ri
    join public.recipe_components rc on rc.id = ri.component_id
    where rc.recipe_id = '5eed0002-0000-4000-8000-000000000001'
    order by ri.product_id
    limit 1)
  from (values
    (a_household, '00000000-0000-4000-b000-00000000a007'::uuid),
    (b_household, '00000000-0000-4000-b000-00000000b007'::uuid)) as f(hh, plan);
end;
$$;

-- Meal plans (S-03), as postgres: the composite FKs keep every child row inside its plan's
-- household and a meal inside its dish's plan. Each probe uses a free slot and an unused dish, so
-- the only thing that can stop it is the FK under test.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  b_household uuid := current_setting('rls_test.b_household')::uuid;
begin
  begin
    insert into public.plan_dishes (household_id, plan_id, recipe_id)
    values (a_household, '00000000-0000-4000-b000-00000000b007', '5eed0002-0000-4000-8000-000000000001');
    raise exception 'plans: a plan_dishes row with A''s household_id could name B''s plan';
  exception when foreign_key_violation then null;
  end;

  -- An unused dish in B's plan, for the two meal probes below.
  insert into public.plan_dishes (id, household_id, plan_id, recipe_id)
  values ('00000000-0000-4000-b000-00000000b027', b_household, '00000000-0000-4000-b000-00000000b007',
    '5eed0002-0000-4000-8000-000000000001');

  begin
    insert into public.plan_meals (household_id, plan_id, day_index, meal_type, dish_id)
    values (a_household, '00000000-0000-4000-b000-00000000b007', 2, 'dinner',
      '00000000-0000-4000-b000-00000000b027');
    raise exception 'plans: a plan_meals row with A''s household_id could name B''s plan';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into public.plan_meals (household_id, plan_id, day_index, meal_type, dish_id)
    values (a_household, '00000000-0000-4000-b000-00000000a007', 2, 'dinner',
      '00000000-0000-4000-b000-00000000b027');
    raise exception 'plans: a plan_meals row could eat from a dish of another plan';
  exception when foreign_key_violation then null;
  end;

  delete from public.plan_dishes where id = '00000000-0000-4000-b000-00000000b027';

  -- S-08, the mirror of the probe above: a meal on ANOTHER DAY of the SAME plan may eat from a dish
  -- that already feeds a meal (…a017 feeds A's day 0 breakfast). This is the direct regression guard
  -- for the dropped plan_meals_dish_id_key; any error here fails the test.
  insert into public.plan_meals (id, household_id, plan_id, day_index, meal_type, dish_id)
  values ('00000000-0000-4000-b000-00000000a087', a_household, '00000000-0000-4000-b000-00000000a007',
    2, 'breakfast', '00000000-0000-4000-b000-00000000a017');
  delete from public.plan_meals where id = '00000000-0000-4000-b000-00000000a087';
end;
$$;

-- As postgres: a product still used by an ingredient cannot be deleted (on delete restrict raises
-- foreign_key_violation; restrict_violation is accepted too), so removing a library product can
-- never silently break a recipe.
do $$
begin
  delete from public.products where id = '00000000-0000-4000-b000-00000000c001';
  raise exception 'library: a product still used by an ingredient could be deleted';
exception when restrict_violation or foreign_key_violation then null;
end;
$$;

-- ---------------------------------------------------------------------------
-- As user A: reads are scoped to A's household.
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000a', 'role', 'authenticated')::text,
  true
);

do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  b_household uuid := current_setting('rls_test.b_household')::uuid;
  n int;
begin
  select count(*) into n from public.households;
  if n <> 1 then
    raise exception 'read: user A sees % households, expected 1', n;
  end if;

  select count(*) into n from public.households where id = a_household;
  if n <> 1 then
    raise exception 'read: user A cannot see own household %', a_household;
  end if;

  select count(*) into n from public.households where id = b_household;
  if n <> 0 then
    raise exception 'read: user A can see household % of user B', b_household;
  end if;

  select count(*) into n from public.household_members where household_id <> a_household;
  if n <> 0 then
    raise exception 'read: user A sees % membership rows of other households', n;
  end if;

  select count(*) into n from public.household_members where user_id = '00000000-0000-4000-a000-00000000000a';
  if n <> 1 then
    raise exception 'read: user A sees % own membership rows, expected 1', n;
  end if;
end;
$$;

-- As user A: the access helper returns only A's household.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  ids uuid[];
begin
  select array_agg(id) into ids from private.user_household_ids() as id;
  if ids is distinct from array[a_household] then
    raise exception 'helper: user_household_ids() returned %, expected {%}', ids, a_household;
  end if;
end;
$$;

-- As user A: direct writes on both tables are denied.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  b_household uuid := current_setting('rls_test.b_household')::uuid;
  n int;
begin
  begin
    insert into public.households default values;
    raise exception 'write: user A could insert into households';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.households set created_at = now() where id = a_household;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'write: user A updated % own households rows', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.households where id = a_household;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'write: user A deleted % own households rows', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    -- Joining B's household directly must be impossible.
    insert into public.household_members (household_id, user_id)
    values (b_household, '00000000-0000-4000-a000-00000000000a');
    raise exception 'write: user A could insert into household_members';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.household_members set household_id = b_household
    where user_id = '00000000-0000-4000-a000-00000000000a';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'write: user A updated % own household_members rows', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.household_members where user_id = '00000000-0000-4000-a000-00000000000a';
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'write: user A deleted % own household_members rows', n;
    end if;
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- As user A: household_invites is scoped to A's household (explicit fixture ids …a006 / …b006).
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  n int;
begin
  select count(*) into n from public.household_invites where household_id <> a_household;
  if n <> 0 then
    raise exception 'read: user A sees % public.household_invites rows of other households; every row must have household_id = a_household', n;
  end if;

  select count(*) into n from public.household_invites where id = '00000000-0000-4000-b000-00000000b006';
  if n <> 0 then
    raise exception 'read: user A can see B''s fixture invite; B''s fixture ids must be invisible';
  end if;

  select count(*) into n from public.household_invites where id = '00000000-0000-4000-b000-00000000a006';
  if n <> 1 then
    raise exception 'read: user A cannot see own fixture invite';
  end if;
end;
$$;

-- As user A: the whole public library is visible -- every row, including the non-seed fixture chain.
do $$
declare
  t text;
  n int;
  counts text := '';
begin
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I', t) into n;
    counts := counts || t || '=' || n || ';';
  end loop;
  if counts <> current_setting('rls_test.library_counts') then
    raise exception 'library: user A sees % but the library holds % -- every authenticated user must see the whole library',
      counts, current_setting('rls_test.library_counts');
  end if;

  select count(*) into n from public.products
  where id in ('00000000-0000-4000-b000-00000000c001', '5eed0001-0000-4000-8000-000000000001');
  if n <> 2 then
    raise exception 'library: user A sees % of the fixture and first seed product, expected 2', n;
  end if;
  select count(*) into n from public.recipes where id = '00000000-0000-4000-b000-00000000c002';
  if n <> 1 then
    raise exception 'library: user A cannot see the fixture recipe';
  end if;
end;
$$;

-- As user A: no client writes to the library, on any table. The insert probes use valid values, so
-- a missing revoke AND a missing RLS denial would make the insert SUCCEED rather than fail on a
-- constraint; no handler other than insufficient_privilege on purpose (macro_targets style).
-- update/delete may raise insufficient_privilege or affect 0 rows; truncate must raise.
do $$
declare
  t text;
  n int;
begin
  begin
    insert into public.products (name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, aisle)
    values ('RLS probe product', 100, 10, 2, 10, 'other');
    raise exception 'library write: user A could insert into public.products';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.recipes (name, cuisine, prep_minutes, division_mode)
    values ('RLS probe recipe', 'test', 10, 'whole_dish');
    raise exception 'library write: user A could insert into public.recipes';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.recipe_components (recipe_id, position, name)
    values ('00000000-0000-4000-b000-00000000c002', 99, 'probe');
    raise exception 'library write: user A could insert into public.recipe_components';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.recipe_ingredients (component_id, product_id, position, base_amount_g)
    values ('00000000-0000-4000-b000-00000000c003', '00000000-0000-4000-b000-00000000c001', 99, 100);
    raise exception 'library write: user A could insert into public.recipe_ingredients';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.recipe_steps (recipe_id, position, instruction, timing)
    values ('00000000-0000-4000-b000-00000000c002', 99, 'probe', 'fresh');
    raise exception 'library write: user A could insert into public.recipe_steps';
  exception when insufficient_privilege then null;
  end;

  -- Seed rows (5eed…) and the fixture chain (…c00N) alike.
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    begin
      execute format(
        'update public.%I set created_at = now() where id::text like ''5eed%%'' or id::text like ''00000000-0000-4000-b000-00000000c00%%''',
        t);
      get diagnostics n = row_count;
      if n <> 0 then
        raise exception 'library write: user A updated % public.% rows', n, t;
      end if;
    exception when insufficient_privilege then null;
    end;

    begin
      execute format(
        'delete from public.%I where id::text like ''5eed%%'' or id::text like ''00000000-0000-4000-b000-00000000c00%%''',
        t);
      get diagnostics n = row_count;
      if n <> 0 then
        raise exception 'library write: user A deleted % public.% rows', n, t;
      end if;
    exception when insufficient_privilege then null;
    end;

    begin
      execute format('truncate public.%I cascade', t);
      raise exception 'library write: user A could truncate public.%', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$$;

-- As user A: macro targets (S-02) are per person. Reads are household-scoped; writes also require
-- user_id = auth.uid(). The catch-all below checks the helper predicate but NOT the owner
-- predicate, so the insert probes here must require exactly insufficient_privilege: with A's own
-- household the owner predicate is the only thing that can raise it.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  b_household uuid := current_setting('rls_test.b_household')::uuid;
  n int;
begin
  select count(*) into n from public.macro_targets;
  if n <> 1 then
    raise exception 'targets: user A sees % macro_targets rows, expected exactly its own 1', n;
  end if;

  select count(*) into n from public.macro_targets where user_id = '00000000-0000-4000-a000-00000000000a';
  if n <> 1 then
    raise exception 'targets: user A cannot see its own macro_targets row';
  end if;

  select count(*) into n from public.macro_targets where user_id = '00000000-0000-4000-a000-00000000000b';
  if n <> 0 then
    raise exception 'targets: user A can see user B''s macro_targets row';
  end if;

  update public.macro_targets set kcal = 1 where user_id = '00000000-0000-4000-a000-00000000000b';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'targets: user A updated % of user B''s macro_targets rows', n;
  end if;

  delete from public.macro_targets where user_id = '00000000-0000-4000-a000-00000000000b';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'targets: user A deleted % of user B''s macro_targets rows', n;
  end if;

  -- No other handler on purpose: a unique_violation or foreign_key_violation here would mean the
  -- owner predicate is gone and only fixture ordering stopped the write.
  begin
    insert into public.macro_targets (user_id, household_id, kcal, protein_g, fat_g, carbs_g)
    values ('00000000-0000-4000-a000-00000000000b', a_household, 2000, 100, 50, 200);
    raise exception 'targets: user A could insert a macro_targets row for user B in A''s household';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.macro_targets (user_id, household_id, kcal, protein_g, fat_g, carbs_g)
    values ('00000000-0000-4000-a000-00000000000b', b_household, 2000, 100, 50, 200);
    raise exception 'targets: user A could insert a macro_targets row for user B in B''s household';
  exception when insufficient_privilege then null;
  end;

  update public.macro_targets set kcal = 2100, updated_at = now()
  where user_id = '00000000-0000-4000-a000-00000000000a';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'targets: user A updated % own macro_targets rows, expected 1', n;
  end if;
end;
$$;

-- As user A: meal plans (S-03) are household-scoped -- exactly A's fixture rows, none of B's.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  n int;
begin
  select count(*) into n from public.meal_plans;
  if n <> 1 then
    raise exception 'plans: user A sees % meal_plans rows, expected exactly its own 1', n;
  end if;
  select count(*) into n from public.meal_plans where id = '00000000-0000-4000-b000-00000000a007';
  if n <> 1 then
    raise exception 'plans: user A cannot see its own fixture plan';
  end if;

  select count(*) into n from public.plan_dishes;
  if n <> 3 then
    raise exception 'plans: user A sees % plan_dishes rows, expected exactly its own 3', n;
  end if;
  select count(*) into n from public.plan_dishes where household_id <> a_household;
  if n <> 0 then
    raise exception 'plans: user A sees % plan_dishes rows of other households', n;
  end if;

  select count(*) into n from public.plan_meals;
  if n <> 4 then
    raise exception 'plans: user A sees % plan_meals rows, expected exactly its own 4', n;
  end if;
  select count(*) into n from public.plan_meals where dish_id = '00000000-0000-4000-b000-00000000a057';
  if n <> 2 then
    raise exception 'plans: user A sees % meals eating from its shared fixture dish, expected 2', n;
  end if;
  select count(*) into n from public.plan_meals
  where id in ('00000000-0000-4000-b000-00000000b037')
     or plan_id = '00000000-0000-4000-b000-00000000b007';
  if n <> 0 then
    raise exception 'plans: user A can see B''s fixture meal';
  end if;
end;
$$;

-- As user A: meal plans are write-revoked (writes only via public.save_meal_plan). The insert probes
-- use valid values in A's own household, so the policies alone would ALLOW them: only the revoke can
-- raise insufficient_privilege, and no other handler is accepted on purpose. update/delete may raise
-- or affect 0 rows; truncate must raise.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  t text;
  n int;
begin
  begin
    insert into public.meal_plans (household_id, start_date) values (a_household, '2030-03-01');
    raise exception 'plans: user A could insert into public.meal_plans directly';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.plan_dishes (household_id, plan_id, recipe_id)
    values (a_household, '00000000-0000-4000-b000-00000000a007', '5eed0002-0000-4000-8000-000000000002');
    raise exception 'plans: user A could insert into public.plan_dishes directly';
  exception when insufficient_privilege then null;
  end;

  begin
    -- Valid values: a free slot (2, dinner) and a dish of A's own plan. Since S-08 dropped
    -- plan_meals_dish_id_key no constraint stands in the way, so this probe rests on the revoke alone;
    -- a regressed revoke makes the insert succeed and the raise below fail the test as P0001.
    insert into public.plan_meals (household_id, plan_id, day_index, meal_type, dish_id)
    values (a_household, '00000000-0000-4000-b000-00000000a007', 2, 'dinner',
      '00000000-0000-4000-b000-00000000a017');
    raise exception 'plans: user A could insert into public.plan_meals directly';
  exception when insufficient_privilege then null;
  end;

  foreach t in array array['meal_plans', 'plan_dishes', 'plan_meals'] loop
    begin
      execute format('update public.%I set created_at = now() where household_id = %L', t, a_household);
      get diagnostics n = row_count;
      if n <> 0 then
        raise exception 'plans: user A updated % own public.% rows directly', n, t;
      end if;
    exception when insufficient_privilege then null;
    end;

    begin
      execute format('delete from public.%I where household_id = %L', t, a_household);
      get diagnostics n = row_count;
      if n <> 0 then
        raise exception 'plans: user A deleted % own public.% rows directly', n, t;
      end if;
    exception when insufficient_privilege then null;
    end;

    begin
      execute format('truncate public.%I cascade', t);
      raise exception 'plans: user A could truncate public.%', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$$;

-- As user A: save_meal_plan behaviour. Every save uses a start_date distinct from the 2030-01-01
-- fixtures, so the exact-count read assertions above do not depend on block order.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  plan uuid;
  plan2 uuid;
  keep_meal uuid;
  lunch_meal uuid;
  old_dish uuid;
  n int;
  eater uuid;
begin
  plan := public.save_meal_plan('2030-02-01', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'breakfast',
      'recipe_id', '5eed0002-0000-4000-8000-000000000001', 'eater_user_id', null),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000002', 'eater_user_id', '00000000-0000-4000-a000-00000000000a')));

  select count(*) into n from public.meal_plans
  where id = plan and household_id = a_household and start_date = '2030-02-01';
  if n <> 1 then
    raise exception 'plans[rpc]: save_meal_plan returned %, which is not A''s 2030-02-01 plan', plan;
  end if;
  select count(*) into n from public.plan_meals where plan_id = plan and household_id = a_household;
  if n <> 2 then
    raise exception 'plans[rpc]: first save wrote % meals, expected 2', n;
  end if;
  select count(*) into n from public.plan_dishes where plan_id = plan and household_id = a_household;
  if n <> 2 then
    raise exception 'plans[rpc]: first save wrote % dishes, expected 2', n;
  end if;

  select id into keep_meal from public.plan_meals where plan_id = plan and day_index = 0 and meal_type = 'breakfast';
  select m.id, m.dish_id into lunch_meal, old_dish from public.plan_meals m
  where m.plan_id = plan and m.day_index = 1 and m.meal_type = 'lunch';

  -- Re-save changing only the lunch recipe: breakfast keeps its id, lunch gets a new meal and dish,
  -- and the orphaned dish is gone.
  plan2 := public.save_meal_plan('2030-02-01', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'breakfast',
      'recipe_id', '5eed0002-0000-4000-8000-000000000001', 'eater_user_id', null),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000003', 'eater_user_id', '00000000-0000-4000-a000-00000000000a')));
  if plan2 <> plan then
    raise exception 'plans[rpc]: re-saving the same start date returned plan %, expected %', plan2, plan;
  end if;
  select count(*) into n from public.plan_meals where id = keep_meal;
  if n <> 1 then
    raise exception 'plans[rpc]: an unchanged slot lost its plan_meals id on re-save';
  end if;
  select count(*) into n from public.plan_meals where id = lunch_meal;
  if n <> 0 then
    raise exception 'plans[rpc]: a slot whose recipe changed kept its old meal row';
  end if;
  select count(*) into n from public.plan_dishes where id = old_dish;
  if n <> 0 then
    raise exception 'plans[rpc]: the dish of a replaced recipe was left behind with no meal';
  end if;
  select count(*) into n from public.plan_dishes where plan_id = plan;
  if n <> 2 then
    raise exception 'plans[rpc]: after the recipe change the plan has % dishes, expected 2', n;
  end if;
  select count(*) into n from public.plan_meals m join public.plan_dishes d on d.id = m.dish_id
  where m.plan_id = plan and m.day_index = 1 and m.meal_type = 'lunch'
    and d.recipe_id = '5eed0002-0000-4000-8000-000000000003';
  if n <> 1 then
    raise exception 'plans[rpc]: the changed lunch slot does not eat from the new recipe';
  end if;

  -- Eater-only change: the meal keeps its id.
  perform public.save_meal_plan('2030-02-01', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'breakfast',
      'recipe_id', '5eed0002-0000-4000-8000-000000000001', 'eater_user_id', '00000000-0000-4000-a000-00000000000a'),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000003', 'eater_user_id', '00000000-0000-4000-a000-00000000000a')));
  select eater_user_id into eater from public.plan_meals where id = keep_meal;
  if not found then
    raise exception 'plans[rpc]: an eater-only change replaced the meal row instead of updating it';
  end if;
  if eater is distinct from '00000000-0000-4000-a000-00000000000a' then
    raise exception 'plans[rpc]: eater-only change left eater_user_id = %, expected user A', eater;
  end if;

  -- Empty save: the plan stays, with no meals and no dishes.
  perform public.save_meal_plan('2030-02-01', '[]'::jsonb);
  select count(*) into n from public.meal_plans where id = plan;
  if n <> 1 then
    raise exception 'plans[rpc]: an empty save removed the plan row';
  end if;
  select count(*) into n from public.plan_meals where plan_id = plan;
  if n <> 0 then
    raise exception 'plans[rpc]: an empty save left % meals', n;
  end if;
  select count(*) into n from public.plan_dishes where plan_id = plan;
  if n <> 0 then
    raise exception 'plans[rpc]: an empty save left % dishes', n;
  end if;
end;
$$;

-- As user A: save_meal_plan with shared dishes (S-08), on its own 2030-02-03 plan. share_with names
-- ANOTHER slot; the slots it joins eat from one dish. Covers create (the share_with round-trip pin),
-- a no-op re-save in either direction, an eater-only change, a split, a merge, a transitive group of
-- three and orphan cleanup after every regroup.
do $$
declare
  rec_a constant text := '5eed0002-0000-4000-8000-000000000001';
  rec_b constant text := '5eed0002-0000-4000-8000-000000000002';
  plan uuid;
  breakfast_meal uuid;
  lunch0 uuid;
  lunch1 uuid;
  shared_dish uuid;
  dish0 uuid;
  dish1 uuid;
  n int;
begin
  -- Create: day 1 lunch shares day 0 lunch's batch -> 3 meals, 2 dishes, both lunches on one dish.
  plan := public.save_meal_plan('2030-02-03', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'breakfast', 'recipe_id', rec_a, 'eater_user_id', null),
    jsonb_build_object('day_index', 0, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null,
      'share_with', '0_lunch')));
  select count(*) into n from public.plan_meals where plan_id = plan;
  if n <> 3 then
    raise exception 'plans[share]: creating a shared batch wrote % meals, expected 3', n;
  end if;
  select count(*) into n from public.plan_dishes where plan_id = plan;
  if n <> 2 then
    raise exception 'plans[share]: creating a shared batch wrote % dishes, expected 2 (one shared)', n;
  end if;
  select id into breakfast_meal from public.plan_meals where plan_id = plan and day_index = 0 and meal_type = 'breakfast';
  select id, dish_id into lunch0, dish0 from public.plan_meals where plan_id = plan and day_index = 0 and meal_type = 'lunch';
  select id, dish_id into lunch1, dish1 from public.plan_meals where plan_id = plan and day_index = 1 and meal_type = 'lunch';
  if dish0 is distinct from dish1 then
    raise exception 'plans[share]: share_with "0_lunch" did not put day 0 and day 1 lunch on one dish';
  end if;
  select count(*) into n from public.plan_dishes where id = dish0 and recipe_id = rec_b::uuid;
  if n <> 1 then
    raise exception 'plans[share]: the shared dish does not hold the shared recipe';
  end if;
  shared_dish := dish0;

  -- No-op re-saves: the same grouping, named from the other side, and an eater-only change on one
  -- member all keep every meal and dish id.
  perform public.save_meal_plan('2030-02-03', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'breakfast', 'recipe_id', rec_a, 'eater_user_id', null),
    jsonb_build_object('day_index', 0, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null,
      'share_with', '1_lunch'),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch', 'recipe_id', rec_b,
      'eater_user_id', '00000000-0000-4000-a000-00000000000a')));
  select count(*) into n from public.plan_meals
  where id in (breakfast_meal, lunch0, lunch1) and plan_id = plan;
  if n <> 3 then
    raise exception 'plans[share]: re-saving an unchanged grouping replaced % of 3 meal rows', 3 - n;
  end if;
  select count(*) into n from public.plan_meals where id in (lunch0, lunch1) and dish_id = shared_dish;
  if n <> 2 then
    raise exception 'plans[share]: re-saving an unchanged grouping moved a lunch off the shared dish';
  end if;
  select count(*) into n from public.plan_meals
  where id = lunch1 and eater_user_id = '00000000-0000-4000-a000-00000000000a';
  if n <> 1 then
    raise exception 'plans[share]: an eater-only change on a shared meal did not update it in place';
  end if;

  -- Split: no share_with -> two fresh lunch dishes, both lunch meal ids replaced, the old shared dish
  -- cleaned up, breakfast untouched.
  perform public.save_meal_plan('2030-02-03', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'breakfast', 'recipe_id', rec_a, 'eater_user_id', null),
    jsonb_build_object('day_index', 0, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch', 'recipe_id', rec_b,
      'eater_user_id', '00000000-0000-4000-a000-00000000000a')));
  select count(*) into n from public.plan_dishes where plan_id = plan;
  if n <> 3 then
    raise exception 'plans[split]: splitting a shared batch left % dishes, expected 3', n;
  end if;
  select count(*) into n from public.plan_meals where id in (lunch0, lunch1);
  if n <> 0 then
    raise exception 'plans[split]: % lunch meals kept their ids although their grouping changed', n;
  end if;
  select count(*) into n from public.plan_dishes where id = shared_dish;
  if n <> 0 then
    raise exception 'plans[split]: the formerly shared dish was left behind with no meal';
  end if;
  select count(*) into n from public.plan_meals where id = breakfast_meal;
  if n <> 1 then
    raise exception 'plans[split]: regrouping the lunches replaced the untouched breakfast';
  end if;
  select count(*) into n from public.plan_meals
  where plan_id = plan and meal_type = 'lunch' and eater_user_id = '00000000-0000-4000-a000-00000000000a';
  if n <> 1 then
    raise exception 'plans[split]: the day 1 lunch lost its eater when it was split off';
  end if;
  select m0.dish_id, m1.dish_id into dish0, dish1
  from public.plan_meals m0, public.plan_meals m1
  where m0.plan_id = plan and m0.day_index = 0 and m0.meal_type = 'lunch'
    and m1.plan_id = plan and m1.day_index = 1 and m1.meal_type = 'lunch';
  if dish0 = dish1 then
    raise exception 'plans[split]: the split lunches still eat from one dish';
  end if;

  -- Merge + transitivity: day 2 lunch shares day 1, day 1 shares day 0 -> one dish for all three
  -- lunches; the two separate lunch dishes are cleaned up.
  perform public.save_meal_plan('2030-02-03', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'breakfast', 'recipe_id', rec_a, 'eater_user_id', null),
    jsonb_build_object('day_index', 0, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null,
      'share_with', '0_lunch'),
    jsonb_build_object('day_index', 2, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null,
      'share_with', '1_lunch')));
  select count(*) into n from public.plan_dishes where plan_id = plan;
  if n <> 2 then
    raise exception 'plans[merge]: merging three lunches left % dishes, expected 2', n;
  end if;
  select count(distinct dish_id) into n from public.plan_meals where plan_id = plan and meal_type = 'lunch';
  if n <> 1 then
    raise exception 'plans[merge]: the three transitively shared lunches eat from % dishes, expected 1', n;
  end if;
  select count(*) into n from public.plan_dishes where id in (dish0, dish1);
  if n <> 0 then
    raise exception 'plans[merge]: % of the two separate lunch dishes were left behind after the merge', n;
  end if;

  -- A mutual pair (each names the other) is one group, not an error.
  perform public.save_meal_plan('2030-02-03', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null,
      'share_with', '2_lunch'),
    jsonb_build_object('day_index', 2, 'meal_type', 'lunch', 'recipe_id', rec_b, 'eater_user_id', null,
      'share_with', '0_lunch')));
  select count(*) into n from public.plan_dishes where plan_id = plan;
  if n <> 1 then
    raise exception 'plans[share]: a mutual share_with pair left % dishes, expected 1', n;
  end if;
  select count(*) into n from public.plan_meals where plan_id = plan;
  if n <> 2 then
    raise exception 'plans[share]: a mutual share_with pair left % meals, expected 2', n;
  end if;
end;
$$;

-- As user A: save_meal_plan rejections, one SQLSTATE each (when others + P0001 re-raise idiom, see
-- the redemption rejections below). B is not in A's household, so it is the KD012 probe.
do $$
declare
  ok constant text := '{"day_index":0,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":null}';
  cases text[][] := array[
    -- start date, payload, expected SQLSTATE, what the case proves
    array['2030-02-02', '[{"day_index":3,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":null}]',
      'KD010', 'day_index 3 was accepted'],
    array['2030-02-02', '[' || ok || ',' || ok || ']', 'KD010', 'a duplicate slot was accepted'],
    array['2030-02-02', '[{"day_index":0,"meal_type":"brunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":null}]',
      'KD010', 'an unknown meal_type was accepted'],
    array['2030-02-02', '[{"day_index":0,"meal_type":"lunch","recipe_id":"not-a-uuid","eater_user_id":null}]',
      'KD010', 'a non-uuid recipe_id was accepted'],
    array['2030-02-02', '[{"day_index":0,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001"}]',
      'KD010', 'an entry without eater_user_id was accepted'],
    array['2030-02-02', '{"day_index":0}', 'KD010', 'a non-array payload was accepted'],
    array['2030-02-02', null, 'KD010', 'a null payload was accepted'],
    array[null, '[]', 'KD010', 'a null start date was accepted'],
    array['2030-02-02', (select jsonb_agg(jsonb_build_object('day_index', g % 3, 'meal_type', 'lunch',
        'recipe_id', '5eed0002-0000-4000-8000-000000000001', 'eater_user_id', null))::text
      from generate_series(1, 16) g), 'KD010', 'more than 15 entries were accepted'],
    array['2030-02-02', '[{"day_index":0,"meal_type":"lunch","recipe_id":"00000000-0000-4000-8000-0000000000ff","eater_user_id":null}]',
      'KD011', 'an unknown recipe was accepted'],
    array['2030-02-02', '[{"day_index":0,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":"00000000-0000-4000-a000-00000000000b"}]',
      'KD012', 'a meal for a user outside the household was accepted'],
    -- S-08: share_with. Each payload is otherwise valid, so only the share_with rule can reject it.
    array['2030-02-02', '[' || ok || ',{"day_index":1,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":null,"share_with":"3_lunch"}]',
      'KD015', 'a share_with with day 3 was accepted'],
    array['2030-02-02', '[' || ok || ',{"day_index":1,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":null,"share_with":"0_brunch"}]',
      'KD015', 'a share_with with an unknown meal type was accepted'],
    array['2030-02-02', '[' || ok || ',{"day_index":1,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":null,"share_with":5}]',
      'KD015', 'a non-string share_with was accepted'],
    array['2030-02-02', '[' || ok || ',{"day_index":1,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":null,"share_with":"1_lunch"}]',
      'KD015', 'a share_with naming the meal''s own slot was accepted'],
    array['2030-02-02', '[' || ok || ',{"day_index":1,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000001","eater_user_id":null,"share_with":"2_lunch"}]',
      'KD016', 'a share_with naming a slot that is not in the plan was accepted'],
    array['2030-02-02', '[' || ok || ',{"day_index":1,"meal_type":"lunch","recipe_id":"5eed0002-0000-4000-8000-000000000002","eater_user_id":null,"share_with":"0_lunch"}]',
      'KD017', 'a share_with naming a slot of a different recipe was accepted']
  ];
  i int;
  n int;
  v_state text;
  v_msg text;
begin
  for i in 1 .. array_length(cases, 1) loop
    begin
      perform public.save_meal_plan(cases[i][1]::date, cases[i][2]::jsonb);
      raise exception 'plans[%]: %', cases[i][3], cases[i][4];
    exception
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        if v_state = 'P0001' then raise; end if;
        if v_state <> cases[i][3] then
          raise exception 'plans[%]: % -- rejected with % ("%") instead', cases[i][3], cases[i][4], v_state, v_msg;
        end if;
    end;
  end loop;

  select count(*) into n from public.meal_plans where start_date = '2030-02-02';
  if n <> 0 then
    raise exception 'plans: a rejected save left a 2030-02-02 plan behind';
  end if;
end;
$$;

-- As user A: day solutions (S-04, group writer since S-08) against A's own RPC-saved 2030-05-01 plan,
-- whose lunch is one batch shared by days 0 and 1. save_plan_day_solutions writes both days of the
-- group in one call and returns the plan id; a second call updates both rows in place; the table is
-- write-revoked. The day 0 solution id is stashed for B's invisibility check and the cascade block at
-- the end.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  fp constant text := repeat('ab', 32);
  fp2 constant text := repeat('cd', 32);
  plan uuid;
  returned uuid;
  sol uuid;
  sol1 uuid;
  n int;
begin
  plan := public.save_meal_plan('2030-05-01', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000004', 'eater_user_id', null),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000004', 'eater_user_id', null, 'share_with', '0_lunch')));

  returned := public.save_plan_day_solutions('2030-05-01', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'status', 'needs_confirmation', 'accepted_tolerance_pct', 10,
      'input_fingerprint', fp, 'result', '{"version":1}'::jsonb),
    jsonb_build_object('day_index', 1, 'status', 'needs_confirmation', 'accepted_tolerance_pct', 10,
      'input_fingerprint', fp, 'result', '{"version":1}'::jsonb)));
  if returned is distinct from plan then
    raise exception 'solutions[rpc]: save_plan_day_solutions returned %, expected A''s 2030-05-01 plan %', returned, plan;
  end if;
  select count(*) into n from public.plan_day_solutions
  where plan_id = plan and household_id = a_household and day_index in (0, 1)
    and status = 'needs_confirmation' and accepted_tolerance_pct = 10 and input_fingerprint = fp;
  if n <> 2 then
    raise exception 'solutions[rpc]: one group write stored % of its 2 days, expected both', n;
  end if;
  select id into sol from public.plan_day_solutions where plan_id = plan and day_index = 0;
  select id into sol1 from public.plan_day_solutions where plan_id = plan and day_index = 1;

  -- Second group write: both rows are updated in place (same ids), not duplicated.
  perform public.save_plan_day_solutions('2030-05-01', jsonb_build_array(
    jsonb_build_object('day_index', 1, 'status', 'solved', 'accepted_tolerance_pct', 15,
      'input_fingerprint', fp2, 'result', '{"version":1}'::jsonb),
    jsonb_build_object('day_index', 0, 'status', 'solved', 'accepted_tolerance_pct', 15,
      'input_fingerprint', fp2, 'result', '{"version":1}'::jsonb)));
  select count(*) into n from public.plan_day_solutions
  where id in (sol, sol1) and status = 'solved' and accepted_tolerance_pct = 15 and input_fingerprint = fp2;
  if n <> 2 then
    raise exception 'solutions[rpc]: re-saving the group updated % of its 2 rows in place, expected both', n;
  end if;
  select count(*) into n from public.plan_day_solutions where plan_id = plan;
  if n <> 2 then
    raise exception 'solutions[rpc]: the plan holds % solution rows after two group writes of two days, expected 2', n;
  end if;

  -- Valid values in A's own household and plan: the policies alone would ALLOW this, so only the
  -- revoke can raise insufficient_privilege, and no other handler is accepted on purpose.
  begin
    insert into public.plan_day_solutions
      (household_id, plan_id, day_index, status, accepted_tolerance_pct, input_fingerprint, result)
    values (a_household, plan, 2, 'solved', 10, fp, '{}'::jsonb);
    raise exception 'solutions: user A could insert into public.plan_day_solutions directly';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.plan_day_solutions set status = 'no_fit' where household_id = a_household;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'solutions: user A updated % own plan_day_solutions rows directly', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.plan_day_solutions where household_id = a_household;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'solutions: user A deleted % own plan_day_solutions rows directly', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    truncate public.plan_day_solutions;
    raise exception 'solutions: user A could truncate public.plan_day_solutions';
  exception when insufficient_privilege then null;
  end;

  -- Saving the plan with zero meals keeps the plan row, so the solution stays (the app shows it as
  -- out of date by fingerprint; nothing here deletes it).
  perform public.save_meal_plan('2030-05-01', '[]'::jsonb);
  select count(*) into n from public.plan_day_solutions where id = sol;
  if n <> 1 then
    raise exception 'solutions: saving the plan with zero meals removed its day solution';
  end if;

  perform set_config('rls_test.a_solution', sol::text, true);
end;
$$;

-- As user A: save_plan_day_solutions rejections, one SQLSTATE each (same when others + P0001 re-raise
-- idiom as the save_meal_plan rejections above). Every malformed case puts a VALID day 2 first, so the
-- final check proves a rejected group write stores none of its days.
do $$
declare
  fp constant text := repeat('ab', 32);
  ok constant text := '{"day_index":2,"status":"solved","accepted_tolerance_pct":10,"input_fingerprint":"' || repeat('ab', 32) || '","result":{}}';
  cases text[][] := array[
    -- start date, payload, expected SQLSTATE, what the case proves
    array['2030-05-01', '[' || ok || ',' || jsonb_build_object('day_index', 3, 'status', 'solved',
      'accepted_tolerance_pct', 10, 'input_fingerprint', fp, 'result', '{}'::jsonb)::text || ']',
      'KD013', 'day_index 3 was accepted'],
    array['2030-05-01', '[' || ok || ',' || jsonb_build_object('day_index', 0, 'status', 'great',
      'accepted_tolerance_pct', 10, 'input_fingerprint', fp, 'result', '{}'::jsonb)::text || ']',
      'KD013', 'an unknown status was accepted'],
    array['2030-05-01', '[' || ok || ',' || jsonb_build_object('day_index', 0, 'status', 'solved',
      'accepted_tolerance_pct', 12, 'input_fingerprint', fp, 'result', '{}'::jsonb)::text || ']',
      'KD013', 'a tolerance of 12 was accepted'],
    array['2030-05-01', '[' || ok || ',' || jsonb_build_object('day_index', 0, 'status', 'solved',
      'accepted_tolerance_pct', 10, 'input_fingerprint', repeat('zz', 32), 'result', '{}'::jsonb)::text || ']',
      'KD013', 'a non-hex fingerprint was accepted'],
    array['2030-05-01', '[' || ok || ',' || jsonb_build_object('day_index', 0, 'status', 'solved',
      'accepted_tolerance_pct', 10, 'input_fingerprint', fp, 'result', '[]'::jsonb)::text || ']',
      'KD013', 'a jsonb array result was accepted'],
    array['2030-05-01', '[' || ok || ',' || jsonb_build_object('day_index', 0, 'status', 'solved',
      'accepted_tolerance_pct', 10, 'input_fingerprint', fp,
      'result', jsonb_build_object('pad', repeat('x', 70000)))::text || ']',
      'KD013', 'a result over 65536 bytes was accepted'],
    array['2030-05-01', '[' || ok || ',' || jsonb_build_object('day_index', 0, 'status', 'solved',
      'accepted_tolerance_pct', 10, 'result', '{}'::jsonb)::text || ']',
      'KD013', 'an entry without input_fingerprint was accepted'],
    array['2030-05-01', '[' || ok || ',' || ok || ']', 'KD013', 'a duplicate day_index was accepted'],
    array['2030-05-01', '[' || ok || ',"day 0"]', 'KD013', 'a non-object entry was accepted'],
    array['2030-05-01', '[]', 'KD013', 'an empty group was accepted'],
    array['2030-05-01', '[' || ok || ',' || ok || ',' || ok || ',' || ok || ']', 'KD013', 'more than 3 days were accepted'],
    array['2030-05-01', ok, 'KD013', 'a non-array payload was accepted'],
    array['2030-05-01', null, 'KD013', 'a null payload was accepted'],
    array[null, '[' || ok || ']', 'KD013', 'a null start date was accepted'],
    array['2030-05-09', '[' || ok || ']', 'KD014', 'a start date with no plan was accepted']
  ];
  i int;
  n int;
  v_state text;
  v_msg text;
begin
  for i in 1 .. array_length(cases, 1) loop
    begin
      perform public.save_plan_day_solutions(cases[i][1]::date, cases[i][2]::jsonb);
      raise exception 'solutions[%]: %', cases[i][3], cases[i][4];
    exception
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        if v_state = 'P0001' then raise; end if;
        if v_state <> cases[i][3] then
          raise exception 'solutions[%]: % -- rejected with % ("%") instead', cases[i][3], cases[i][4], v_state, v_msg;
        end if;
    end;
  end loop;

  select count(*) into n from public.plan_day_solutions s
  join public.meal_plans mp on mp.id = s.plan_id
  where mp.start_date = '2030-05-01' and s.day_index = 2;
  if n <> 0 then
    raise exception 'solutions: a rejected group write stored its valid day 2 anyway; a group write must be all or nothing';
  end if;
end;
$$;

-- As user A: shopping-list checks (S-09) are household-scoped -- exactly A's one fixture row, none of
-- B's. Runs before the RPC block below adds rows on A's 2030-06-01 plan.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  n int;
begin
  select count(*) into n from public.shopping_list_checks;
  if n <> 1 then
    raise exception 'checks: user A sees % shopping_list_checks rows, expected exactly its own 1', n;
  end if;
  select count(*) into n from public.shopping_list_checks
  where plan_id = '00000000-0000-4000-b000-00000000a007' and household_id = a_household;
  if n <> 1 then
    raise exception 'checks: user A cannot see its own fixture check';
  end if;
  select count(*) into n from public.shopping_list_checks where plan_id = '00000000-0000-4000-b000-00000000b007';
  if n <> 0 then
    raise exception 'checks: user A can see B''s fixture check';
  end if;
end;
$$;

-- As user A: shopping-list checks are write-revoked (writes only via public.set_shopping_item_checked).
-- The insert probe uses valid values in A's own household and plan (the fixture product, which A's
-- plan cooks through the fixture recipe, not the already-checked seed product), so the policies alone
-- would ALLOW it: only the revoke can raise insufficient_privilege, and no other handler is accepted
-- on purpose. update/delete may raise or affect 0 rows; truncate must raise.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  n int;
begin
  begin
    insert into public.shopping_list_checks (household_id, plan_id, product_id)
    values (a_household, '00000000-0000-4000-b000-00000000a007', '00000000-0000-4000-b000-00000000c001');
    raise exception 'checks: user A could insert into public.shopping_list_checks directly';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.shopping_list_checks set checked_at = now() where household_id = a_household;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'checks: user A updated % own shopping_list_checks rows directly', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.shopping_list_checks where household_id = a_household;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'checks: user A deleted % own shopping_list_checks rows directly', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    truncate public.shopping_list_checks;
    raise exception 'checks: user A could truncate public.shopping_list_checks';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- As user A: set_shopping_item_checked behaviour, on A's own RPC-saved 2030-06-01 plan holding one
-- meal of seed recipe …0001. Check and uncheck are both idempotent. The final check row stays, for
-- B's invisibility check and the household cascade block at the end.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  used uuid;
  plan uuid;
  n int;
begin
  plan := public.save_meal_plan('2030-06-01', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000001', 'eater_user_id', null)));

  select ri.product_id into used
  from public.recipe_ingredients ri
  join public.recipe_components rc on rc.id = ri.component_id
  where rc.recipe_id = '5eed0002-0000-4000-8000-000000000001'
  order by ri.product_id
  limit 1;
  if used is null then
    raise exception 'checks setup: seed recipe …0001 has no ingredients';
  end if;

  -- Check, then check again: one row, in A's household and plan.
  perform public.set_shopping_item_checked('2030-06-01', used, true);
  select count(*) into n from public.shopping_list_checks
  where plan_id = plan and product_id = used and household_id = a_household;
  if n <> 1 then
    raise exception 'checks[rpc]: checking a product the plan uses stored % rows, expected 1', n;
  end if;
  perform public.set_shopping_item_checked('2030-06-01', used, true);
  select count(*) into n from public.shopping_list_checks where plan_id = plan;
  if n <> 1 then
    raise exception 'checks[rpc]: checking the same product twice left % rows, expected 1', n;
  end if;

  -- Uncheck, then uncheck again: no error, no rows.
  perform public.set_shopping_item_checked('2030-06-01', used, false);
  perform public.set_shopping_item_checked('2030-06-01', used, false);
  select count(*) into n from public.shopping_list_checks where plan_id = plan;
  if n <> 0 then
    raise exception 'checks[rpc]: unchecking twice left % rows, expected 0', n;
  end if;

  -- The fixture check on A's 2030-01-01 plan was untouched by all of the above.
  select count(*) into n from public.shopping_list_checks where plan_id = '00000000-0000-4000-b000-00000000a007';
  if n <> 1 then
    raise exception 'checks[rpc]: writes on the 2030-06-01 plan changed the 2030-01-01 plan''s checks';
  end if;

  perform public.set_shopping_item_checked('2030-06-01', used, true);
  perform set_config('rls_test.a_check_plan', plan::text, true);
  perform set_config('rls_test.a_check_product', used::text, true);
end;
$$;

-- As user A: set_shopping_item_checked rejections, one SQLSTATE each (same when others + P0001
-- re-raise idiom as above). The unused product is a seed product recipe …0001 does not use, found by
-- query rather than hard-coded.
do $$
declare
  used text := current_setting('rls_test.a_check_product');
  unused text := (
    select p.id::text from public.products p
    where p.id::text like '5eed%'
      and not exists (
        select 1 from public.recipe_ingredients ri
        join public.recipe_components rc on rc.id = ri.component_id
        where rc.recipe_id = '5eed0002-0000-4000-8000-000000000001' and ri.product_id = p.id)
    order by p.id
    limit 1);
  cases text[][];
  i int;
  n int;
  v_state text;
  v_msg text;
begin
  if unused is null then
    raise exception 'checks setup: every seed product is used by seed recipe …0001';
  end if;

  cases := array[
    -- start date, product id, checked, expected SQLSTATE, what the case proves
    array[null, used, 'true', 'KD018', 'a null start date was accepted'],
    array['2030-06-01', null, 'true', 'KD018', 'a null product id was accepted'],
    array['2030-06-01', used, null, 'KD018', 'a null checked flag was accepted'],
    array['2030-06-09', used, 'true', 'KD014', 'a start date with no plan was accepted'],
    array['2030-06-01', unused, 'true', 'KD019', 'checking a product no recipe of the plan uses was accepted'],
    array['2030-06-01', gen_random_uuid()::text, 'true', 'KD019', 'checking an unknown product id was accepted']
  ];

  for i in 1 .. array_length(cases, 1) loop
    begin
      perform public.set_shopping_item_checked(cases[i][1]::date, cases[i][2]::uuid, cases[i][3]::boolean);
      raise exception 'checks[%]: %', cases[i][4], cases[i][5];
    exception
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        if v_state = 'P0001' then raise; end if;
        if v_state <> cases[i][4] then
          raise exception 'checks[%]: % -- rejected with % ("%") instead', cases[i][4], cases[i][5], v_state, v_msg;
        end if;
    end;
  end loop;

  -- Unchecking a product the plan does not use is allowed (a stale check must stay clearable).
  perform public.set_shopping_item_checked('2030-06-01', unused::uuid, false);

  select count(*) into n from public.shopping_list_checks
  where plan_id = current_setting('rls_test.a_check_plan')::uuid;
  if n <> 1 then
    raise exception 'checks: the rejected calls changed the 2030-06-01 plan''s checks to % rows, expected 1', n;
  end if;

  -- KD007: an authenticated request with no sub claim. The claims are restored afterwards.
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  begin
    perform public.set_shopping_item_checked('2030-06-01', used::uuid, true);
    raise exception 'checks[KD007]: a call with no caller was accepted';
  exception
    when sqlstate 'KD007' then null;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state = 'P0001' then raise; end if;
      raise exception 'checks[KD007]: rejected with % ("%") instead of KD007', v_state, v_msg;
  end;
  perform set_config('request.jwt.claims',
    json_build_object('sub', '00000000-0000-4000-a000-00000000000a', 'role', 'authenticated')::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- As user B: symmetric read check.
-- ---------------------------------------------------------------------------
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000b', 'role', 'authenticated')::text,
  true
);

do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  b_household uuid := current_setting('rls_test.b_household')::uuid;
  n int;
begin
  select count(*) into n from public.households where id = b_household;
  if n <> 1 then
    raise exception 'read: user B cannot see own household %', b_household;
  end if;

  select count(*) into n from public.households where id = a_household;
  if n <> 0 then
    raise exception 'read: user B can see household % of user A', a_household;
  end if;

  select count(*) into n from public.household_members where household_id = a_household;
  if n <> 0 then
    raise exception 'read: user B sees % membership rows of user A''s household', n;
  end if;

  select count(*) into n from public.macro_targets where user_id = '00000000-0000-4000-a000-00000000000b';
  if n <> 1 then
    raise exception 'targets: user B cannot see its own macro_targets row';
  end if;

  select count(*) into n from public.macro_targets where user_id <> '00000000-0000-4000-a000-00000000000b';
  if n <> 0 then
    raise exception 'targets: user B sees % macro_targets rows of other users', n;
  end if;
end;
$$;

-- As user B: meal plans (S-03) -- only B's own fixture plan, none of A's (incl. A's RPC-saved plan).
do $$
declare
  b_household uuid := current_setting('rls_test.b_household')::uuid;
  n int;
begin
  select count(*) into n from public.meal_plans where household_id <> b_household;
  if n <> 0 then
    raise exception 'plans: user B sees % meal_plans rows of other households', n;
  end if;
  select count(*) into n from public.meal_plans where id = '00000000-0000-4000-b000-00000000b007';
  if n <> 1 then
    raise exception 'plans: user B cannot see its own fixture plan';
  end if;
  select count(*) into n from public.plan_dishes where household_id <> b_household;
  if n <> 0 then
    raise exception 'plans: user B sees % plan_dishes rows of other households', n;
  end if;
  select count(*) into n from public.plan_meals where household_id <> b_household;
  if n <> 0 then
    raise exception 'plans: user B sees % plan_meals rows of other households', n;
  end if;
end;
$$;

-- As user B: A's day solution (S-04) is invisible, and B cannot write to A's plan through the RPC --
-- the start date resolves against B's own household, which has no 2030-05-01 plan (KD014).
do $$
declare
  n int;
  v_state text;
  v_msg text;
begin
  select count(*) into n from public.plan_day_solutions where id = current_setting('rls_test.a_solution')::uuid;
  if n <> 0 then
    raise exception 'solutions: user B can see A''s day solution';
  end if;
  select count(*) into n from public.plan_day_solutions;
  if n <> 0 then
    raise exception 'solutions: user B sees % plan_day_solutions rows, expected 0', n;
  end if;

  begin
    perform public.save_plan_day_solutions('2030-05-01', jsonb_build_array(jsonb_build_object(
      'day_index', 0, 'status', 'solved', 'accepted_tolerance_pct', 10,
      'input_fingerprint', repeat('ab', 32), 'result', '{}'::jsonb)));
    raise exception 'solutions[KD014]: user B saved a solution for A''s 2030-05-01 plan date';
  exception
    when sqlstate 'KD014' then null;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state = 'P0001' then raise; end if;
      raise exception 'solutions[KD014]: rejected with % ("%") instead of KD014', v_state, v_msg;
  end;
end;
$$;

-- As user B: shopping-list checks (S-09) -- only B's own fixture check, none of A's, and B cannot
-- check or uncheck on A's 2030-06-01 plan: the start date resolves against B's own household, which
-- has no plan there (KD014). The postgres block after the grants asserts A's row survived.
do $$
declare
  b_household uuid := current_setting('rls_test.b_household')::uuid;
  flag boolean;
  n int;
  v_state text;
  v_msg text;
begin
  select count(*) into n from public.shopping_list_checks where household_id <> b_household;
  if n <> 0 then
    raise exception 'checks: user B sees % shopping_list_checks rows of other households', n;
  end if;
  select count(*) into n from public.shopping_list_checks where plan_id = '00000000-0000-4000-b000-00000000b007';
  if n <> 1 then
    raise exception 'checks: user B cannot see its own fixture check';
  end if;

  foreach flag in array array[true, false] loop
    begin
      perform public.set_shopping_item_checked('2030-06-01',
        current_setting('rls_test.a_check_product')::uuid, flag);
      raise exception 'checks[KD014]: user B set checked = % on A''s 2030-06-01 plan date', flag;
    exception
      when sqlstate 'KD014' then null;
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        if v_state = 'P0001' then raise; end if;
        raise exception 'checks[KD014]: user B (checked = %) rejected with % ("%") instead of KD014', flag, v_state, v_msg;
    end;
  end loop;
end;
$$;

-- As user B (NOT linked with A, different household): the same whole library A sees.
do $$
declare
  t text;
  n int;
  counts text := '';
begin
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I', t) into n;
    counts := counts || t || '=' || n || ';';
  end loop;
  if counts <> current_setting('rls_test.library_counts') then
    raise exception 'library: unlinked user B sees % but the library holds % -- the library must not be household-scoped',
      counts, current_setting('rls_test.library_counts');
  end if;

  select count(*) into n from public.products where id = '00000000-0000-4000-b000-00000000c001';
  if n <> 1 then
    raise exception 'library: unlinked user B cannot see the fixture product';
  end if;
  select count(*) into n from public.recipes where id = '00000000-0000-4000-b000-00000000c002';
  if n <> 1 then
    raise exception 'library: unlinked user B cannot see the fixture recipe';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- As anon (no sub claim): no rows, and the helper is not executable.
-- ---------------------------------------------------------------------------
reset role;
set local role anon;
select set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

do $$
declare
  n int;
begin
  begin
    select count(*) into n from public.households;
    if n <> 0 then
      raise exception 'anon: sees % households rows, expected 0', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    select count(*) into n from public.household_members;
    if n <> 0 then
      raise exception 'anon: sees % household_members rows, expected 0', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    perform private.user_household_ids();
    raise exception 'anon: could execute private.user_household_ids()';
  exception when insufficient_privilege then null;
  end;

  -- The two S-01 RPCs live in `public`, which IS API-exposed, and Supabase's default privileges
  -- grant execute on new public functions to anon -- so the `revoke execute … from public, anon`
  -- in the migration is load-bearing. The household_id catch-all inspects tables only, so no other
  -- assertion in this file covers these grants.
  -- The KD007 branches matter: with the revoke missing, anon reaches the body and the call fails on
  -- "no household for caller" instead — a message that reads like a test bug rather than a missing
  -- grant revoke, which is exactly the wrong thing to be debugging.
  begin
    perform public.create_household_invite();
    raise exception 'anon: could execute public.create_household_invite()';
  exception
    when insufficient_privilege then null;
    when sqlstate 'KD007' then
      raise exception 'anon: public.create_household_invite() is executable by anon (reached the body and raised KD007); the revoke execute … from public, anon is missing';
  end;

  begin
    perform public.redeem_household_invite('a0a0a0a0a0a0a001');
    raise exception 'anon: could execute public.redeem_household_invite()';
  exception
    when insufficient_privilege then null;
    when sqlstate 'KD007' then
      raise exception 'anon: public.redeem_household_invite() is executable by anon (reached the body and raised KD007); the revoke execute … from public, anon is missing';
  end;
end;
$$;

-- As anon: the S-03 RPC, same reasoning and KD007 branch as the S-01 RPCs above.
do $$
begin
  begin
    perform public.save_meal_plan('2030-01-01', '[]'::jsonb);
    raise exception 'anon: could execute public.save_meal_plan()';
  exception
    when insufficient_privilege then null;
    when sqlstate 'KD007' then
      raise exception 'anon: public.save_meal_plan() is executable by anon (reached the body and raised KD007); the revoke execute … from public, anon is missing';
  end;
end;
$$;

-- As anon: the S-04 solutions RPC (the S-08 group writer), same reasoning and KD007 branch. It is a
-- NEW function (save_day_solution was dropped), so it got Supabase's default anon grant afresh.
do $$
begin
  begin
    perform public.save_plan_day_solutions('2030-01-01', '[]'::jsonb);
    raise exception 'anon: could execute public.save_plan_day_solutions()';
  exception
    when insufficient_privilege then null;
    when sqlstate 'KD007' then
      raise exception 'anon: public.save_plan_day_solutions() is executable by anon (reached the body and raised KD007); the revoke execute … from public, anon is missing';
  end;
end;
$$;

-- As anon: the S-09 check-off RPC, same reasoning and KD007 branch.
do $$
begin
  begin
    perform public.set_shopping_item_checked('2030-01-01', '00000000-0000-4000-b000-00000000c001', true);
    raise exception 'anon: could execute public.set_shopping_item_checked()';
  exception
    when insufficient_privilege then null;
    when sqlstate 'KD007' then
      raise exception 'anon: public.set_shopping_item_checked() is executable by anon (reached the body and raised KD007); the revoke execute … from public, anon is missing';
  end;
end;
$$;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps',
    'household_invites', 'macro_targets', 'meal_plans', 'plan_dishes', 'plan_meals', 'plan_day_solutions',
    'shopping_list_checks'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      if n <> 0 then
        raise exception 'anon: sees % public.% rows, expected 0', n, t;
      end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Catch-all (as postgres): every public table with a household_id column has RLS enabled and
-- per-operation policies for authenticated that go through the helper, and none for anon.
-- household_members is exempt: it is read-only for clients by design (writes via definer functions).
-- ---------------------------------------------------------------------------
reset role;

do $$
declare
  t record;
  op text;
  bad_policy text;
begin
  for t in
    select c.oid, c.relname, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'household_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'household_members'
  loop
    if not t.relrowsecurity then
      raise exception 'catch-all: public.% has household_id but RLS is not enabled', t.relname;
    end if;

    foreach op in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public' and p.tablename = t.relname
          and p.cmd in (op, 'ALL') and 'authenticated' = any(p.roles)
      ) then
        raise exception 'catch-all: public.% has no % policy for authenticated', t.relname, op;
      end if;
    end loop;

    select p.policyname into bad_policy
    from pg_policies p
    where p.schemaname = 'public' and p.tablename = t.relname
      and ('anon' = any(p.roles) or 'public' = any(p.roles)
        or coalesce(p.qual, '') || coalesce(p.with_check, '') not like '%user_household_ids%')
    limit 1;
    if bad_policy is not null then
      raise exception 'catch-all: policy "%" on public.% targets anon/public or bypasses private.user_household_ids()', bad_policy, t.relname;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Classification catch-all (as postgres, F-04): every public table belongs to exactly one known
-- ownership class. Without this, a table that forgets household_id would look like a library table
-- and escape every check above. A new public table must either carry household_id (and pass the
-- catch-all above) or be added to library_tables here -- and then pass the library checks below.
--
-- Library section: the 5eed000N- id namespace is reserved for migrations, and no library write path
-- may accept a client-supplied id. "Every library policy is SELECT-only" holds for F-04; S-07 must
-- REPLACE that assertion with one requiring each write policy to reference created_by and a definer
-- helper -- never simply delete it.
-- ---------------------------------------------------------------------------
do $$
declare
  library_tables text[] := array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'];
  t record;
  lib text;
  bad text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and c.relname <> 'households'
      and c.relname <> all (library_tables)
      and not exists (
        select 1 from pg_attribute a
        where a.attrelid = c.oid and a.attname = 'household_id' and not a.attisdropped
      )
  loop
    raise exception 'classification: public.% is neither household-scoped nor a declared library table', t.relname;
  end loop;

  -- A public view is API-exposed and bypasses RLS unless it runs as the invoker; a materialized
  -- view cannot, so it fails outright.
  select string_agg(c.relname, ', ') into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm')
    and not exists (
      select 1 from unnest(coalesce(c.reloptions, '{}')) o
      where o ~* '^security_invoker=(true|on|yes|1)$'
    );
  if bad is not null then
    raise exception 'classification: public views/materialized views without security_invoker=true: %', bad;
  end if;

  foreach lib in array library_tables loop
    if to_regclass('public.' || lib) is null then
      raise exception 'classification: declared library table public.% does not exist', lib;
    end if;

    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || lib)::regclass) then
      raise exception 'classification: library table public.% does not have RLS enabled', lib;
    end if;

    if exists (
      select 1 from pg_attribute a
      where a.attrelid = ('public.' || lib)::regclass and a.attname = 'household_id' and not a.attisdropped
    ) then
      raise exception 'classification: library table public.% has a household_id column; the library is not household-scoped', lib;
    end if;

    select p.policyname into bad
    from pg_policies p
    where p.schemaname = 'public' and p.tablename = lib
      and ('anon' = any (p.roles) or 'public' = any (p.roles))
    limit 1;
    if bad is not null then
      raise exception 'classification: policy "%" on library table public.% targets anon/public', bad, lib;
    end if;

    select p.policyname into bad
    from pg_policies p
    where p.schemaname = 'public' and p.tablename = lib and p.cmd <> 'SELECT'
    limit 1;
    if bad is not null then
      raise exception 'classification: policy "%" on library table public.% is not SELECT-only; the library is read-only for clients', bad, lib;
    end if;

    if not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = lib and p.cmd = 'SELECT' and 'authenticated' = any (p.roles)
    ) then
      raise exception 'classification: library table public.% has no SELECT policy for authenticated', lib;
    end if;
  end loop;
end;
$$;

-- Grants (as postgres): the second lever. The library tables were recreated by F-04, and Supabase's
-- default privileges grant everything on a new public table to anon and authenticated, so the
-- migration's revokes are load-bearing. RLS alone would still deny writes -- both levers are kept
-- and asserted independently.
do $$
declare
  lib text;
  p text;
begin
  foreach lib in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege('authenticated', 'public.' || lib, p) then
        raise exception 'grants: authenticated holds % on library table public.%; the revoke is missing', p, lib;
      end if;
    end loop;

    -- has_table_privilege sees table-level grants only; a column-level grant (the shape S-07 is told
    -- to use) would slip past it.
    foreach p in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege('authenticated', 'public.' || lib, p) then
        raise exception 'grants: authenticated holds column-level % on library table public.%', p, lib;
      end if;
    end loop;

    if not has_table_privilege('authenticated', 'public.' || lib, 'SELECT') then
      raise exception 'grants: authenticated lacks SELECT on library table public.%', lib;
    end if;

    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege('anon', 'public.' || lib, p) then
        raise exception 'grants: anon holds % on library table public.%; the revoke all is missing', p, lib;
      end if;
    end loop;
  end loop;
end;
$$;

-- Grants (as postgres), meal plans (S-03): write-revoked household tables -- SELECT only for
-- authenticated (incl. MAINTAIN revoked), nothing for anon. Policies exist for every operation (the
-- household_id catch-all checked them), so these revokes are what actually deny writes. The RPC's
-- execute grants are asserted here too: the catch-alls inspect tables only.
do $$
declare
  t text;
  p text;
begin
  foreach t in array array['meal_plans', 'plan_dishes', 'plan_meals'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege('authenticated', 'public.' || t, p) then
        raise exception 'grants: authenticated holds % on public.%; writes must go through public.save_meal_plan', p, t;
      end if;
    end loop;

    foreach p in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege('authenticated', 'public.' || t, p) then
        raise exception 'grants: authenticated holds column-level % on public.%', p, t;
      end if;
    end loop;

    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception 'grants: authenticated lacks SELECT on public.%', t;
    end if;

    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege('anon', 'public.' || t, p) then
        raise exception 'grants: anon holds % on public.%; the revoke all is missing', p, t;
      end if;
    end loop;
  end loop;

  if has_function_privilege('anon', 'public.save_meal_plan(date, jsonb)', 'execute') then
    raise exception 'grants: anon can execute public.save_meal_plan(date, jsonb); the revoke execute … from public, anon is missing';
  end if;
  if not has_function_privilege('authenticated', 'public.save_meal_plan(date, jsonb)', 'execute') then
    raise exception 'grants: authenticated cannot execute public.save_meal_plan(date, jsonb)';
  end if;
end;
$$;

-- Grants (as postgres), day solutions (S-04): the same write-revoked shape as the S-03 tables, and
-- the RPC's execute grants (the catch-alls inspect tables only). Since S-08 the single write path is
-- save_plan_day_solutions; the per-day save_day_solution must be gone, or the table has two.
do $$
declare
  t text;
  p text;
begin
  foreach t in array array['plan_day_solutions'] loop
    foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege('authenticated', 'public.' || t, p) then
        raise exception 'grants: authenticated holds % on public.%; writes must go through public.save_plan_day_solutions', p, t;
      end if;
    end loop;

    foreach p in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
      if has_any_column_privilege('authenticated', 'public.' || t, p) then
        raise exception 'grants: authenticated holds column-level % on public.%', p, t;
      end if;
    end loop;

    if not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then
      raise exception 'grants: authenticated lacks SELECT on public.%', t;
    end if;

    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
      if has_table_privilege('anon', 'public.' || t, p) then
        raise exception 'grants: anon holds % on public.%; the revoke all is missing', p, t;
      end if;
    end loop;
  end loop;

  if has_function_privilege('anon', 'public.save_plan_day_solutions(date, jsonb)', 'execute') then
    raise exception 'grants: anon can execute public.save_plan_day_solutions(date, jsonb); the revoke execute … from public, anon is missing';
  end if;
  if not has_function_privilege('authenticated', 'public.save_plan_day_solutions(date, jsonb)', 'execute') then
    raise exception 'grants: authenticated cannot execute public.save_plan_day_solutions(date, jsonb)';
  end if;

  if to_regprocedure('public.save_day_solution(date, int, text, int, text, jsonb)') is not null then
    raise exception 'grants: public.save_day_solution(date, int, text, int, text, jsonb) still exists; plan_day_solutions must keep one write path (save_plan_day_solutions)';
  end if;
end;
$$;

-- Grants (as postgres), shopping-list checks (S-09): the same write-revoked shape, and the RPC's
-- execute grants (the catch-alls inspect tables only). Also: B's KD014 probes above left A's
-- 2030-06-01 check in place.
do $$
declare
  p text;
  n int;
begin
  foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
    if has_table_privilege('authenticated', 'public.shopping_list_checks', p) then
      raise exception 'grants: authenticated holds % on public.shopping_list_checks; writes must go through public.set_shopping_item_checked', p;
    end if;
  end loop;

  foreach p in array array['INSERT', 'UPDATE', 'REFERENCES'] loop
    if has_any_column_privilege('authenticated', 'public.shopping_list_checks', p) then
      raise exception 'grants: authenticated holds column-level % on public.shopping_list_checks', p;
    end if;
  end loop;

  if not has_table_privilege('authenticated', 'public.shopping_list_checks', 'SELECT') then
    raise exception 'grants: authenticated lacks SELECT on public.shopping_list_checks';
  end if;

  foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] loop
    if has_table_privilege('anon', 'public.shopping_list_checks', p) then
      raise exception 'grants: anon holds % on public.shopping_list_checks; the revoke all is missing', p;
    end if;
  end loop;

  if has_function_privilege('anon', 'public.set_shopping_item_checked(date, uuid, boolean)', 'execute') then
    raise exception 'grants: anon can execute public.set_shopping_item_checked(date, uuid, boolean); the revoke execute … from public, anon is missing';
  end if;
  if has_function_privilege('public', 'public.set_shopping_item_checked(date, uuid, boolean)', 'execute') then
    raise exception 'grants: PUBLIC can execute public.set_shopping_item_checked(date, uuid, boolean); the revoke execute … from public is missing';
  end if;
  if not has_function_privilege('authenticated', 'public.set_shopping_item_checked(date, uuid, boolean)', 'execute') then
    raise exception 'grants: authenticated cannot execute public.set_shopping_item_checked(date, uuid, boolean)';
  end if;

  select count(*) into n from public.shopping_list_checks
  where plan_id = current_setting('rls_test.a_check_plan')::uuid
    and product_id = current_setting('rls_test.a_check_product')::uuid
    and household_id = current_setting('rls_test.a_household')::uuid;
  if n <> 1 then
    raise exception 'checks: A''s 2030-06-01 check is gone after user B''s KD014 probes';
  end if;
end;
$$;

-- Seed mechanism gone (as postgres, F-04): no per-household seed function and no templates. The
-- public tables are the single source of truth for seed content.
do $$
declare
  t text;
begin
  if to_regprocedure('private.seed_household(uuid)') is not null then
    raise exception 'seed mechanism: private.seed_household(uuid) still exists';
  end if;

  foreach t in array array['seed_products', 'seed_recipes', 'seed_recipe_components', 'seed_recipe_ingredients', 'seed_recipe_steps'] loop
    if to_regclass('private.' || t) is not null then
      raise exception 'seed mechanism: template table private.% still exists', t;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invites and redemption (S-01).
--
-- Everything below is placed AFTER every block that reads rls_test.a_household / b_household,
-- because a redemption makes a stashed household id point at a now-memberless household. The
-- successful redemption uses FRESH users (C, D) and NEW GUCs and never touches A's or B's
-- households; A is reused only as a rejection probe, where every check raises before any write.
-- ---------------------------------------------------------------------------

-- As user A: household_invites carries four conforming policies (the catch-all above just checked
-- them) but insert/update/delete/truncate are revoked, so none of them is reachable. This block is
-- what stops a future reader from "simplifying" the migration by dropping the revokes.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000a', 'role', 'authenticated')::text,
  true
);

do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  n int;
begin
  begin
    -- redeemed_at is set deliberately: an unredeemed row would collide with A's fixture invite on
    -- household_invites_one_unredeemed_idx, and that unique_violation would mask the privilege
    -- check this assertion exists to make (and abort the block before the three below run).
    insert into public.household_invites (household_id, code, expires_at, redeemed_at)
    values (a_household, 'deadbeefdeadbeef', now() + interval '1 day', now());
    raise exception 'invites: user A could insert into household_invites';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.household_invites set expires_at = now() where household_id = a_household;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'invites: user A updated % own household_invites rows', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.household_invites where household_id = a_household;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'invites: user A deleted % own household_invites rows', n;
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    truncate public.household_invites;
    raise exception 'invites: user A could truncate public.household_invites';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Setup for redemption (as postgres): four more accounts, their households stashed in NEW GUCs.
--   C, D -> the successful redemption
--   E, F -> the stale-origin-code and two-member-cap rejections
-- ---------------------------------------------------------------------------
reset role;

insert into auth.users (id, email, aud, role)
values
  ('00000000-0000-4000-a000-00000000000c', 'user-c@rls-test.local', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000d', 'user-d@rls-test.local', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000e', 'user-e@rls-test.local', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000f', 'user-f@rls-test.local', 'authenticated', 'authenticated');

do $$
declare
  u text;
  hh uuid;
begin
  foreach u in array array['c', 'd', 'e', 'f'] loop
    select household_id into hh from public.household_members
    where user_id = ('00000000-0000-4000-a000-00000000000' || u)::uuid;
    if hh is null then
      raise exception 'redeem setup: user % has no household', u;
    end if;
    perform set_config('rls_test.' || u || '_household', hh::text, true);
  end loop;
end;
$$;

-- Macro targets (S-02), as postgres, BEFORE D redeems: D's row sits in D's own household, so the
-- post-redemption block can prove it followed D. C deliberately has no row (the partner-insert
-- probe below needs that). The composite FK rejects a row naming a household its user is not in.
do $$
declare
  d_household uuid := current_setting('rls_test.d_household')::uuid;
begin
  insert into public.macro_targets (user_id, household_id, kcal, protein_g, fat_g, carbs_g)
  values ('00000000-0000-4000-a000-00000000000d', d_household, 1800, 120, 60, 180);

  begin
    insert into public.macro_targets (user_id, household_id, kcal, protein_g, fat_g, carbs_g)
    values ('00000000-0000-4000-a000-00000000000c', d_household, 2000, 100, 50, 200);
    raise exception 'targets: a macro_targets row was accepted for user C in D''s household, which C is not a member of';
  exception when foreign_key_violation then null;
  end;
end;
$$;

-- Meal plans (S-03), as postgres, BEFORE D redeems: D holds a plan with a "D only" meal, C holds one
-- fixture plan. Fixture ids …cc07/…cc17/…cc37 (C) and …dd07/…dd17/…dd37 (D). If plan_meals ever
-- gains the per-person membership FK, D's redemption below fails with 23503 instead of leaving this
-- plan behind.
do $$
declare
  c_household uuid := current_setting('rls_test.c_household')::uuid;
  d_household uuid := current_setting('rls_test.d_household')::uuid;
begin
  insert into public.meal_plans (id, household_id, start_date)
  values
    ('00000000-0000-4000-b000-00000000cc07', c_household, '2030-01-01'),
    ('00000000-0000-4000-b000-00000000dd07', d_household, '2030-01-01');
  insert into public.plan_dishes (id, household_id, plan_id, recipe_id)
  values
    ('00000000-0000-4000-b000-00000000cc17', c_household, '00000000-0000-4000-b000-00000000cc07',
      '5eed0002-0000-4000-8000-000000000001'),
    ('00000000-0000-4000-b000-00000000dd17', d_household, '00000000-0000-4000-b000-00000000dd07',
      '5eed0002-0000-4000-8000-000000000002');
  insert into public.plan_meals (id, household_id, plan_id, day_index, meal_type, dish_id, eater_user_id)
  values
    ('00000000-0000-4000-b000-00000000cc37', c_household, '00000000-0000-4000-b000-00000000cc07',
      0, 'dinner', '00000000-0000-4000-b000-00000000cc17', null),
    ('00000000-0000-4000-b000-00000000dd37', d_household, '00000000-0000-4000-b000-00000000dd07',
      0, 'dinner', '00000000-0000-4000-b000-00000000dd17', '00000000-0000-4000-a000-00000000000d');

  -- S-09: one check on D's plan, for a product of its recipe (…0002). If shopping_list_checks ever
  -- gains the per-person membership FK, D's redemption below fails with 23503 instead of leaving
  -- this check behind with its plan.
  insert into public.shopping_list_checks (household_id, plan_id, product_id)
  select d_household, '00000000-0000-4000-b000-00000000dd07', ri.product_id
  from public.recipe_ingredients ri
  join public.recipe_components rc on rc.id = ri.component_id
  where rc.recipe_id = '5eed0002-0000-4000-8000-000000000002'
  order by ri.product_id
  limit 1;
end;
$$;

-- As user C: mint an invite for C's own household.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000c', 'role', 'authenticated')::text,
  true
);

do $$
declare
  v_code text;
begin
  v_code := public.create_household_invite();
  if v_code is null or length(v_code) <> 16 then
    raise exception 'redeem: create_household_invite() returned %, expected a 16-character code', v_code;
  end if;
  if v_code !~ '^[0-9a-f]{16}$' then
    raise exception 'redeem: create_household_invite() returned %, expected 16 lowercase hex characters', v_code;
  end if;
  perform set_config('rls_test.c_code', v_code, true);
end;
$$;

-- As user D (pre-join): the redeemer cannot see the invite they are about to redeem. This is the
-- assertion that proves the invite table's select policy was the right design choice -- a "redeemer
-- reads the invite by code" policy would be un-shippable under the catch-all anyway.
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000d', 'role', 'authenticated')::text,
  true
);

do $$
declare
  n int;
  returned uuid;
begin
  select count(*) into n from public.household_invites;
  if n <> 0 then
    raise exception 'redeem: user D sees % household_invites rows before joining, expected 0', n;
  end if;

  returned := public.redeem_household_invite(current_setting('rls_test.c_code'));
  if returned <> current_setting('rls_test.c_household')::uuid then
    raise exception 'redeem: returned household %, expected C''s household %',
      returned, current_setting('rls_test.c_household');
  end if;
end;
$$;

-- As postgres: the membership moved, the origin household survived memberless and code-free, and
-- the provenance stamp names the origin -- not the target.
reset role;

do $$
declare
  c_household uuid := current_setting('rls_test.c_household')::uuid;
  d_household uuid := current_setting('rls_test.d_household')::uuid;
  inv public.household_invites;
  hh uuid;
  n int;
begin
  select count(*) into n from public.household_members
  where user_id = '00000000-0000-4000-a000-00000000000d' and household_id = c_household;
  if n <> 1 then
    raise exception 'redeem: user D has % membership rows in C''s household, expected 1', n;
  end if;

  select count(*) into n from public.household_members
  where user_id = '00000000-0000-4000-a000-00000000000d';
  if n <> 1 then
    raise exception 'redeem: user D has % membership rows in total, expected 1', n;
  end if;

  select count(*) into n from public.households where id = d_household;
  if n <> 1 then
    raise exception 'redeem: user D''s former household % was destroyed; it must survive with its rows intact', d_household;
  end if;

  select count(*) into n from public.household_members where household_id = d_household;
  if n <> 0 then
    raise exception 'redeem: user D''s former household has % members, expected 0', n;
  end if;

  -- S-02: the composite (household_id, user_id) FK's `on update cascade` carried D's targets along
  -- with the membership update. This is the only proof of that on the hosted project; if it fails,
  -- do not add a move step to redeem_household_invite() -- revisit the design.
  select household_id into hh from public.macro_targets where user_id = '00000000-0000-4000-a000-00000000000d';
  if hh is distinct from c_household then
    raise exception 'redeem: targets did not follow the redeemer: D''s row is in household %, expected %',
      hh, c_household;
  end if;

  select count(*) into n from public.macro_targets where household_id = d_household;
  if n <> 0 then
    raise exception 'redeem: user D''s former household still holds % macro_targets rows, expected 0', n;
  end if;

  -- The origin-side delete: a code the redeemer minted before joining must not stay redeemable,
  -- or anyone holding it could be moved into the orphan.
  select count(*) into n from public.household_invites where household_id = d_household;
  if n <> 0 then
    raise exception 'redeem: user D''s former household still holds % invite rows, expected 0', n;
  end if;

  select * into inv from public.household_invites where code = current_setting('rls_test.c_code');
  if inv.redeemed_at is null then
    raise exception 'redeem: invite was not stamped redeemed_at';
  end if;
  if inv.redeemed_by <> '00000000-0000-4000-a000-00000000000d' then
    raise exception 'redeem: invite redeemed_by is %, expected user D', inv.redeemed_by;
  end if;
  if inv.redeemed_from_household_id <> d_household then
    raise exception 'redeem: invite redeemed_from_household_id is %, expected D''s former household %',
      inv.redeemed_from_household_id, d_household;
  end if;
  -- Catches a redeemed_from_household_id resolved AFTER the membership update: private.user_household_ids()
  -- is stable and each statement runs with a fresh snapshot, so a re-call would return the TARGET
  -- household, permanently sparing the live shared household from README's cleanup query while the
  -- orphan it was meant to protect became deletable on the first pass.
  if inv.redeemed_from_household_id = c_household then
    raise exception 'redeem: invite redeemed_from_household_id equals the TARGET household %; it must name the origin', c_household;
  end if;
end;
$$;

-- As postgres (S-03): the redemption above SUCCEEDED with a "D only" meal in D's household (no
-- membership cascade into plan rows), and D's plan stayed behind in D's former household.
do $$
declare
  d_household uuid := current_setting('rls_test.d_household')::uuid;
  n int;
begin
  select count(*) into n from public.meal_plans
  where id = '00000000-0000-4000-b000-00000000dd07' and household_id = d_household;
  if n <> 1 then
    raise exception 'redeem: D''s plan did not stay behind in D''s former household; plans are household-owned and must not travel';
  end if;

  select count(*) into n from public.plan_meals
  where id = '00000000-0000-4000-b000-00000000dd37' and household_id = d_household
    and eater_user_id = '00000000-0000-4000-a000-00000000000d';
  if n <> 1 then
    raise exception 'redeem: D''s "D only" meal did not stay behind unchanged in D''s former household';
  end if;

  -- S-09: the check on D's plan stayed behind with it, still in D's former household.
  select count(*) into n from public.shopping_list_checks
  where plan_id = '00000000-0000-4000-b000-00000000dd07' and household_id = d_household;
  if n <> 1 then
    raise exception 'redeem: the check on D''s plan did not stay behind in D''s former household; checks are household-owned and must not travel';
  end if;
end;
$$;

-- As user C, then user D: both now see the same household (FR-003), and each still sees exactly the
-- whole public library -- redemption neither adds nor removes library rows.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000c', 'role', 'authenticated')::text,
  true
);

do $$
declare
  t text;
  n int;
  counts text := '';
begin
  select count(*) into n from public.household_members;
  if n <> 2 then
    raise exception 'redeem: user C sees % household_members rows after the join, expected 2', n;
  end if;

  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I', t) into n;
    counts := counts || t || '=' || n || ';';
  end loop;
  if counts <> current_setting('rls_test.library_counts') then
    raise exception 'redeem: user C sees % but the library holds % after the join',
      counts, current_setting('rls_test.library_counts');
  end if;
end;
$$;

-- As user C: the partner reads D's targets (they arrived with D) but cannot write them.
do $$
declare
  n int;
begin
  select count(*) into n from public.macro_targets where user_id = '00000000-0000-4000-a000-00000000000d';
  if n <> 1 then
    raise exception 'targets: user C sees % of partner D''s macro_targets rows after the join, expected 1', n;
  end if;

  update public.macro_targets set kcal = 1 where user_id = '00000000-0000-4000-a000-00000000000d';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'targets: user C updated % of partner D''s macro_targets rows', n;
  end if;

  delete from public.macro_targets where user_id = '00000000-0000-4000-a000-00000000000d';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'targets: user C deleted % of partner D''s macro_targets rows', n;
  end if;
end;
$$;

-- As user C (S-03): D is now a member, so a meal for D is accepted; a user outside the household
-- (A) is still KD012. The 2030-04-01 plan is reused by the account-deletion block at the end; its
-- day 0 lunch (for D) is one batch shared with day 2 lunch (S-08), so that block covers a shared dish.
do $$
declare
  c_household uuid := current_setting('rls_test.c_household')::uuid;
  plan uuid;
  n int;
  v_state text;
  v_msg text;
begin
  plan := public.save_meal_plan('2030-04-01', jsonb_build_array(
    jsonb_build_object('day_index', 0, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000001', 'eater_user_id', '00000000-0000-4000-a000-00000000000d'),
    jsonb_build_object('day_index', 1, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000002', 'eater_user_id', null),
    jsonb_build_object('day_index', 2, 'meal_type', 'lunch',
      'recipe_id', '5eed0002-0000-4000-8000-000000000001', 'eater_user_id', null, 'share_with', '0_lunch')));
  select count(*) into n from public.plan_dishes where plan_id = plan;
  if n <> 2 then
    raise exception 'plans: user C''s plan with one shared batch holds % dishes, expected 2', n;
  end if;
  select count(*) into n from public.plan_meals
  where plan_id = plan and household_id = c_household and eater_user_id = '00000000-0000-4000-a000-00000000000d';
  if n <> 1 then
    raise exception 'plans: user C could not save a meal for partner D after the join';
  end if;
  perform set_config('rls_test.cd_plan', plan::text, true);

  begin
    perform public.save_meal_plan('2030-04-02', jsonb_build_array(
      jsonb_build_object('day_index', 0, 'meal_type', 'lunch',
        'recipe_id', '5eed0002-0000-4000-8000-000000000001', 'eater_user_id', '00000000-0000-4000-a000-00000000000a')));
    raise exception 'plans[KD012]: user C saved a meal for user A, who is not in C''s household';
  exception
    when sqlstate 'KD012' then null;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state = 'P0001' then raise; end if;
      raise exception 'plans[KD012]: rejected with % ("%") instead of KD012', v_state, v_msg;
  end;
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000d', 'role', 'authenticated')::text,
  true
);

do $$
declare
  t text;
  n int;
  counts text := '';
begin
  select count(*) into n from public.household_members;
  if n <> 2 then
    raise exception 'redeem: user D sees % household_members rows after the join, expected 2', n;
  end if;

  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I', t) into n;
    counts := counts || t || '=' || n || ';';
  end loop;
  if counts <> current_setting('rls_test.library_counts') then
    raise exception 'redeem: user D sees % but the library holds % after the join',
      counts, current_setting('rls_test.library_counts');
  end if;
end;
$$;

-- As user D (S-03): D now sees C's plans (the shared household's) and no longer its old one.
do $$
declare
  c_household uuid := current_setting('rls_test.c_household')::uuid;
  n int;
begin
  select count(*) into n from public.meal_plans where household_id <> c_household;
  if n <> 0 then
    raise exception 'plans: after the join user D sees % meal_plans rows outside the shared household', n;
  end if;
  select count(*) into n from public.meal_plans where id = '00000000-0000-4000-b000-00000000cc07';
  if n <> 1 then
    raise exception 'plans: after the join user D cannot see C''s fixture plan';
  end if;
  select count(*) into n from public.meal_plans where id = '00000000-0000-4000-b000-00000000dd07';
  if n <> 0 then
    raise exception 'plans: after the join user D still sees its old plan';
  end if;
  select count(*) into n from public.plan_meals where id = '00000000-0000-4000-b000-00000000dd37';
  if n <> 0 then
    raise exception 'plans: after the join user D still sees its old "D only" meal';
  end if;
end;
$$;

-- As user D: still owns (and can write) its targets in the shared household, and cannot create a
-- row for partner C. C has no row, and (c_household, C) is a valid membership pair, so the
-- composite FK allows it: the owner predicate is the only defence, and nothing but
-- insufficient_privilege may stop this insert.
do $$
declare
  c_household uuid := current_setting('rls_test.c_household')::uuid;
  n int;
begin
  update public.macro_targets set kcal = 1900, updated_at = now()
  where user_id = '00000000-0000-4000-a000-00000000000d';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'targets: user D updated % own macro_targets rows after the join, expected 1', n;
  end if;

  begin
    insert into public.macro_targets (user_id, household_id, kcal, protein_g, fat_g, carbs_g)
    values ('00000000-0000-4000-a000-00000000000c', c_household, 2000, 100, 50, 200);
    raise exception 'targets: partner could insert targets for the other member';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rejections, one per SQLSTATE. Each block lets a WRONG rejection reason fail the test instead of
-- being swallowed -- which the established `when insufficient_privilege` idiom cannot do, since a
-- definer raise is not a privilege error.
--
-- The `when others` branch is not decoration. The validations are ORDERED, so deleting any one check
-- makes the NEXT one fire (or lets the redemption succeed), and a bare "expected KD005" failure would
-- send a maintainer after the wrong check. The branch names the code that actually fired and the one
-- that was expected. P0001 is re-raised untouched because that is this file's own assertion failures.
--
-- The partial unique index permits only one unredeemed invite per household, so each case needs its
-- own host household. Every remaining case raises before any write, so no state is disturbed (the
-- non-seed-rows guard, the one probe that would have moved user A on regression, is retired with
-- F-04). The rejection block still stays after every block that reads the rls_test.a_household /
-- b_household GUCs, so a regression that lets a probe succeed can never corrupt an earlier assertion.
-- ---------------------------------------------------------------------------

-- KD003: the same code cannot be redeemed twice (checked before KD004, so D re-redeeming its own
-- new household's code still reports "already used").
do $$
declare
  v_state text;
  v_msg text;
begin
  perform public.redeem_household_invite(current_setting('rls_test.c_code'));
  raise exception 'redeem[KD003]: reused code was accepted';
exception
  when sqlstate 'KD003' then null;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = 'P0001' then raise; end if;
    raise exception 'redeem[KD003]: rejected with % ("%") instead of KD003', v_state, v_msg;
end;
$$;

-- KD005 on the create path: C's household now has two members, so no further code can be minted.
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000c', 'role', 'authenticated')::text,
  true
);

do $$
declare
  v_state text;
  v_msg text;
begin
  perform public.create_household_invite();
  raise exception 'invites[KD005]: create_household_invite() succeeded in a two-member household';
exception
  when sqlstate 'KD005' then null;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = 'P0001' then raise; end if;
    raise exception 'invites[KD005]: create_household_invite() failed with % ("%") instead of KD005', v_state, v_msg;
end;
$$;

-- KD001 on a stale origin code: F mints a code for F's own household, then redeems E's code. The
-- move must have deleted F's code, or anyone holding that link could be moved into F's orphan.
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000f', 'role', 'authenticated')::text,
  true
);

do $$
begin
  perform set_config('rls_test.f_code', public.create_household_invite(), true);
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000e', 'role', 'authenticated')::text,
  true
);

do $$
begin
  perform set_config('rls_test.e_code', public.create_household_invite(), true);
end;
$$;

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000f', 'role', 'authenticated')::text,
  true
);

do $$
declare
  returned uuid;
  v_state text;
  v_msg text;
begin
  returned := public.redeem_household_invite(current_setting('rls_test.e_code'));
  if returned <> current_setting('rls_test.e_household')::uuid then
    raise exception 'redeem: F joined household %, expected E''s household %',
      returned, current_setting('rls_test.e_household');
  end if;

  begin
    perform public.redeem_household_invite(current_setting('rls_test.f_code'));
    raise exception 'redeem[KD001]: F''s stale origin code was still redeemable after F moved out; anyone holding that link could be moved into F''s orphaned household';
  exception
    when sqlstate 'KD001' then null;
    when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      if v_state = 'P0001' then raise; end if;
      raise exception 'redeem[KD001]: stale origin code rejected with % ("%") instead of KD001, so the origin-side delete did not run', v_state, v_msg;
  end;
end;
$$;

-- KD008: an already-linked caller cannot be moved out of their couple. C is in a two-member household
-- after the redemption above; B's fixture invite is live and points at B's one-member household, so
-- KD004/KD002/KD003 all pass and the origin-side cap is the first check that can fire. Without it C
-- would leave D alone in the shared household with no application path back.
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000c', 'role', 'authenticated')::text,
  true
);

do $$
declare
  v_state text;
  v_msg text;
begin
  perform public.redeem_household_invite('b0b0b0b0b0b0b002');
  raise exception 'redeem[KD008]: an already-linked caller was moved out of their household, abandoning their partner';
exception
  when sqlstate 'KD008' then null;
  when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = 'P0001' then raise; end if;
    raise exception 'redeem[KD008]: rejected with % ("%") instead of KD008', v_state, v_msg;
end;
$$;

-- As postgres: three invites that only a direct insert can create -- an expired one, a live one
-- pointing at a household that is already full, and a live one pointing at a household nobody is in
-- (the shape left behind when an inviter deletes their account inside the 7-day TTL; D's former
-- household is memberless after the redemption above and its unredeemed slot is free).
reset role;

insert into public.household_invites (household_id, code, created_by, expires_at)
values
  (current_setting('rls_test.c_household')::uuid, 'e0e0e0e0e0e0e001',
    '00000000-0000-4000-a000-00000000000c', now() - interval '1 day'),
  (current_setting('rls_test.e_household')::uuid, 'f0f0f0f0f0f0f002',
    '00000000-0000-4000-a000-00000000000e', now() + interval '7 days'),
  (current_setting('rls_test.d_household')::uuid, 'd0d0d0d0d0d0d009',
    null, now() + interval '7 days');

-- User A is the rejection probe for the rest: it never moved, still owns a one-person household, and
-- holds its own fixture invite.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', '00000000-0000-4000-a000-00000000000a', 'role', 'authenticated')::text,
  true
);

do $$
declare
  cases text[][] := array[
    -- code, expected SQLSTATE, what the case proves
    array['00000000deadbeef', 'KD001', 'unknown code was accepted'],
    -- Checked before KD005, so the full target household is irrelevant here.
    array['e0e0e0e0e0e0e001', 'KD002', 'expired code was accepted'],
    -- A's own fixture invite points at A's own household.
    array['a0a0a0a0a0a0a001', 'KD004', 'an invite to the caller''s own household was accepted'],
    -- E's household already holds two members (E and F).
    array['f0f0f0f0f0f0f002', 'KD005', 'a full target household accepted a third member'],
    -- D's former household survived the redemption memberless, so this invite points at a household
    -- nobody is in. Without KD009 this redemption would succeed and move A there.
    array['d0d0d0d0d0d0d009', 'KD009', 'an invite to a household with no members left was accepted']
  ];
  i int;
  v_state text;
  v_msg text;
begin
  for i in 1 .. array_length(cases, 1) loop
    begin
      perform public.redeem_household_invite(cases[i][1]);
      raise exception 'redeem[%]: %', cases[i][2], cases[i][3];
    exception
      when others then
        get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
        if v_state = 'P0001' then raise; end if;
        if v_state <> cases[i][2] then
          raise exception 'redeem[%]: rejected with % ("%") instead of %',
            cases[i][2], v_state, v_msg, cases[i][2];
        end if;
    end;
  end loop;
end;
$$;

reset role;

-- As postgres (S-03), last because it removes a member: deleting D's account turns D's meals into
-- "both" (eater_user_id on delete set null) -- no slot disappears and no dish is orphaned, including
-- the batch D's meal shares with another day (S-08).
do $$
declare
  plan uuid := current_setting('rls_test.cd_plan')::uuid;
  meals_before int;
  dishes_before int;
  n int;
begin
  select count(*) into meals_before from public.plan_meals where plan_id = plan;
  select count(*) into dishes_before from public.plan_dishes where plan_id = plan;

  delete from auth.users where id = '00000000-0000-4000-a000-00000000000d';

  select count(*) into n from public.plan_meals where plan_id = plan and eater_user_id is not null;
  if n <> 0 then
    raise exception 'plans: % meals still name deleted user D, expected eater_user_id set to null', n;
  end if;
  select count(*) into n from public.plan_meals where plan_id = plan;
  if n <> meals_before then
    raise exception 'plans: deleting user D changed the plan''s meal count from % to %', meals_before, n;
  end if;
  select count(*) into n from public.plan_dishes where plan_id = plan;
  if n <> dishes_before then
    raise exception 'plans: deleting user D changed the plan''s dish count from % to %', dishes_before, n;
  end if;
end;
$$;

-- As postgres (S-04), very last because it destroys A's household: deleting a household cascades
-- its plans and their day solutions (the whole transaction is rolled back).
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  sol uuid := current_setting('rls_test.a_solution')::uuid;
  n int;
begin
  select count(*) into n from public.plan_day_solutions where id = sol;
  if n <> 1 then
    raise exception 'solutions: A''s day solution is missing before the household delete';
  end if;
  select count(*) into n from public.shopping_list_checks where household_id = a_household;
  if n <> 2 then
    raise exception 'checks: A holds % shopping_list_checks rows before the household delete, expected 2', n;
  end if;

  delete from public.households where id = a_household;

  select count(*) into n from public.plan_day_solutions where id = sol or household_id = a_household;
  if n <> 0 then
    raise exception 'solutions: deleting A''s household left % plan_day_solutions rows behind', n;
  end if;

  -- S-09: A's shopping-list checks (the fixture row and the 2030-06-01 row) cascade with it too.
  select count(*) into n from public.shopping_list_checks where household_id = a_household;
  if n <> 0 then
    raise exception 'checks: deleting A''s household left % shopping_list_checks rows behind', n;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Done.
-- ---------------------------------------------------------------------------
do $$
begin
  raise notice 'household_isolation: all assertions passed (trigger, sign-up creates no library rows, read isolation, write denial, public library visibility, library write denial and grants, seed mechanism removed, classification catch-all, anon denial, helper grants, household_id catch-all, invite read isolation, invite write denial, RPC grants, redemption with provenance and an unchanged library, macro targets isolation with owner-only writes and the redemption cascade, seven rejection SQLSTATEs, meal plans isolation, write denial, grants, RPC grants, slot diff, KD010-KD012 and plans left behind on redemption, shared dishes across days with the regrouping diff and KD015-KD017, day solutions isolation, write denial, grants, atomic group upsert, KD013/KD014 and the household cascade, shopping-list checks isolation, write denial, grants, idempotent check/uncheck, KD007/KD014/KD018/KD019, checks left behind on redemption and the household cascade)';
end;
$$;

select 'household_isolation: all assertions passed (incl. public library, classification catch-all, invite isolation, RPC grants, redemption, macro targets, seven rejection SQLSTATEs, meal plans, shared dishes, day solutions and shopping-list checks)' as result;

rollback;
