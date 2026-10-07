-- Household invites and redemption (roadmap S-01, PRD FR-002/FR-003).
--
-- One partner mints a bearer code for their household; the other redeems it and their single
-- membership row moves into the inviter's household. The F-01 policy layer then delivers FR-003
-- for free: every policy is already `household_id in (select private.user_household_ids())`, so
-- both accounts read and write the same rows the moment the membership row moves.
--
-- This migration introduces the first `create function public.*` in the repo. Client-callable
-- functions must live in `public` because the `private` schema is deliberately not API-exposed
-- (see 20261006120000_household_data_scope.sql:7-9) and so is unreachable as an RPC endpoint.
--
-- Rollback: drop function public.redeem_household_invite(text), then
--           drop function public.create_household_invite(), then
--           drop table public.household_invites.
-- Safe while no invite has been redeemed. AFTER any redemption, dropping the table discards the
-- redeemed_from_household_id provenance -- the only record linking a memberless household to the
-- partner who left it, and what README's amended cleanup query relies on to spare that household.

-- ---------------------------------------------------------------------------
-- Table: one live bearer code per household, plus the provenance of a completed redemption.
-- ---------------------------------------------------------------------------
create table public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  code text not null unique,
  -- Deliberately nullable and `on delete set null`, matching redeemed_by: a cascade would take the
  -- whole invite row away when the inviter's account is deleted, and with it the
  -- redeemed_from_household_id that README's cleanup query needs to spare the redeemer's preserved
  -- household -- turning one account deletion into silent collateral loss on the next cleanup run.
  -- Anything reading created_by must handle null.
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users on delete set null,
  redeemed_from_household_id uuid references public.households on delete set null
);

comment on table public.household_invites is
  'Bearer invite codes for linking a partner into a household (S-01). Written only by the security-definer functions below: insert/update/delete are revoked from authenticated, and the matching policies exist solely to satisfy the household_id catch-all in supabase/tests/household_isolation.sql. Clients keep select so the inviter can show and regenerate their own code. redeemed_from_household_id is the only record linking a memberless household to the partner who left it.';

-- F-02 satisfied the CLAUDE.md household_id-index rule implicitly, via the leading column of
-- `unique (household_id, seed_id)`. There is no seed_id here, so the index is explicit.
create index household_invites_household_id_idx on public.household_invites (household_id);

-- Only one unredeemed invite per household. The predicate cannot include
-- `expires_at > now()` (not immutable), which is why create_household_invite()
-- deletes the previous unredeemed row rather than relying on this index alone.
create unique index household_invites_one_unredeemed_idx
  on public.household_invites (household_id)
  where redeemed_at is null;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Policies + revokes are independent levers (F-01 precedent, 20261006120000:66-69):
-- the policies below satisfy supabase/tests/household_isolation.sql's household_id
-- catch-all, which inspects pg_policies only; the revokes above make the
-- insert/update/delete ones unreachable. Writes go through the definer RPCs only.
-- Do not "simplify" by dropping either half.
--
-- TRUNCATE bypasses RLS, so it is revoked along with references/trigger (F-01/F-02 precedent).
-- ---------------------------------------------------------------------------
alter table public.household_invites enable row level security;

revoke all on public.household_invites from anon;
revoke insert, update, delete, truncate, references, trigger on public.household_invites from authenticated;

create policy "household_invites_select_authenticated" on public.household_invites
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "household_invites_insert_authenticated" on public.household_invites
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "household_invites_update_authenticated" on public.household_invites
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "household_invites_delete_authenticated" on public.household_invites
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- ---------------------------------------------------------------------------
-- Rejection SQLSTATEs, class KD (not reserved by PostgreSQL). Distinct codes rather than one
-- P0001 so the isolation test can assert the precise reason and the API can map each to its own
-- user-facing message (src/lib/services/invites.ts).
--
--   KD001  no invite with that code
--   KD002  invite expired
--   KD003  invite already redeemed
--   KD004  the invite's household is already the caller's
--   KD005  the target household already has two members
--   KD006  the caller's household holds non-seed rows that would be left behind
--   KD007  no authenticated caller, or the caller has no household
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- create_household_invite(): mint a fresh code for the caller's own household, replacing any
-- previous unredeemed one. Creation goes through an RPC rather than a plain insert under the
-- insert policy so that code entropy, the expiry window and the one-live-invite rule stay
-- server-controlled -- which is what lets the insert grant stay revoked.
-- ---------------------------------------------------------------------------
create function public.create_household_invite()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_members int;
  v_code text;
begin
  select hid into v_household from private.user_household_ids() as hid limit 1;
  if (select auth.uid()) is null or v_household is null then
    raise exception 'no household for caller' using errcode = 'KD007';
  end if;

  select count(*) into v_members
  from public.household_members
  where household_id = v_household;
  if v_members >= 2 then
    raise exception 'household already has two members' using errcode = 'KD005';
  end if;

  -- Serialise concurrent calls (a double-clicked "Generate new code") on the household row.
  -- Without this both callers find nothing to delete, both insert, and the loser hits
  -- household_invites_one_unredeemed_idx with unique_violation (23505) -- which is not a KD0xx
  -- code and so could only surface as inviteErrorMessage()'s neutral fallback. With the lock the
  -- second caller simply mints the next code and no new SQLSTATE is needed.
  perform 1 from public.households where id = v_household for update;

  delete from public.household_invites
  where household_id = v_household and redeemed_at is null;

  -- 64 bits, no extension dependency: gen_random_uuid() is a pg13+ built-in and so
  -- resolves under `set search_path = ''`. extensions.gen_random_bytes() would also
  -- work but needs schema qualification that extra_search_path does not supply here.
  v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);

  insert into public.household_invites (household_id, code, created_by, expires_at)
  values (v_household, v_code, (select auth.uid()), now() + interval '7 days');

  return v_code;
