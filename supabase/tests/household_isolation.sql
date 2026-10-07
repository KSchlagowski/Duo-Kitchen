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
-- Impersonation:
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('sub', <uid>, 'role', 'authenticated')::text, true);
-- Switch back to postgres with `reset role`.

begin;

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
-- Products and recipes (F-02), as postgres: the trigger copied the seed set into both households,
-- and one fixture chain (product -> recipe -> component -> ingredient -> step) per household.
-- Fixture ids: 00000000-0000-4000-b000-00000000<a|b>00<1..5> (1 product, 2 recipe, 3 component,
-- 4 ingredient, 5 step).
-- ---------------------------------------------------------------------------
do $$
declare
  hh uuid;
  t text;
  copied int;
  templates int;
begin
  foreach hh in array array[
    current_setting('rls_test.a_household')::uuid,
    current_setting('rls_test.b_household')::uuid
  ] loop
    foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
      execute format('select count(*) from public.%I where household_id = $1 and seed_id is not null', t)
        into copied using hh;
      execute format('select count(*) from private.%I', 'seed_' || t) into templates;
      if copied <> templates then
        raise exception 'trigger seeding: household % has % seeded % rows, expected % (private.seed_%)',
          hh, copied, t, templates, t;
      end if;
    end loop;
  end loop;
end;
$$;

do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  b_household uuid := current_setting('rls_test.b_household')::uuid;
begin
  insert into public.products (id, household_id, name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, aisle)
  values
    ('00000000-0000-4000-b000-00000000a001', a_household, 'RLS test product A', 100, 10, 2, 10, 'other'),
    ('00000000-0000-4000-b000-00000000b001', b_household, 'RLS test product B', 100, 10, 2, 10, 'other');

  insert into public.recipes (id, household_id, name, cuisine, prep_minutes, division_mode)
  values
    ('00000000-0000-4000-b000-00000000a002', a_household, 'RLS test recipe A', 'test', 10, 'whole_dish'),
    ('00000000-0000-4000-b000-00000000b002', b_household, 'RLS test recipe B', 'test', 10, 'whole_dish');

  insert into public.recipe_components (id, household_id, recipe_id, position, name)
  values
    ('00000000-0000-4000-b000-00000000a003', a_household, '00000000-0000-4000-b000-00000000a002', 1, 'A'),
    ('00000000-0000-4000-b000-00000000b003', b_household, '00000000-0000-4000-b000-00000000b002', 1, 'B');

  insert into public.recipe_ingredients (id, household_id, component_id, product_id, position, base_amount_g)
  values
    ('00000000-0000-4000-b000-00000000a004', a_household, '00000000-0000-4000-b000-00000000a003',
      '00000000-0000-4000-b000-00000000a001', 1, 100),
    ('00000000-0000-4000-b000-00000000b004', b_household, '00000000-0000-4000-b000-00000000b003',
      '00000000-0000-4000-b000-00000000b001', 1, 100);

  insert into public.recipe_steps (id, household_id, recipe_id, position, instruction, timing, component_id)
  values
    ('00000000-0000-4000-b000-00000000a005', a_household, '00000000-0000-4000-b000-00000000a002', 1,
      'Step A', 'fresh', '00000000-0000-4000-b000-00000000a003'),
    ('00000000-0000-4000-b000-00000000b005', b_household, '00000000-0000-4000-b000-00000000b002', 1,
      'Step B', 'fresh', '00000000-0000-4000-b000-00000000b003');
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

-- As user A: products and recipe tables are scoped to A's household.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  t text;
  i int;
  n int;
  tables text[] := array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'];
begin
  for i in 1 .. array_length(tables, 1) loop
    t := tables[i];

    execute format('select count(*) from public.%I where household_id <> $1', t) into n using a_household;
    if n <> 0 then
      raise exception 'read: user A sees % public.% rows of other households; every row must have household_id = a_household', n, t;
    end if;

    execute format('select count(*) from public.%I where id = $1', t)
      into n using format('00000000-0000-4000-b000-00000000b00%s', i)::uuid;
    if n <> 0 then
      raise exception 'read: user A can see B''s fixture row in public.%; B''s fixture ids must be invisible', t;
    end if;

    execute format('select count(*) from public.%I where id = $1', t)
      into n using format('00000000-0000-4000-b000-00000000a00%s', i)::uuid;
    if n <> 1 then
      raise exception 'read: user A cannot see own fixture row in public.%', t;
    end if;
  end loop;
end;
$$;

-- As user A: writes only into A's own household; no cross-household references.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  b_household uuid := current_setting('rls_test.b_household')::uuid;
  t text;
  i int;
  n int;
  tables text[] := array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'];
begin
  insert into public.products (household_id, name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, aisle)
  values (a_household, 'RLS test product A2', 100, 10, 2, 10, 'other');

  begin
    insert into public.products (household_id, name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, aisle)
    values (b_household, 'RLS test product B2', 100, 10, 2, 10, 'other');
    raise exception 'write: user A could insert a product into household B';
  exception when insufficient_privilege then null;
  end;

  for i in 1 .. array_length(tables, 1) loop
    t := tables[i];

    execute format('update public.%I set created_at = now() where id = $1', t)
      using format('00000000-0000-4000-b000-00000000b00%s', i)::uuid;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'write: user A updated % of B''s public.% rows', n, t;
    end if;

    execute format('delete from public.%I where id = $1', t)
      using format('00000000-0000-4000-b000-00000000b00%s', i)::uuid;
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'write: user A deleted % of B''s public.% rows', n, t;
    end if;
  end loop;

  begin
    -- Composite FK (product_id, household_id): A's ingredient cannot point at B's product.
    insert into public.recipe_ingredients (household_id, component_id, product_id, position, base_amount_g)
    values (a_household, '00000000-0000-4000-b000-00000000a003', '00000000-0000-4000-b000-00000000b001', 99, 100);
    raise exception 'write: user A could reference B''s product from an ingredient';
  exception when foreign_key_violation then null;
  end;

  begin
    -- A product used by an ingredient cannot be deleted (on delete restrict raises restrict_violation).
    delete from public.products where id = '00000000-0000-4000-b000-00000000a001';
    raise exception 'write: user A could delete a product still used by an ingredient';
  exception when restrict_violation or foreign_key_violation then null;
  end;

  begin
    truncate public.products;
    raise exception 'write: user A could truncate public.products';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- As user A: the seed templates and the seed function are unreachable.
do $$
declare
  t text;
begin
  foreach t in array array['seed_products', 'seed_recipes', 'seed_recipe_components', 'seed_recipe_ingredients', 'seed_recipe_steps'] loop
    begin
      execute format('select count(*) from private.%I', t);
      raise exception 'templates: user A could read private.%', t;
    exception when insufficient_privilege then null;
    end;
  end loop;

  begin
    perform private.seed_household(current_setting('rls_test.a_household')::uuid);
    raise exception 'templates: user A could execute private.seed_household()';
  exception when insufficient_privilege then null;
  end;
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
end;
$$;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
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
    where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'household_members'
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
-- Done.
-- ---------------------------------------------------------------------------
do $$
begin
  raise notice 'household_isolation: all assertions passed (trigger, seed copy, read isolation, write denial, products/recipes isolation and cross-household FKs, template/seed-function denial, anon denial, helper grants, household_id catch-all)';
end;
$$;

select 'household_isolation: all assertions passed' as result;

rollback;
