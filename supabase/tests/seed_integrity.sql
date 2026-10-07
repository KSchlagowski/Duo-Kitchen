-- Seed integrity test (roadmap F-02).
--
-- Proves the repo-maintained seed set (private.seed_*) covers every solver/scheduler rule, is
-- internally consistent, and copies into a household faithfully and idempotently. Everything runs
-- in one transaction that is always rolled back. Re-run after every seed content migration.
--
-- Run: npm run test:seed   (supabase db query --linked -f supabase/tests/seed_integrity.sql)

begin;

-- ---------------------------------------------------------------------------
-- Counts
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from private.seed_recipes;
  if n not between 5 and 10 then
    raise exception 'counts: % seed recipes, expected 5-10', n;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atwater sanity: kcal ~ 4*protein + 4*carbs + 9*fat (EU labels: carbs exclude fibre).
-- Exempt: the spices aisle, plus the products below (high fibre makes the formula diverge;
-- they are used at 1-15 g per recipe, so their effect on recipe macros is negligible).
-- ---------------------------------------------------------------------------
do $$
declare
  atwater_exempt uuid[] := array[
    -- Kakao naturalne: label 334 kcal, P 23, F 10.5, C 13, fibre ~33 g (formula gives ~238).
    '5eed0001-0000-4000-8000-000000000013'
  ]::uuid[];
  bad text;
begin
  select string_agg(format('%s (kcal %s vs formula %s)', p.name, p.kcal_per_100g,
      4 * p.protein_per_100g + 4 * p.carbs_per_100g + 9 * p.fat_per_100g), ', ')
  into bad
  from private.seed_products p
  where p.aisle <> 'spices'
    and p.id <> all (atwater_exempt)
    and abs(p.kcal_per_100g - (4 * p.protein_per_100g + 4 * p.carbs_per_100g + 9 * p.fat_per_100g))
      > greatest(0.15 * p.kcal_per_100g, 15);
  if bad is not null then
    raise exception 'atwater: implausible nutrition for %', bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
begin
  select string_agg(format('%s (%s, %s components)', r.name, r.division_mode, coalesce(c.n, 0)), ', ')
  into bad
  from private.seed_recipes r
  left join (select recipe_id, count(*) as n from private.seed_recipe_components group by recipe_id) c
    on c.recipe_id = r.id
  where (r.division_mode = 'whole_dish' and coalesce(c.n, 0) <> 1)
     or (r.division_mode = 'per_component' and coalesce(c.n, 0) < 2);
  if bad is not null then
    raise exception 'structure: whole_dish needs exactly 1 component, per_component at least 2: %', bad;
  end if;

  select string_agg(c.name, ', ') into bad
  from private.seed_recipe_components c
  where not exists (select 1 from private.seed_recipe_ingredients i where i.component_id = c.id);
  if bad is not null then
    raise exception 'structure: components without ingredients: %', bad;
  end if;

  select string_agg(r.name, ', ') into bad
  from private.seed_recipes r
  where not exists (select 1 from private.seed_recipe_steps s where s.recipe_id = r.id);
  if bad is not null then
    raise exception 'structure: recipes without steps: %', bad;
  end if;

  select string_agg(r.name, ', ') into bad
  from private.seed_recipes r
  where cardinality(r.meal_types) <> (select count(distinct m) from unnest(r.meal_types) as m);
  if bad is not null then
    raise exception 'structure: duplicate meal types in: %', bad;
  end if;

  select string_agg(s.id::text, ', ') into bad
  from private.seed_recipe_steps s
  join private.seed_recipe_components c on c.id = s.component_id
  where c.recipe_id <> s.recipe_id;
  if bad is not null then
    raise exception 'structure: steps tied to a component of another recipe: %', bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Amounts: rounding steps and whole/half pieces
-- ---------------------------------------------------------------------------
do $$
declare
  bad text;
