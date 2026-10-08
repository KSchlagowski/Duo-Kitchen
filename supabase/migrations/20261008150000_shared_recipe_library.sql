-- Shared recipe library (roadmap F-04, PRD Access Control).
--
-- Recipes and products become ONE public library shared by every user: no recipe or product belongs
-- to a household. This replaces F-02's per-household copies (20261007120000_products_and_recipes.sql)
-- and the seed fan-out (20261007120100_seed_products_and_recipes.sql). Households own only what is
-- theirs (plans, shopping lists); people own their targets and ratings.
--
-- "Public" means every AUTHENTICATED user, never anon: the PRD lets unauthenticated visitors reach
-- only sign-in, sign-up and invite redemption.
--
-- The library is read-only for every client role in F-04. The write rule is recorded now and lands
-- with S-07, the first slice that writes: seed rows (created_by is null) stay immutable to people;
-- user-added rows are editable by their author and the author's current household partner.
--
-- Seed rows keep their stable 5eed000N-… ids as primary keys (seed_id is gone; the id IS the seed
-- identity). Seed content changes are now plain insert/update statements on the public tables in a
-- data-only migration -- no per-household fan-out.
--
-- SQLSTATEs: KD006 retired (F-04) -- do not reuse. It guarded household-owned library rows during a
-- redemption; with no household-owned library there is nothing left behind.
--
-- Rollback: none. Re-running F-02's migrations is not a rollback (it would reintroduce household
-- copies and the seeding trigger). Forward-fix only, with a new migration.
--
-- Step order is a safety property: the guard runs first, and the private.seed_* templates are
-- dropped only after the public tables have been refilled from them, so a failure part-way leaves
-- the source of truth in place for a forward-fix.

-- ---------------------------------------------------------------------------
-- 1. Guard: abort rather than destroy anything but unmodified seed copies.
--
-- (a) no non-seed row in any of the five tables;
-- (b) every copy matches its template, compared as a null-safe set difference
--     (copies EXCEPT templates), which treats null = null as equal, catches edits to nullable
--     columns, and catches orphan copies whose seed_id matches no template. References are compared
--     by seed identity: the copy's parent copy's seed_id must equal the template's parent id;
-- (c) no household is missing a copy (a deleted seed row is a modification too).
-- ---------------------------------------------------------------------------
do $$
declare
  n bigint;
  t text;
begin
  -- (a)
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I where seed_id is null', t) into n;
    if n > 0 then
      raise exception 'F-04 guard: public.% holds % non-seed rows; refusing to drop the household copies', t, n;
    end if;
  end loop;

  -- (b) products
  select count(*) into n from (
    select c.seed_id, c.name, c.kcal_per_100g, c.protein_per_100g, c.fat_per_100g, c.carbs_per_100g,
      c.aisle, c.rounding_step_g, c.grams_per_piece
    from public.products c
    except
    select t.id, t.name, t.kcal_per_100g, t.protein_per_100g, t.fat_per_100g, t.carbs_per_100g,
      t.aisle, t.rounding_step_g, t.grams_per_piece
    from private.seed_products t
  ) d;
  if n > 0 then
    raise exception 'F-04 guard: % distinct products copies differ from their template (or have no template)', n;
  end if;

  -- (b) recipes
  select count(*) into n from (
    select c.seed_id, c.name, c.cuisine, c.prep_minutes, c.meal_types, c.division_mode
    from public.recipes c
    except
    select t.id, t.name, t.cuisine, t.prep_minutes, t.meal_types, t.division_mode
    from private.seed_recipes t
  ) d;
  if n > 0 then
    raise exception 'F-04 guard: % distinct recipes copies differ from their template (or have no template)', n;
  end if;

  -- (b) recipe_components
  select count(*) into n from (
    select c.seed_id, r.seed_id, c.position, c.name, c.cooked_yield_ratio
    from public.recipe_components c
    left join public.recipes r on r.id = c.recipe_id
    except
    select t.id, t.recipe_id, t.position, t.name, t.cooked_yield_ratio
    from private.seed_recipe_components t
  ) d;
  if n > 0 then
    raise exception 'F-04 guard: % distinct recipe_components copies differ from their template (or have no template)', n;
  end if;

  -- (b) recipe_ingredients
  select count(*) into n from (
    select c.seed_id, rc.seed_id, p.seed_id, c.position, c.base_amount_g, c.rounding_step_g,
      c.min_amount_g, c.allow_half_pieces
    from public.recipe_ingredients c
    left join public.recipe_components rc on rc.id = c.component_id
    left join public.products p on p.id = c.product_id
    except
    select t.id, t.component_id, t.product_id, t.position, t.base_amount_g, t.rounding_step_g,
      t.min_amount_g, t.allow_half_pieces
    from private.seed_recipe_ingredients t
  ) d;
  if n > 0 then
    raise exception 'F-04 guard: % distinct recipe_ingredients copies differ from their template (or have no template)', n;
  end if;

  -- (b) recipe_steps
  select count(*) into n from (
    select c.seed_id, r.seed_id, c.position, c.instruction, c.timing, rc.seed_id, c.duration_minutes
    from public.recipe_steps c
    left join public.recipes r on r.id = c.recipe_id
    left join public.recipe_components rc on rc.id = c.component_id
    except
    select t.id, t.recipe_id, t.position, t.instruction, t.timing, t.component_id, t.duration_minutes
    from private.seed_recipe_steps t
  ) d;
  if n > 0 then
    raise exception 'F-04 guard: % distinct recipe_steps copies differ from their template (or have no template)', n;
  end if;

  -- (c)
  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format(
      'select count(*) from (
         select h.id from public.households h
         left join public.%I c on c.household_id = h.id
         group by h.id
         having count(c.id) not in (0, (select count(*) from private.%I))
       ) x', t, 'seed_' || t) into n;
    if n > 0 then
      raise exception 'F-04 guard: % households hold a partial public.% copy (seed rows were deleted)', n, t;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Sign-up trigger: back to the F-01 body (household + membership only). No library rows.
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_user()
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

