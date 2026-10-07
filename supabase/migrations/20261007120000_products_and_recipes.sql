-- Products and recipes (roadmap F-02): the minimum shape the solver and scheduler need.
--
-- Every table is household-scoped (F-01 pattern). Child tables carry household_id too, kept
-- consistent with their parent by composite foreign keys, so a row can never reference another
-- household's row and every policy stays the same one-liner:
--   household_id in (select private.user_household_ids())
--
-- Each household starts with its own copy of a repo-maintained seed set. The templates live in
-- private.seed_* (filled by a later data-only migration); private.seed_household() copies them,
-- and the sign-up trigger calls it. Every copied row keeps seed_id -> its template row.

-- ---------------------------------------------------------------------------
-- Enums: language-neutral keys (S-14 maps them to PL/EN labels).
-- ---------------------------------------------------------------------------
create type public.store_aisle as enum (
  'produce', 'dairy', 'meat_fish', 'bakery', 'dry_goods', 'spices', 'frozen', 'other'
);

create type public.meal_type as enum (
  'breakfast', 'second_breakfast', 'lunch', 'afternoon_snack', 'dinner'
);

-- per_component: each component is scaled separately per person (e.g. 60% of the rice, 70% of the sauce).
-- whole_dish: the recipe has exactly one component, divided as a whole.
create type public.division_mode as enum ('per_component', 'whole_dish');

-- make_ahead: can be done the evening before; fresh: must be done right before eating.
create type public.step_timing as enum ('make_ahead', 'fresh');

-- ---------------------------------------------------------------------------
-- Household tables
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  seed_id uuid,
  name text not null,
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
  check (protein_per_100g + fat_per_100g + carbs_per_100g <= 100),
  -- Also serves as the household_id index.
  unique (household_id, seed_id),
  unique (id, household_id)
);

comment on table public.products is 'Household product database: nutrition per 100 g, store aisle, rounding step. Liquids are stored as grams.';

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  seed_id uuid,
  name text not null,
  cuisine text not null,
  prep_minutes int not null check (prep_minutes > 0),
  meal_types public.meal_type[] not null default '{}' check (cardinality(meal_types) <= 2),
  division_mode public.division_mode not null,
  created_at timestamptz not null default now(),
  unique (household_id, seed_id),
  unique (id, household_id)
);

comment on table public.recipes is 'Household recipes. Amounts are one base batch; the solver picks a scale factor per component (or per recipe for whole_dish).';

create table public.recipe_components (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  seed_id uuid,
  recipe_id uuid not null,
  position int not null,
  name text not null,
  -- Cooked weight / raw weight; null = not weighed after cooking.
  cooked_yield_ratio numeric(4,2) check (cooked_yield_ratio > 0),
  created_at timestamptz not null default now(),
  foreign key (recipe_id, household_id) references public.recipes (id, household_id) on delete cascade,
  unique (household_id, seed_id),
  unique (recipe_id, position),
  unique (id, household_id),
  unique (id, recipe_id, household_id)
);

comment on table public.recipe_components is 'Scalable units of a recipe with fixed internal proportions. A whole_dish recipe has exactly one.';

create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  seed_id uuid,
  component_id uuid not null,
  product_id uuid not null,
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
  foreign key (component_id, household_id) references public.recipe_components (id, household_id) on delete cascade,
  foreign key (product_id, household_id) references public.products (id, household_id) on delete restrict,
  unique (household_id, seed_id),
  unique (component_id, position)
);

comment on table public.recipe_ingredients is 'Base-batch amounts (grams) of products within a recipe component.';

create table public.recipe_steps (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households on delete cascade,
  seed_id uuid,
  recipe_id uuid not null,
  position int not null,
  instruction text not null,
  timing public.step_timing not null,
  component_id uuid,
  duration_minutes int check (duration_minutes > 0),
  created_at timestamptz not null default now(),
  foreign key (recipe_id, household_id) references public.recipes (id, household_id) on delete cascade,
  -- Null component_id skips the check (MATCH SIMPLE); deleting the component clears only component_id.
  foreign key (component_id, recipe_id, household_id)
    references public.recipe_components (id, recipe_id, household_id) on delete set null (component_id),
  unique (household_id, seed_id),
  unique (recipe_id, position)
);

comment on table public.recipe_steps is 'Ordered recipe steps, each make-ahead or fresh, optionally tied to one component.';

