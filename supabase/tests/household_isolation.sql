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

  -- Invites (S-01), fixture id 6 in the same scheme. One live bearer code per household, so they
  -- occupy each household's household_invites_one_unredeemed_idx slot. Inserted as postgres because
  -- authenticated has no insert grant -- which the denial block below asserts.
  insert into public.household_invites (id, household_id, code, created_by, expires_at)
  values
    ('00000000-0000-4000-b000-00000000a006', a_household, 'a0a0a0a0a0a0a001',
      '00000000-0000-4000-a000-00000000000a', now() + interval '7 days'),
    ('00000000-0000-4000-b000-00000000b006', b_household, 'b0b0b0b0b0b0b002',
      '00000000-0000-4000-a000-00000000000b', now() + interval '7 days');
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

-- As user A: products, recipe and invite tables are scoped to A's household.
-- household_invites is element 6: fixture ids …a006 / …b006 continue the id-indexed scheme.
do $$
declare
  a_household uuid := current_setting('rls_test.a_household')::uuid;
  t text;
  i int;
  n int;
  tables text[] := array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps',
    'household_invites'];
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
    'household_invites'] loop
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
  n int;
  t text;
  copied int;
  templates int;
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

  -- No duplicate seed set and no merge: the target's seeded counts still equal the templates.
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I where household_id = $1 and seed_id is not null', t)
      into copied using c_household;
    execute format('select count(*) from private.%I', 'seed_' || t) into templates;
    if copied <> templates then
      raise exception 'redeem: target household has % seeded % rows after redemption, expected % (private.seed_%) -- a merge or a duplicate seed set happened',
        copied, t, templates, t;
    end if;
  end loop;

  -- The counts above CANNOT detect a re-seed: private.seed_household() is `on conflict do nothing`,
  -- so re-running it on an already-seeded household inserts nothing and every count still matches.
  -- The stated guarantee is "redemption never re-enters seed_household()", and the only
  -- non-vacuous way to assert it is on the function body itself. It matters because seed_household()
  -- re-inserts rows a household DELETED (see its own header comment), so once S-05 lets households
  -- delete seed rows, a redemption that re-seeded would silently resurrect them.
  if (select p.prosrc from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'redeem_household_invite') like '%seed_household%' then
    raise exception 'redeem: public.redeem_household_invite() references seed_household(); redemption must never re-seed';
  end if;
end;
$$;

-- As user C, then user D: both now see the same household and the same library (FR-003).
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
  perform set_config('rls_test.c_counts', counts, true);
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
  if counts <> current_setting('rls_test.c_counts') then
    raise exception 'redeem: user D sees % but user C sees % -- linked accounts must read identical rows',
      counts, current_setting('rls_test.c_counts');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rejections, one per SQLSTATE. Each block lets a WRONG rejection reason fail the test instead of
-- being swallowed -- which the established `when insufficient_privilege` idiom cannot do, since a
-- definer raise is not a privilege error.
--
-- The `when others` branch is not decoration. The validations are ORDERED, so deleting any one check
-- makes the NEXT one fire: drop the KD005 cap and this file would otherwise report "caller household
-- holds 6 non-seed rows", sending a maintainer after the KD006 guard that is working fine. The
-- branch names the code that actually fired and the one that was expected. P0001 is re-raised
-- untouched because that is this file's own assertion failures.
--
-- The partial unique index permits only one unredeemed invite per household, so each case needs its
-- own host household. Every case here raises before any write, so no state is disturbed.
--
-- The ordering is load-bearing, not incidental: the KD006 case is last because it is the one probe
-- that WOULD mutate on regression (user A actually moves), and nothing after it may read the
-- rls_test.a_household / b_household GUCs.
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

-- User A is the rejection probe for the rest: it never moved, still owns a one-person household,
-- holds its own fixture invite, and its household holds fixture rows with seed_id is null.
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
    -- A's household holds the fixture rows, which have seed_id is null, so redeeming would leave
    -- real data behind. B's fixture invite is live and B's household has one member, so KD006 is
    -- the first check that can fire.
    array['b0b0b0b0b0b0b002', 'KD006', 'a caller holding non-seed rows was allowed to leave them behind'],
    -- D's former household survived the redemption memberless, so this invite points at a household
    -- nobody is in. Checked before KD006, so A's non-seed fixture rows do not mask it.
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
  raise notice 'household_isolation: all assertions passed (trigger, seed copy, read isolation, write denial, products/recipes isolation and cross-household FKs, template/seed-function denial, anon denial, helper grants, household_id catch-all, invite read isolation, invite write denial, RPC grants, redemption with provenance and unchanged seed counts, eight rejection SQLSTATEs)';
end;
$$;

select 'household_isolation: all assertions passed (incl. invite isolation, RPC grants, redemption and eight rejection SQLSTATEs)' as result;

rollback;