-- ---------------------------------------------------------------------------
-- 3. redeem_household_invite(): unchanged except that the KD006 guard is gone.
--
-- The library is public (F-04), so redemption never touches it and there is no household-owned
-- library row that could be left behind.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_household_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_origin_household uuid;
  v_invite public.household_invites;
  v_origin_members int;
  v_members int;
begin
  -- Resolved ONCE, before any write, and reused for the KD004 check and the provenance stamp.
  -- private.user_household_ids() is `stable` and each plpgsql statement runs with a fresh
  -- snapshot, so re-calling it after the membership update below would return the TARGET household
  -- and silently stamp redeemed_from_household_id with the live shared household -- inverting the
  -- protection README's cleanup query builds on that column.
  select hid into v_origin_household from private.user_household_ids() as hid limit 1;
  if (select auth.uid()) is null or v_origin_household is null then
    raise exception 'no household for caller' using errcode = 'KD007';
  end if;

  -- Serialise against create_household_invite() on the household this caller is about to leave --
  -- the same row that function locks. Without it a code minted concurrently for the origin survives
  -- the move, in either interleaving: redeem-first lets create's insert land just after the
  -- origin-side delete below, and create-first puts the new row outside that delete's statement
  -- snapshot (a blocked DELETE re-checks only the rows it blocked on; it does not re-scan). Either
  -- way a live bearer code is left pointing at the orphaned household, which is exactly the hazard
  -- that delete exists to prevent. Locking households before household_invites in both functions
  -- keeps the lock order consistent.
  perform 1 from public.households where id = v_origin_household for update;

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

  -- Origin-side cap, symmetric with create_household_invite()'s own two-member refusal. An
  -- ALREADY-LINKED caller who follows a third party's invite link would otherwise be moved out of
  -- the couple, leaving their partner alone in the shared household -- and S-01 ships no
  -- leave/unlink path, so nothing in the application can put them back. The origin-side delete below
  -- would also take the partner's own live invite code with it on the way out. Refusing is the
  -- conservative default; a deliberate "move to a different household" flow needs its own slice.
  select count(*) into v_origin_members
  from public.household_members
  where household_id = v_origin_household;
  if v_origin_members >= 2 then
    raise exception 'caller is already linked with a partner' using errcode = 'KD008';
  end if;

  select count(*) into v_members
  from public.household_members
  where household_id = v_invite.household_id;
  if v_members < 1 then
    -- The inviter deleted their account inside the 7-day TTL: their household_members row cascades
    -- away, but created_by is `on delete set null`, so the invite row survives pointing at a
    -- household nobody is in. Without this branch the caller would abandon their own kitchen to land
    -- alone in a deleted stranger's household, irreversibly.
    raise exception 'invite household has no members left' using errcode = 'KD009';
  end if;
  if v_members >= 2 then
    raise exception 'target household already has two members' using errcode = 'KD005';
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
  --    an update of one row, never an insert. It must stay a single update: per-person rows
  --    (macro_targets) follow it through their composite membership FK's on update cascade, and a
  --    delete + re-insert would cascade them away instead.
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
  'Moves the caller''s single membership row into the invite''s household and stamps provenance, atomically. Rejects with KD001 (unknown code), KD002 (expired), KD003 (already used), KD004 (own household), KD005 (target full), KD007 (no caller/household), KD008 (caller already linked with a partner) or KD009 (invite household has no members left). KD006 is retired (F-04). One-way: no application path undoes a redemption.';