-- Indexes for the composite foreign keys (household_id alone is covered by unique (household_id, seed_id)).
create index recipe_components_recipe_id_household_id_idx on public.recipe_components (recipe_id, household_id);
create index recipe_ingredients_component_id_household_id_idx on public.recipe_ingredients (component_id, household_id);
create index recipe_ingredients_product_id_household_id_idx on public.recipe_ingredients (product_id, household_id);
create index recipe_steps_recipe_id_household_id_idx on public.recipe_steps (recipe_id, household_id);
create index recipe_steps_component_id_recipe_id_household_id_idx
  on public.recipe_steps (component_id, recipe_id, household_id);

-- ---------------------------------------------------------------------------
-- Row level security: per-operation policies for authenticated, none for anon.
-- TRUNCATE bypasses RLS, so it is revoked along with references/trigger (F-01 precedent).
-- ---------------------------------------------------------------------------
alter table public.products enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_components enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.recipe_steps enable row level security;

revoke all on public.products from anon;
revoke all on public.recipes from anon;
revoke all on public.recipe_components from anon;
revoke all on public.recipe_ingredients from anon;
revoke all on public.recipe_steps from anon;

revoke truncate, references, trigger on public.products from authenticated;
revoke truncate, references, trigger on public.recipes from authenticated;
revoke truncate, references, trigger on public.recipe_components from authenticated;
revoke truncate, references, trigger on public.recipe_ingredients from authenticated;
revoke truncate, references, trigger on public.recipe_steps from authenticated;

-- products
create policy "products_select_authenticated" on public.products
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "products_insert_authenticated" on public.products
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "products_update_authenticated" on public.products
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "products_delete_authenticated" on public.products
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- recipes
create policy "recipes_select_authenticated" on public.recipes
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "recipes_insert_authenticated" on public.recipes
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "recipes_update_authenticated" on public.recipes
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "recipes_delete_authenticated" on public.recipes
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- recipe_components
create policy "recipe_components_select_authenticated" on public.recipe_components
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "recipe_components_insert_authenticated" on public.recipe_components
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "recipe_components_update_authenticated" on public.recipe_components
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "recipe_components_delete_authenticated" on public.recipe_components
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- recipe_ingredients
create policy "recipe_ingredients_select_authenticated" on public.recipe_ingredients
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "recipe_ingredients_insert_authenticated" on public.recipe_ingredients
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "recipe_ingredients_update_authenticated" on public.recipe_ingredients
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "recipe_ingredients_delete_authenticated" on public.recipe_ingredients
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- recipe_steps
create policy "recipe_steps_select_authenticated" on public.recipe_steps
  for select to authenticated
  using (household_id in (select private.user_household_ids()));
create policy "recipe_steps_insert_authenticated" on public.recipe_steps
  for insert to authenticated
  with check (household_id in (select private.user_household_ids()));
create policy "recipe_steps_update_authenticated" on public.recipe_steps
  for update to authenticated
  using (household_id in (select private.user_household_ids()))
  with check (household_id in (select private.user_household_ids()));
create policy "recipe_steps_delete_authenticated" on public.recipe_steps
  for delete to authenticated
  using (household_id in (select private.user_household_ids()));

-- ---------------------------------------------------------------------------
-- Seed templates (private): the repo-maintained seed set, keyed by stable UUIDs.
-- Not exposed through the API and not granted to any client role, so RLS is not needed here.
-- The same check constraints apply, so bad seed content fails at insert time.
-- ---------------------------------------------------------------------------
create table private.seed_products (
  id uuid primary key,
  name text not null unique,
  kcal_per_100g numeric(5,1) not null check (kcal_per_100g >= 0 and kcal_per_100g <= 900),
  protein_per_100g numeric(5,1) not null check (protein_per_100g >= 0),
  fat_per_100g numeric(5,1) not null check (fat_per_100g >= 0),
  carbs_per_100g numeric(5,1) not null check (carbs_per_100g >= 0),
  aisle public.store_aisle not null,
  rounding_step_g numeric(5,1) not null default 10 check (rounding_step_g > 0),
  grams_per_piece numeric(6,1) check (grams_per_piece > 0),
  check (protein_per_100g + fat_per_100g + carbs_per_100g <= 100)
);

create table private.seed_recipes (
  id uuid primary key,
  name text not null,
  cuisine text not null,
  prep_minutes int not null check (prep_minutes > 0),
  meal_types public.meal_type[] not null default '{}' check (cardinality(meal_types) <= 2),
  division_mode public.division_mode not null
);

