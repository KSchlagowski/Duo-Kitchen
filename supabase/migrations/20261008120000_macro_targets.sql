-- Daily macro targets (roadmap S-02, PRD US-01 / FR-004): one current row per person.
--
-- The first per-person table. It is keyed on user_id (so it belongs to the person, not the
-- household) and scoped by household_id (so the partner can read it under the usual helper
-- predicate). "Not set" means the row does not exist.
--
-- Why the composite foreign key (household_id, user_id) -> household_members exists:
-- public.redeem_household_invite() moves a person with a single
--   update public.household_members set household_id = …
-- A plain household_id column would stay behind in the redeemer's old, memberless household, where
-- neither partner can read it and the owner's own upsert is blocked by RLS. `on update cascade`
-- rewrites macro_targets.household_id in the same statement instead. Referential actions run as the
-- table owner and are not subject to RLS, so the cascade fires inside the definer function with no
-- per-table move step there. The same FK also proves, at the schema level, that a row can only
-- exist for a member of the household it names.
--
-- Membership moves must stay a single `update … set household_id` of the `household_members` row;
-- deleting and re-inserting a membership cascades away every per-person row for that user.
--
-- The plain household_id -> households FK and its index are kept as well: the household-scoped
-- table rule in CLAUDE.md requires them literally, and the isolation catch-all relies on the column.

create table public.macro_targets (
  user_id uuid primary key references auth.users on delete cascade,
  household_id uuid not null references public.households on delete cascade,
  kcal int not null check (kcal between 1 and 9999),
  protein_g int not null check (protein_g between 0 and 999),
  fat_g int not null check (fat_g between 0 and 999),
  carbs_g int not null check (carbs_g between 0 and 999),
  updated_at timestamptz not null default now(),
  constraint macro_targets_membership_fkey foreign key (household_id, user_id)
    references public.household_members (household_id, user_id)
    on update cascade on delete cascade
);

create index macro_targets_household_id_idx on public.macro_targets (household_id);

comment on table public.macro_targets is 'Per-person daily calorie and macro targets. Follows its owner through household redemption via the composite membership FK.';

-- ---------------------------------------------------------------------------
-- Row level security: per-operation policies for authenticated, none for anon.
-- Reads are household-wide (the partner sees your targets); writes add the owner predicate, so the
-- partner can read but never write them (FR-004: "their targets").
-- TRUNCATE bypasses RLS, so it is revoked along with references/trigger (F-01 precedent).
-- ---------------------------------------------------------------------------
alter table public.macro_targets enable row level security;

revoke all on public.macro_targets from anon;
revoke truncate, references, trigger on public.macro_targets from authenticated;

create policy "macro_targets_select_authenticated" on public.macro_targets
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "macro_targets_insert_authenticated" on public.macro_targets
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()) and user_id = (select auth.uid()));
create policy "macro_targets_update_authenticated" on public.macro_targets
  for update to authenticated
  using (household_id in (select private.user_household_ids()) and user_id = (select auth.uid()))
  with check (household_id in (select private.user_household_ids()) and user_id = (select auth.uid()));
create policy "macro_targets_delete_authenticated" on public.macro_targets
  for delete to authenticated
  using (household_id in (select private.user_household_ids()) and user_id = (select auth.uid()));
