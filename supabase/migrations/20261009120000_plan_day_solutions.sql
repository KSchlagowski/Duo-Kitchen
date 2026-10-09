-- Per-day macro solutions (roadmap S-04, PRD US-01 / FR-018–FR-020): one stored solve result per
-- (meal plan, day_index), so both partners see the same quantities and splits.
--
-- Ownership class: HOUSEHOLD-SCOPED. A solution belongs to its plan, and so to the plan's household.
-- It carries household_id (indexed) and the four helper-predicate policies.
--
-- Shape: the whole result (cook amounts, splits, per-person totals, a snapshot of the targets it was
-- solved against, the explanation) is one jsonb document, the DaySolution DTO in src/types.ts. It is
-- deliberately not normalised into plan_dishes / plan_meals columns: S-08 changes dish -> day
-- cardinality anyway, and S-09 / S-11 consume the stored jsonb rather than re-deriving quantities.
-- input_fingerprint is a SHA-256 over every solver input (src/lib/services/macro-solver.ts,
-- dayFingerprint); the app compares it on read to show a result as out of date. save_meal_plan keeps
-- meal ids on eater-only edits, so FKs to plan_meals could not detect those changes.
--
-- WARNING -- no membership FK and no user_id column. A solution names people only inside its jsonb
-- (eater ids, target snapshots). Never give this table the per-person composite
-- (household_id, user_id) -> household_members ... on update cascade FK: like plan rows, solutions
-- stay behind in the origin household on redemption, and that cascade would fail
-- redeem_household_invite() with 23503 (see 20261008170000_meal_plans.sql).
--
-- Write-revoked: clients keep SELECT only; all writes go through public.save_day_solution. The four
-- policies exist for the household_id catch-all in supabase/tests/household_isolation.sql; the
-- revokes make the write policies unreachable. Both levers are load-bearing. MAINTAIN is revoked too.
--
-- Rejection SQLSTATEs (class KD), claimed here:
--   KD007  reused from S-01: no authenticated caller, or the caller has no household
--   KD013  malformed argument (null start date, day_index outside 0-2, unknown status, tolerance not
--          10/15/20, fingerprint not 64 lowercase hex characters, result not a jsonb object or over
--          65 536 bytes)
--   KD014  the caller's household has no meal plan for p_start_date
-- KD006 stays retired (F-04); KD001–KD012 are claimed by S-01 and S-03.
--
-- Rollback: drop function public.save_day_solution(date, int, text, int, text, jsonb);
--           drop table public.plan_day_solutions;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.plan_day_solutions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  plan_id uuid not null,
  day_index smallint not null check (day_index between 0 and 2),
  status text not null check (status in ('solved', 'needs_confirmation', 'no_fit')),
  -- The tolerance the household accepted (10 unless they confirmed ±15 % or ±20 %).
  accepted_tolerance_pct smallint not null check (accepted_tolerance_pct in (10, 15, 20)),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  solved_at timestamptz not null default now(),
  -- The composite FK keeps a solution inside its plan's household; deleting the plan removes it.
  constraint plan_day_solutions_plan_fkey foreign key (plan_id, household_id)
    references public.meal_plans (id, household_id) on delete cascade,
  -- One solution per plan day. Its leading plan_id also serves plan_day_solutions_plan_fkey.
  constraint plan_day_solutions_plan_day_key unique (plan_id, day_index)
);

comment on table public.plan_day_solutions is
  'Stored macro solve of one meal-plan day (S-04). Written only by public.save_day_solution; clients have SELECT only.';

create index plan_day_solutions_household_id_idx on public.plan_day_solutions (household_id);

-- ---------------------------------------------------------------------------
-- Row level security + grants (write-revoked, meal_plans precedent).
-- ---------------------------------------------------------------------------
alter table public.plan_day_solutions enable row level security;

revoke all on public.plan_day_solutions from anon;
revoke insert, update, delete, truncate, references, trigger, maintain on public.plan_day_solutions from authenticated;

create policy "plan_day_solutions_select_authenticated" on public.plan_day_solutions
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "plan_day_solutions_insert_authenticated" on public.plan_day_solutions
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "plan_day_solutions_update_authenticated" on public.plan_day_solutions
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "plan_day_solutions_delete_authenticated" on public.plan_day_solutions
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- ---------------------------------------------------------------------------
-- save_day_solution(): the single write path. The solve itself runs in the app (pure TypeScript);
-- this function only checks the shape and upserts the row for the caller's own plan.
-- ---------------------------------------------------------------------------
create function public.save_day_solution(
  p_start_date date,
  p_day_index int,
  p_status text,
  p_accepted_tolerance_pct int,
  p_input_fingerprint text,
  p_result jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household uuid;
  v_plan uuid;
  v_id uuid;
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
    if p_day_index is null or p_day_index not between 0 and 2 then
      raise exception 'day_index must be 0, 1 or 2' using errcode = 'KD013';
    end if;
    if p_status is null or p_status not in ('solved', 'needs_confirmation', 'no_fit') then
      raise exception 'unknown status' using errcode = 'KD013';
    end if;
    if p_accepted_tolerance_pct is null or p_accepted_tolerance_pct not in (10, 15, 20) then
      raise exception 'accepted tolerance must be 10, 15 or 20' using errcode = 'KD013';
    end if;
    if p_input_fingerprint is null or p_input_fingerprint !~ '^[0-9a-f]{64}$' then
      raise exception 'input fingerprint is not 64 lowercase hex characters' using errcode = 'KD013';
    end if;
    -- `is distinct from`: jsonb_typeof(null) is null.
    if jsonb_typeof(p_result) is distinct from 'object' then
      raise exception 'result is not a jsonb object' using errcode = 'KD013';
    end if;
    if octet_length(p_result::text) > 65536 then
      raise exception 'result is larger than 65536 bytes' using errcode = 'KD013';
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

  -- 4. Upsert the day's solution. The conflict update takes the row lock; the last writer wins.
  insert into public.plan_day_solutions
    (household_id, plan_id, day_index, status, accepted_tolerance_pct, input_fingerprint, result)
  values
    (v_household, v_plan, p_day_index, p_status, p_accepted_tolerance_pct, p_input_fingerprint, p_result)
  on conflict (plan_id, day_index) do update set
    status = excluded.status,
    accepted_tolerance_pct = excluded.accepted_tolerance_pct,
    input_fingerprint = excluded.input_fingerprint,
    result = excluded.result,
    solved_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.save_day_solution(date, int, text, int, text, jsonb) from public, anon;
grant execute on function public.save_day_solution(date, int, text, int, text, jsonb) to authenticated;

comment on function public.save_day_solution(date, int, text, int, text, jsonb) is
  'Stores the macro solve of one day of the caller''s household meal plan for p_start_date (upsert on plan + day). Rejects with KD007 (no caller/household), KD013 (malformed argument) or KD014 (no plan for that start date).';