end;
$$;

revoke execute on function public.create_household_invite() from public, anon;
grant execute on function public.create_household_invite() to authenticated;

comment on function public.create_household_invite() is
  'Mints a 16-hex bearer code valid 7 days for the caller''s household, replacing any previous unredeemed one. Refuses at two members (KD005) or with no household (KD007).';

-- ---------------------------------------------------------------------------
-- redeem_household_invite(): the S-01 join function reserved at
-- 20261006120000_household_data_scope.sql:56-62. Validates a bearer code and moves the caller's
-- single membership row into the invite's household, atomically, stamping provenance.
--
-- Never calls private.seed_household(), so redemption can never re-seed the target household --
-- the guarantee asserted in supabase/tests/household_isolation.sql. The sign-up trigger is the
-- only caller of seed_household() and it fires on auth.users inserts only.
-- ---------------------------------------------------------------------------
create function public.redeem_household_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_origin_household uuid;
  v_invite public.household_invites;
  v_members int;
  v_non_seed int;
begin
  -- Resolved ONCE, before any write, and reused for the KD004/KD006 checks and the provenance
  -- stamp. private.user_household_ids() is `stable` and each plpgsql statement runs with a fresh
  -- snapshot, so re-calling it after the membership update below would return the TARGET household
  -- and silently stamp redeemed_from_household_id with the live shared household -- inverting the
  -- protection README's cleanup query builds on that column.
  select hid into v_origin_household from private.user_household_ids() as hid limit 1;
  if (select auth.uid()) is null or v_origin_household is null then
    raise exception 'no household for caller' using errcode = 'KD007';
  end if;

  -- `for update` BEFORE validating, so two concurrent redemptions of the same code cannot both
  -- see redeemed_at is null.
  select * into v_invite
  from public.household_invites
  where code = p_code
  for update;

  if v_invite.id is null then
    raise exception 'no invite with that code' using errcode = 'KD001';
  end if;
  if v_invite.redeemed_at is not null then
    raise exception 'invite already redeemed' using errcode = 'KD003';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'invite expired' using errcode = 'KD002';
  end if;
  if v_invite.household_id = v_origin_household then
    raise exception 'already in that household' using errcode = 'KD004';
  end if;

  -- Caps the TARGET household only. There is deliberately no symmetric cap on the caller's own
  -- household, because S-01 ships no leave/unlink path and adding one was out of scope -- but that
  -- means an ALREADY-LINKED caller who follows a third party's invite link is moved out of the
  -- couple, leaving their partner alone in the shared household, and only KD006 can stop it (and
  -- only if the couple had added non-seed rows). /join renders the confirm form for such a caller.
  -- If that path matters, the fix is an origin-side `v_origin_members >= 2` check with its own
  -- SQLSTATE; it needs a user-facing message, so it is a product decision, not a silent addition.
  select count(*) into v_members
  from public.household_members
  where household_id = v_invite.household_id;
  if v_members >= 2 then
    raise exception 'target household already has two members' using errcode = 'KD005';
  end if;

  -- Guards additions, not deletions: a household that deleted seed rows passes this
  -- check and loses those deletions. Nothing can delete seed rows today (S-05 is
  -- proposed); the slice that enables it must revisit this guard.
  select
    (select count(*) from public.products where household_id = v_origin_household and seed_id is null)
    + (select count(*) from public.recipes where household_id = v_origin_household and seed_id is null)
    + (select count(*) from public.recipe_components where household_id = v_origin_household and seed_id is null)
    + (select count(*) from public.recipe_ingredients where household_id = v_origin_household and seed_id is null)
    + (select count(*) from public.recipe_steps where household_id = v_origin_household and seed_id is null)
  into v_non_seed;
  if v_non_seed > 0 then
    raise exception 'caller household holds % non-seed rows', v_non_seed using errcode = 'KD006';
  end if;

  -- 1. The caller's own household is about to become memberless, so any live bearer code pointing
  --    at it must die with the move. Without this, a code the caller minted before joining stays
  --    redeemable: no validation rejects it afterwards (KD005 counts the INVITE's household, which
  --    now has 0 members, not >= 2; KD004 only rejects your own household), so the inviter -- or
  --    any third party ever sent that link -- could be moved into the orphan, splitting the couple
  --    and handing them the caller's pre-redemption kitchen. Redemption is irreversible by any
  --    application path, so recovery would need postgres.
  delete from public.household_invites
  where household_id = v_origin_household and redeemed_at is null;

  -- 2. The move itself. household_members.user_id is unique (one household per person), so this is
  --    an update of one row, never an insert.
  update public.household_members
  set household_id = v_invite.household_id, joined_at = now()
  where user_id = (select auth.uid());

  -- 3. Provenance, stamped from the local resolved before any write (see above).
  update public.household_invites
  set redeemed_at = now(),
      redeemed_by = (select auth.uid()),
      redeemed_from_household_id = v_origin_household
  where id = v_invite.id;

  return v_invite.household_id;
end;
$$;

revoke execute on function public.redeem_household_invite(text) from public, anon;
grant execute on function public.redeem_household_invite(text) to authenticated;

comment on function public.redeem_household_invite(text) is
  'Moves the caller''s single membership row into the invite''s household and stamps provenance, atomically. Rejects with KD001 (unknown code), KD002 (expired), KD003 (already used), KD004 (own household), KD005 (target full), KD006 (caller holds non-seed rows) or KD007 (no caller/household). One-way: no application path undoes a redemption.';
