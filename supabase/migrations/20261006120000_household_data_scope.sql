-- Household-scoped data access (roadmap F-01).
--
-- Every account belongs to exactly one household (a household of one at sign-up).
-- Every household-owned table scopes its RLS policies with:
--   household_id in (select private.user_household_ids())

-- ---------------------------------------------------------------------------
-- Private schema: not exposed through the API (see supabase/config.toml [api].schemas),
-- so security-definer helpers kept here are not callable as RPC endpoints.
-- ---------------------------------------------------------------------------
create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.households (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

comment on table public.households is 'A household of linked accounts that share all household data.';

create table public.household_members (
  household_id uuid not null references public.households on delete cascade,
  -- unique: one household per person
  user_id uuid not null unique references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

comment on table public.household_members is 'Links an account to its household. Written only by security-definer functions.';

-- ---------------------------------------------------------------------------
-- Access helper: the single answer to "which households does the caller belong to".
-- Security definer bypasses RLS on household_members, which avoids policy recursion.
-- Extension point: the AI agent acting on a household's command (S-12) extends this function.
-- ---------------------------------------------------------------------------
create function private.user_household_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select hm.household_id
  from public.household_members hm
  where hm.user_id = (select auth.uid());
$$;

revoke execute on function private.user_household_ids() from public, anon;
grant execute on function private.user_household_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Intentionally no insert/update/delete policies on either table, for any role, and no
-- policies for anon. Membership changes happen only through security-definer functions:
-- the sign-up trigger below now, the S-01 join function later.
-- ---------------------------------------------------------------------------
alter table public.households enable row level security;
alter table public.household_members enable row level security;

revoke all on public.households from anon;
revoke all on public.household_members from anon;
revoke insert, update, delete, truncate, references, trigger on public.households from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.household_members from authenticated;

create policy "households_select_authenticated"
  on public.households
  for select
  to authenticated
  using (id in (select private.user_household_ids()));

-- Calls the helper rather than querying household_members itself (no recursion).
-- Members see their partner's row once S-01 links them.
create policy "household_members_select_authenticated"
  on public.household_members
  for select
  to authenticated
  using (household_id in (select private.user_household_ids()));

-- ---------------------------------------------------------------------------
-- Sign-up trigger: every new account gets its own household, atomically.
-- ---------------------------------------------------------------------------
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_household_id uuid;
begin
  insert into public.households default values
  returning id into new_household_id;

  insert into public.household_members (household_id, user_id)
  values (new_household_id, new.id);

  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Backfill: accounts created before this migration get their own household (idempotent).
-- ---------------------------------------------------------------------------
do $$
declare
  u record;
  new_household_id uuid;
begin
  for u in
    select au.id
    from auth.users au
    where not exists (
      select 1 from public.household_members hm where hm.user_id = au.id
    )
  loop
    insert into public.households default values
    returning id into new_household_id;

    insert into public.household_members (household_id, user_id)
    values (new_household_id, u.id);
  end loop;
end;
$$;