begin
  select string_agg(format('%s %s g (step %s g)', p.name, i.base_amount_g,
      coalesce(i.rounding_step_g, p.rounding_step_g)), ', ')
  into bad
  from private.seed_recipe_ingredients i
  join private.seed_products p on p.id = i.product_id
  where p.grams_per_piece is null
    and mod(i.base_amount_g, coalesce(i.rounding_step_g, p.rounding_step_g)) <> 0;
  if bad is not null then
    raise exception 'amounts: base amount not a multiple of the effective rounding step: %', bad;
  end if;

  select string_agg(format('%s %s g (piece %s g, halves %s)', p.name, i.base_amount_g,
      p.grams_per_piece, i.allow_half_pieces), ', ')
  into bad
  from private.seed_recipe_ingredients i
  join private.seed_products p on p.id = i.product_id
  where p.grams_per_piece is not null
    and mod(i.base_amount_g,
      case when i.allow_half_pieces then p.grams_per_piece / 2 else p.grams_per_piece end) <> 0;
  if bad is not null then
    raise exception 'amounts: piece amount not a whole (or allowed half) number of pieces: %', bad;
  end if;

  select string_agg(p.name, ', ') into bad
  from private.seed_recipe_ingredients i
  join private.seed_products p on p.id = i.product_id
  where i.allow_half_pieces and p.grams_per_piece is null;
  if bad is not null then
    raise exception 'amounts: allow_half_pieces set on non-piece products: %', bad;
  end if;

  select string_agg(format('%s min %s g (piece %s g)', p.name, i.min_amount_g, p.grams_per_piece), ', ')
  into bad
  from private.seed_recipe_ingredients i
  join private.seed_products p on p.id = i.product_id
  where p.grams_per_piece is not null and i.min_amount_g is not null
    and mod(i.min_amount_g, p.grams_per_piece) <> 0;
  if bad is not null then
    raise exception 'amounts: min_amount_g of a piece product is not a whole number of pieces: %', bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Coverage: every solver/scheduler rule is exercised by at least one seed row.
-- ---------------------------------------------------------------------------
do $$
declare
  missing text;
  n int;
begin
  select string_agg(m::text, ', ') into missing
  from unnest(enum_range(null::public.meal_type)) as m
  where not exists (select 1 from private.seed_recipes r where m = any (r.meal_types));
  if missing is not null then
    raise exception 'coverage: no recipe suggests meal types: %', missing;
  end if;

  select string_agg(b, ', ') into missing
  from (values ('<=20'), ('21-45'), ('>45')) as buckets (b)
  where not exists (
    select 1 from private.seed_recipes r
    where case
      when r.prep_minutes <= 20 then '<=20'
      when r.prep_minutes <= 45 then '21-45'
      else '>45'
    end = b
  );
  if missing is not null then
    raise exception 'coverage: no recipe in prep buckets: %', missing;
  end if;

  select string_agg(a::text, ', ') into missing
  from unnest(enum_range(null::public.store_aisle)) as a
  where not exists (select 1 from private.seed_products p where p.aisle = a);
  if missing is not null then
    raise exception 'coverage: no product in aisles: %', missing;
  end if;

  select string_agg(d::text, ', ') into missing
  from unnest(enum_range(null::public.division_mode)) as d
  where not exists (select 1 from private.seed_recipes r where r.division_mode = d);
  if missing is not null then
    raise exception 'coverage: no recipe with division modes: %', missing;
  end if;

  select count(*) into n from private.seed_recipe_components where cooked_yield_ratio is not null;
  if n < 2 then
    raise exception 'coverage: % components with cooked_yield_ratio, expected at least 2', n;
  end if;

  select string_agg(h::text, ', ') into missing
  from (values (true), (false)) as halves (h)
  where not exists (
    select 1 from private.seed_recipe_ingredients i
    join private.seed_products p on p.id = i.product_id
    where p.grams_per_piece is not null and i.allow_half_pieces = h
  );
  if missing is not null then
    raise exception 'coverage: no piece ingredient with allow_half_pieces = %', missing;
  end if;

  select count(*) into n
  from private.seed_recipe_ingredients i
  join private.seed_products p on p.id = i.product_id
  where p.grams_per_piece is null and coalesce(i.rounding_step_g, p.rounding_step_g) = 1;
  if n < 3 then
    raise exception 'coverage: % ingredients with an effective 1 g step, expected at least 3', n;
  end if;

  select count(*) into n from private.seed_recipe_ingredients where rounding_step_g is not null;
  if n < 1 then
    raise exception 'coverage: no ingredient-level rounding step override';
  end if;

  select count(*) into n from private.seed_recipe_ingredients where min_amount_g is not null;
  if n < 1 then
    raise exception 'coverage: no ingredient with min_amount_g';
  end if;

  select string_agg(t::text, ', ') into missing
  from unnest(enum_range(null::public.step_timing)) as t
  where not exists (select 1 from private.seed_recipe_steps s where s.timing = t);
  if missing is not null then
    raise exception 'coverage: no step with timing: %', missing;
  end if;

  select count(*) into n from private.seed_recipes where cardinality(meal_types) = 0;
  if n < 1 then
    raise exception 'coverage: no recipe with 0 meal types';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Macro diversity: independent levers for the solver (share of kcal per component, base amounts).
