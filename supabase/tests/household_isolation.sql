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
  raise notice 'household_isolation: all assertions passed (trigger, read isolation, write denial, anon denial, helper grants, household_id catch-all)';
end;
$$;

select 'household_isolation: all assertions passed' as result;

rollback;