create table private.seed_recipe_components (
  id uuid primary key,
  recipe_id uuid not null references private.seed_recipes on delete cascade,
  position int not null,
  name text not null,
  cooked_yield_ratio numeric(4,2) check (cooked_yield_ratio > 0),
  unique (recipe_id, position),
  unique (id, recipe_id)
);

create table private.seed_recipe_ingredients (
  id uuid primary key,
  component_id uuid not null references private.seed_recipe_components on delete cascade,
  product_id uuid not null references private.seed_products,
  position int not null,
  base_amount_g numeric(7,1) not null check (base_amount_g > 0),
  rounding_step_g numeric(5,1) check (rounding_step_g > 0),
  min_amount_g numeric(7,1) check (min_amount_g > 0),
  allow_half_pieces boolean not null default false,
  check (min_amount_g <= base_amount_g),
  unique (component_id, position)
);

create table private.seed_recipe_steps (
  id uuid primary key,
  recipe_id uuid not null references private.seed_recipes on delete cascade,
  position int not null,
  instruction text not null,
  timing public.step_timing not null,
  component_id uuid,
  duration_minutes int check (duration_minutes > 0),
  foreign key (component_id, recipe_id) references private.seed_recipe_components (id, recipe_id),
  unique (recipe_id, position)
);

create index seed_recipe_ingredients_product_id_idx on private.seed_recipe_ingredients (product_id);
create index seed_recipe_steps_component_id_recipe_id_idx on private.seed_recipe_steps (component_id, recipe_id);

revoke all on private.seed_products from public, anon, authenticated;
revoke all on private.seed_recipes from public, anon, authenticated;
revoke all on private.seed_recipe_components from public, anon, authenticated;
revoke all on private.seed_recipe_ingredients from public, anon, authenticated;
revoke all on private.seed_recipe_steps from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Copy the seed set into a household. Idempotent: rows already copied (same seed_id) are skipped.
-- Meant for new or empty households only: on a household that deleted seed rows, a re-run
-- re-inserts them. Later content migrations copy only their new template rows instead.
-- ---------------------------------------------------------------------------
create function private.seed_household(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.products (
    household_id, seed_id, name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g,
    aisle, rounding_step_g, grams_per_piece
  )
  select
    p_household_id, t.id, t.name, t.kcal_per_100g, t.protein_per_100g, t.fat_per_100g, t.carbs_per_100g,
    t.aisle, t.rounding_step_g, t.grams_per_piece
  from private.seed_products t
  on conflict (household_id, seed_id) do nothing;

  insert into public.recipes (household_id, seed_id, name, cuisine, prep_minutes, meal_types, division_mode)
  select p_household_id, t.id, t.name, t.cuisine, t.prep_minutes, t.meal_types, t.division_mode
  from private.seed_recipes t
  on conflict (household_id, seed_id) do nothing;

  insert into public.recipe_components (household_id, seed_id, recipe_id, position, name, cooked_yield_ratio)
  select p_household_id, t.id, r.id, t.position, t.name, t.cooked_yield_ratio
  from private.seed_recipe_components t
  join public.recipes r on r.household_id = p_household_id and r.seed_id = t.recipe_id
  on conflict (household_id, seed_id) do nothing;

  insert into public.recipe_ingredients (
    household_id, seed_id, component_id, product_id, position, base_amount_g, rounding_step_g,
    min_amount_g, allow_half_pieces
  )
  select
    p_household_id, t.id, c.id, p.id, t.position, t.base_amount_g, t.rounding_step_g,
    t.min_amount_g, t.allow_half_pieces
  from private.seed_recipe_ingredients t
  join public.recipe_components c on c.household_id = p_household_id and c.seed_id = t.component_id
  join public.products p on p.household_id = p_household_id and p.seed_id = t.product_id
  on conflict (household_id, seed_id) do nothing;

  insert into public.recipe_steps (
    household_id, seed_id, recipe_id, position, instruction, timing, component_id, duration_minutes
  )
  select p_household_id, t.id, r.id, t.position, t.instruction, t.timing, c.id, t.duration_minutes
  from private.seed_recipe_steps t
  join public.recipes r on r.household_id = p_household_id and r.seed_id = t.recipe_id
  left join public.recipe_components c on c.household_id = p_household_id and c.seed_id = t.component_id
  on conflict (household_id, seed_id) do nothing;
end;
$$;

revoke execute on function private.seed_household(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up trigger: F-01 body (household + membership) plus the seed copy, atomically.
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

  perform private.seed_household(new_household_id);

  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;