-- ---------------------------------------------------------------------------
do $$
declare
  protein_lever int;
  carb_lever int;
  fat_lever int;
begin
  with component_macros as (
    select
      i.component_id,
      sum(i.base_amount_g * p.protein_per_100g / 100) * 4 as protein_kcal,
      sum(i.base_amount_g * p.carbs_per_100g / 100) * 4 as carbs_kcal,
      sum(i.base_amount_g * p.fat_per_100g / 100) * 9 as fat_kcal
    from private.seed_recipe_ingredients i
    join private.seed_products p on p.id = i.product_id
    group by i.component_id
  ),
  shares as (
    select
      protein_kcal / nullif(protein_kcal + carbs_kcal + fat_kcal, 0) as protein_share,
      carbs_kcal / nullif(protein_kcal + carbs_kcal + fat_kcal, 0) as carbs_share,
      fat_kcal / nullif(protein_kcal + carbs_kcal + fat_kcal, 0) as fat_share
    from component_macros
  )
  select
    count(*) filter (where protein_share >= 0.5),
    count(*) filter (where carbs_share >= 0.6),
    count(*) filter (where fat_share >= 0.5)
  into protein_lever, carb_lever, fat_lever
  from shares;

  if protein_lever = 0 then
    raise exception 'macro diversity: no component gets >= 50%% of kcal from protein';
  end if;
  if carb_lever = 0 then
    raise exception 'macro diversity: no component gets >= 60%% of kcal from carbs';
  end if;
  if fat_lever = 0 then
    raise exception 'macro diversity: no component gets >= 50%% of kcal from fat';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Copy fidelity: a fresh household gets exactly the templates, idempotently, and can be deleted.
-- ---------------------------------------------------------------------------
insert into public.households (id) values ('00000000-0000-4000-c000-000000000001');

do $$
declare
  hh uuid := '00000000-0000-4000-c000-000000000001';
  t text;
  copied int;
  templates int;
  round int;
  n int;
begin
  for round in 1 .. 2 loop
    perform private.seed_household(hh);

    foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
      execute format('select count(*) from public.%I where household_id = $1', t) into copied using hh;
      execute format('select count(*) from private.%I', 'seed_' || t) into templates;
      if copied <> templates then
        raise exception 'copy fidelity (run %): household has % % rows, expected % (private.seed_%)',
          round, copied, t, templates, t;
      end if;
    end loop;
  end loop;

  select count(*) into n
  from public.recipe_ingredients i
  left join public.products p on p.id = i.product_id and p.household_id = i.household_id
  where i.household_id = hh and p.id is null;
  if n <> 0 then
    raise exception 'copy fidelity: % copied ingredients do not resolve to a product of the same household', n;
  end if;

  select count(*) into n
  from public.recipe_steps s
  join private.seed_recipe_steps t on t.id = s.seed_id
  left join public.recipe_components c on c.id = s.component_id
  where s.household_id = hh and c.seed_id is distinct from t.component_id;
  if n <> 0 then
    raise exception 'copy fidelity: % copied steps lost or mismatched their component', n;
  end if;

  delete from public.households where id = hh;

  foreach t in array array['products', 'recipes', 'recipe_components', 'recipe_ingredients', 'recipe_steps'] loop
    execute format('select count(*) from public.%I where household_id = $1', t) into n using hh;
    if n <> 0 then
      raise exception 'copy fidelity: % % rows left after deleting the household', n, t;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Done.
-- ---------------------------------------------------------------------------
do $$
begin
  raise notice 'seed_integrity: all assertions passed (counts, atwater, structure, amounts, coverage, macro diversity, copy fidelity)';
end;
$$;

select 'seed_integrity: all assertions passed' as result;

rollback;