-- ---------------------------------------------------------------------------
-- 4. Retire per-household seeding.
-- ---------------------------------------------------------------------------
drop function private.seed_household(uuid);

-- ---------------------------------------------------------------------------
-- 5. Drop the household copies (and with them their policies and indexes). Enums are untouched.
-- ---------------------------------------------------------------------------
drop table public.recipe_steps, public.recipe_ingredients, public.recipe_components, public.recipes, public.products;

-- ---------------------------------------------------------------------------
-- 6. The public library, in its final shape.
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kcal_per_100g numeric(5,1) not null check (kcal_per_100g >= 0 and kcal_per_100g <= 900),
  protein_per_100g numeric(5,1) not null check (protein_per_100g >= 0),
  fat_per_100g numeric(5,1) not null check (fat_per_100g >= 0),
  -- Polish/EU label convention: carbohydrates exclude fibre.
  carbs_per_100g numeric(5,1) not null check (carbs_per_100g >= 0),
  aisle public.store_aisle not null,
  rounding_step_g numeric(5,1) not null default 10 check (rounding_step_g > 0),
  -- Non-null: the product is counted in pieces (amounts are still stored in grams).
  grams_per_piece numeric(6,1) check (grams_per_piece > 0),
  created_at timestamptz not null default now(),
  check (protein_per_100g + fat_per_100g + carbs_per_100g <= 100)
);

comment on table public.products is 'Public library (F-04): shared by every user, not household-scoped; read-only for clients. Product database: nutrition per 100 g, store aisle, rounding step. Liquids are stored as grams.';

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  cuisine text not null,
  prep_minutes int not null check (prep_minutes > 0),
  meal_types public.meal_type[] not null default '{}' check (cardinality(meal_types) <= 2),
  division_mode public.division_mode not null,
  created_at timestamptz not null default now()
);

comment on table public.recipes is 'Public library (F-04): shared by every user, not household-scoped; read-only for clients. Amounts are one base batch; the solver picks a scale factor per component (or per recipe for whole_dish).';

create table public.recipe_components (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes on delete cascade,
  position int not null,
  name text not null,
  -- Cooked weight / raw weight; null = not weighed after cooking.
  cooked_yield_ratio numeric(4,2) check (cooked_yield_ratio > 0),
  created_at timestamptz not null default now(),
  unique (recipe_id, position),
  -- Target of recipe_steps' (component_id, recipe_id) FK.
  unique (id, recipe_id)
);

comment on table public.recipe_components is 'Public library (F-04): shared by every user, not household-scoped; read-only for clients. Scalable units of a recipe with fixed internal proportions. A whole_dish recipe has exactly one.';

create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references public.recipe_components on delete cascade,
  product_id uuid not null references public.products on delete restrict,
  position int not null,
  base_amount_g numeric(7,1) not null check (base_amount_g > 0),
  -- Overrides products.rounding_step_g for this ingredient.
  rounding_step_g numeric(5,1) check (rounding_step_g > 0),
  -- Minimum sensible amount (e.g. fried eggs need at least 1 egg).
  min_amount_g numeric(7,1) check (min_amount_g > 0),
  -- Piece products only: whether the amount may be split into half pieces.
  allow_half_pieces boolean not null default false,
  created_at timestamptz not null default now(),
  check (min_amount_g <= base_amount_g),
  unique (component_id, position)
);

comment on table public.recipe_ingredients is 'Public library (F-04): shared by every user, not household-scoped; read-only for clients. Base-batch amounts (grams) of products within a recipe component.';

