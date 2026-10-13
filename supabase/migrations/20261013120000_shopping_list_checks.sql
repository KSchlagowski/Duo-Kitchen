-- Shopping-list check-offs (roadmap S-09, PRD US-02 / FR-021): which products of one meal plan's
-- shopping list the household has checked off ("bought" or "already have it").
--
-- Ownership class: HOUSEHOLD-SCOPED. A check belongs to its plan, and so to the plan's household
-- (FR-003: linked partners share shopping lists). It carries household_id (indexed) and the four
-- helper-predicate policies.
--
-- Shape: the list itself is DERIVED on every read (src/lib/services/shopping-list.ts) from the plan,
-- the current stored day solutions and the public library; it is never stored. A row here only means
-- "this product is checked on this plan's list". Unchecking deletes the row. A check is keyed on
-- (plan, product), so it survives amount changes (solving a day, editing the plan); a check whose
-- product has left the list is ignored on render and reappears if the product returns.
-- product_id is a plain FK into the public library (household -> library is the permitted direction);
-- on delete cascade, because recipe_ingredients already blocks deleting a product in use.
--
-- WARNING -- no membership FK and no user_id column. Never give this table the per-person composite
-- (household_id, user_id) -> household_members ... on update cascade FK: like plan rows and day
-- solutions, checks stay behind in the origin household with their plan on redemption, and that
-- cascade would fail redeem_household_invite() with 23503 (see 20261008170000_meal_plans.sql).
--
-- Write-revoked: clients keep SELECT only; all writes go through public.set_shopping_item_checked. The
-- four policies exist for the household_id catch-all in supabase/tests/household_isolation.sql; the
-- revokes make the write policies unreachable. Both levers are load-bearing. MAINTAIN is revoked too.
--
-- Rejection SQLSTATEs (class KD). New here:
--   KD018  malformed argument (null start date, product id or checked flag)
--   KD019  a CHECK (not an uncheck) of a product that no recipe of the plan uses, including an
--          unknown product id; without it any member could plant arbitrary rows
-- Reused: KD007 (no caller/household), KD014 (no plan for that start date). KD006 stays retired
-- (F-04); KD001-KD017 are claimed by S-01, S-03, S-04 and S-08.
--
-- Rollback: drop function public.set_shopping_item_checked(date, uuid, boolean);
--           drop table public.shopping_list_checks;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.shopping_list_checks (
  household_id uuid not null references public.households on delete cascade,
  plan_id uuid not null,
  product_id uuid not null references public.products on delete cascade,
  checked_at timestamptz not null default now(),
  -- One check per product per plan. Its leading plan_id also serves shopping_list_checks_plan_fkey.
  constraint shopping_list_checks_pkey primary key (plan_id, product_id),
  -- The composite FK keeps a check inside its plan's household; deleting the plan removes it.
  constraint shopping_list_checks_plan_fkey foreign key (plan_id, household_id)
    references public.meal_plans (id, household_id) on delete cascade
);

comment on table public.shopping_list_checks is
  'Checked-off products of one meal plan''s derived shopping list (S-09). Written only by public.set_shopping_item_checked; clients have SELECT only.';

create index shopping_list_checks_household_id_idx on public.shopping_list_checks (household_id);
create index shopping_list_checks_product_id_idx on public.shopping_list_checks (product_id);

-- ---------------------------------------------------------------------------
-- Row level security + grants (write-revoked, meal_plans / plan_day_solutions precedent).
-- ---------------------------------------------------------------------------
alter table public.shopping_list_checks enable row level security;

revoke all on public.shopping_list_checks from anon;
revoke insert, update, delete, truncate, references, trigger, maintain on public.shopping_list_checks from authenticated;

create policy "shopping_list_checks_select_authenticated" on public.shopping_list_checks
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "shopping_list_checks_insert_authenticated" on public.shopping_list_checks
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "shopping_list_checks_update_authenticated" on public.shopping_list_checks
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "shopping_list_checks_delete_authenticated" on public.shopping_list_checks
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- ---------------------------------------------------------------------------
-- set_shopping_item_checked(): the single write path. Checks (inserts) or unchecks (deletes) one
-- product on the caller's own plan for p_start_date. Both directions are idempotent, so two partners
-- tapping the same item converge.
-- ---------------------------------------------------------------------------
create function public.set_shopping_item_checked(p_start_date date, p_product_id uuid, p_checked boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_plan uuid;
begin
  -- 1. Resolve the caller's household once, before any write.
  select hid into v_household from private.user_household_ids() as hid limit 1;
  if (select auth.uid()) is null or v_household is null then
    raise exception 'no household for caller' using errcode = 'KD007';
  end if;

  -- 2. Shape (KD018). Three scalar null checks cannot raise anything unexpected, so no sub-block.
  if p_start_date is null or p_product_id is null or p_checked is null then
    raise exception 'start date, product id and checked flag are required' using errcode = 'KD018';
  end if;

  -- 3. The caller's household has a plan for that date (KD014).
  select mp.id into v_plan
  from public.meal_plans mp
  where mp.household_id = v_household and mp.start_date = p_start_date;
  if v_plan is null then
    raise exception 'no meal plan for that start date' using errcode = 'KD014';
  end if;

  if p_checked then
    -- 4. A check needs a product some recipe of the plan uses (KD019); this also rejects an unknown
    --    product id. Unchecking is always allowed, so a stale check can still be cleared.
    if not exists (
      select 1
      from public.plan_dishes d
      join public.recipe_components rc on rc.recipe_id = d.recipe_id
      join public.recipe_ingredients ri on ri.component_id = rc.id
      where d.plan_id = v_plan and ri.product_id = p_product_id
    ) then
      raise exception 'product is not on this plan''s shopping list' using errcode = 'KD019';
    end if;

    insert into public.shopping_list_checks (household_id, plan_id, product_id)
    values (v_household, v_plan, p_product_id)
    on conflict (plan_id, product_id) do nothing;
  else
    -- 5. Uncheck. Deleting a missing row is not an error.
    delete from public.shopping_list_checks
    where plan_id = v_plan and product_id = p_product_id;
  end if;
end;
$$;

-- Mandatory, not cosmetic: Supabase's default privileges grant execute on a new public function to
-- anon.
revoke execute on function public.set_shopping_item_checked(date, uuid, boolean) from public, anon;
grant execute on function public.set_shopping_item_checked(date, uuid, boolean) to authenticated;

comment on function public.set_shopping_item_checked(date, uuid, boolean) is
  'Checks (p_checked true) or unchecks one product on the shopping list of the caller''s household meal plan for p_start_date; idempotent both ways. Rejects with KD007 (no caller/household), KD018 (malformed argument), KD014 (no plan for that start date) or KD019 (checking a product no recipe of the plan uses).';
