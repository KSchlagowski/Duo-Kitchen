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

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps',
    'household_invites', 'macro_targets'] loop
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

-- ---------------------------------------------------------------------------
-- Done.
-- ---------------------------------------------------------------------------
do $$
begin
  raise notice 'household_isolation: all assertions passed (trigger, sign-up creates no library rows, read isolation, write denial, public library visibility, library write denial and grants, seed mechanism removed, classification catch-all, anon denial, helper grants, household_id catch-all, invite read isolation, invite write denial, RPC grants, redemption with provenance and an unchanged library, macro targets isolation with owner-only writes and the redemption cascade, seven rejection SQLSTATEs)';
end;
$$;

select 'household_isolation: all assertions passed (incl. public library, classification catch-all, invite isolation, RPC grants, redemption, macro targets and seven rejection SQLSTATEs)' as result;

rollback;