create table public.recipe_steps (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes on delete cascade,
  position int not null,
  instruction text not null,
  timing public.step_timing not null,
  component_id uuid,
  duration_minutes int check (duration_minutes > 0),
  created_at timestamptz not null default now(),
  -- Null component_id skips the check (MATCH SIMPLE); deleting the component clears only component_id.
  foreign key (component_id, recipe_id)
    references public.recipe_components (id, recipe_id) on delete set null (component_id),
  unique (recipe_id, position)
);

comment on table public.recipe_steps is 'Public library (F-04): shared by every user, not household-scoped; read-only for clients. Ordered recipe steps, each make-ahead or fresh, optionally tied to one component.';

-- FK columns not already covered by the leading column of a (…, position) unique.
create index recipe_ingredients_product_id_idx on public.recipe_ingredients (product_id);
create index recipe_steps_component_id_recipe_id_idx on public.recipe_steps (component_id, recipe_id);

-- ---------------------------------------------------------------------------
-- 7. One canonical set of rows, copied from the templates with their stable ids, in FK order.
-- ---------------------------------------------------------------------------
insert into public.products (
  id, name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, aisle, rounding_step_g, grams_per_piece
)
select id, name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, aisle, rounding_step_g, grams_per_piece
from private.seed_products;

insert into public.recipes (id, name, cuisine, prep_minutes, meal_types, division_mode)
select id, name, cuisine, prep_minutes, meal_types, division_mode
from private.seed_recipes;

insert into public.recipe_components (id, recipe_id, position, name, cooked_yield_ratio)
select id, recipe_id, position, name, cooked_yield_ratio
from private.seed_recipe_components;

insert into public.recipe_ingredients (
  id, component_id, product_id, position, base_amount_g, rounding_step_g, min_amount_g, allow_half_pieces
)
select id, component_id, product_id, position, base_amount_g, rounding_step_g, min_amount_g, allow_half_pieces
from private.seed_recipe_ingredients;

insert into public.recipe_steps (id, recipe_id, position, instruction, timing, component_id, duration_minutes)
select id, recipe_id, position, instruction, timing, component_id, duration_minutes
from private.seed_recipe_steps;

-- ---------------------------------------------------------------------------
-- 8. Drop the templates last: the public tables are now the single source of truth.
-- ---------------------------------------------------------------------------
drop table private.seed_recipe_steps, private.seed_recipe_ingredients, private.seed_recipe_components,
  private.seed_recipes, private.seed_products;

-- ---------------------------------------------------------------------------
-- 9. Row level security: one SELECT policy for authenticated, nothing for anon, no write policies.
--
-- The revoke is what blocks writes today; the absence of write policies is what still blocks them if
-- a future migration grants insert alone. These are independent levers, and both are kept. Both are
-- load-bearing because the tables were just recreated: Supabase's default privileges grant
-- everything on a new public table to anon and authenticated. TRUNCATE bypasses RLS, so it is
-- revoked too. supabase/tests/household_isolation.sql asserts both levers.
-- ---------------------------------------------------------------------------
alter table public.products enable row level security;
revoke all on public.products from anon;
revoke insert, update, delete, truncate, references, trigger on public.products from authenticated;
create policy "products_select_authenticated" on public.products
  for select to authenticated using (true);

alter table public.recipes enable row level security;
revoke all on public.recipes from anon;
revoke insert, update, delete, truncate, references, trigger on public.recipes from authenticated;
create policy "recipes_select_authenticated" on public.recipes
  for select to authenticated using (true);

alter table public.recipe_components enable row level security;
revoke all on public.recipe_components from anon;
revoke insert, update, delete, truncate, references, trigger on public.recipe_components from authenticated;
create policy "recipe_components_select_authenticated" on public.recipe_components
  for select to authenticated using (true);

alter table public.recipe_ingredients enable row level security;
revoke all on public.recipe_ingredients from anon;
revoke insert, update, delete, truncate, references, trigger on public.recipe_ingredients from authenticated;
create policy "recipe_ingredients_select_authenticated" on public.recipe_ingredients
  for select to authenticated using (true);

alter table public.recipe_steps enable row level security;
revoke all on public.recipe_steps from anon;
revoke insert, update, delete, truncate, references, trigger on public.recipe_steps from authenticated;
create policy "recipe_steps_select_authenticated" on public.recipe_steps
  for select to authenticated using (true);
