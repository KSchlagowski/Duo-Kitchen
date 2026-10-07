-- Seed content (roadmap F-02): the repo-maintained products and test recipes, copied into every
-- existing household. New households get them from the sign-up trigger.
--
-- Data only: fills private.seed_* (schema in 20261007120000_products_and_recipes.sql), then backfills.
-- Checked by supabase/tests/seed_integrity.sql (npm run test:seed).
--
-- Conventions:
--   * Nutrition per 100 g, Polish/EU label convention (carbohydrates exclude fibre). Liquids in grams.
--   * Piece products carry grams_per_piece (edible weight); their amounts are whole pieces, or half
--     pieces where allow_half_pieces is set.
--   * Every base amount is a multiple of its effective rounding step (ingredient override, else product).
--   * Base amounts are one sensible batch for two people.
--   * Stable ids: products 5eed0001-…-0000000000NN, recipes 5eed0002-…-0000000000RR,
--     components 5eed0003-…-00000000RRCC, ingredients 5eed0004-…-0000RRCCII, steps 5eed0005-…-00000000RRSS.

-- Looks up a seed product by name and fails loudly on a typo (session-scoped helper).
create function pg_temp.seed_product(p_name text)
returns uuid
language plpgsql
as $$
declare
  product_id uuid;
begin
  select id into product_id from private.seed_products where name = p_name;
  if product_id is null then
    raise exception 'seed content: unknown seed product "%"', p_name;
  end if;
  return product_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------
insert into private.seed_products
  (id, name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, aisle, rounding_step_g, grams_per_piece)
values
  ('5eed0001-0000-4000-8000-000000000001', 'Jajko kurze (rozmiar M)', 140, 12.5, 9.7, 0.6, 'dairy', 10, 50),
  ('5eed0001-0000-4000-8000-000000000002', 'Masło extra 82%', 740, 0.7, 82, 0.7, 'dairy', 5, null),
  ('5eed0001-0000-4000-8000-000000000003', 'Chleb żytni na zakwasie', 230, 6, 1.5, 45, 'bakery', 10, 35),
  ('5eed0001-0000-4000-8000-000000000004', 'Sól', 0, 0, 0, 0, 'spices', 1, null),
  ('5eed0001-0000-4000-8000-000000000005', 'Pieprz czarny mielony', 250, 10, 3.3, 39, 'spices', 1, null),
  ('5eed0001-0000-4000-8000-000000000006', 'Szczypiorek', 30, 3.3, 0.7, 1.9, 'produce', 5, null),
  ('5eed0001-0000-4000-8000-000000000007', 'Płatki owsiane górskie', 370, 13, 7, 60, 'dry_goods', 10, null),
  ('5eed0001-0000-4000-8000-000000000008', 'Mleko 2%', 50, 3.4, 2, 4.8, 'dairy', 10, null),
  ('5eed0001-0000-4000-8000-000000000009', 'Odżywka białkowa WPC', 390, 75, 6, 8, 'other', 5, null),
  ('5eed0001-0000-4000-8000-000000000010', 'Banan', 97, 1.1, 0.3, 21.8, 'produce', 10, 120),
  ('5eed0001-0000-4000-8000-000000000011', 'Jogurt naturalny 2%', 60, 4.3, 2, 6, 'dairy', 10, null),
  ('5eed0001-0000-4000-8000-000000000012', 'Borówki amerykańskie mrożone', 57, 0.7, 0.3, 12, 'frozen', 10, null),
  ('5eed0001-0000-4000-8000-000000000013', 'Kakao naturalne', 334, 23, 10.5, 13, 'dry_goods', 5, null),
  ('5eed0001-0000-4000-8000-000000000014', 'Proszek do pieczenia', 53, 0, 0, 13, 'dry_goods', 1, null),
  ('5eed0001-0000-4000-8000-000000000015', 'Miód wielokwiatowy', 324, 0.3, 0, 80, 'dry_goods', 5, null),
  ('5eed0001-0000-4000-8000-000000000016', 'Masło orzechowe 100%', 600, 25, 50, 12, 'dry_goods', 10, null),
  ('5eed0001-0000-4000-8000-000000000017', 'Pierś z kurczaka', 98, 21.5, 1.3, 0, 'meat_fish', 10, null),
  ('5eed0001-0000-4000-8000-000000000018', 'Ryż basmati', 350, 8, 0.6, 78, 'dry_goods', 10, null),
  ('5eed0001-0000-4000-8000-000000000019', 'Mleczko kokosowe 18%', 180, 1.5, 18, 3, 'dry_goods', 10, null),
  ('5eed0001-0000-4000-8000-000000000020', 'Curry w proszku', 325, 14, 14, 25, 'spices', 1, null),
  ('5eed0001-0000-4000-8000-000000000021', 'Cebula', 40, 1.1, 0.1, 7.6, 'produce', 10, null),
  ('5eed0001-0000-4000-8000-000000000022', 'Czosnek', 149, 6.4, 0.5, 30, 'produce', 5, 5),
  ('5eed0001-0000-4000-8000-000000000023', 'Pomidory krojone z puszki', 22, 1.2, 0.2, 3.5, 'dry_goods', 10, null),
  ('5eed0001-0000-4000-8000-000000000024', 'Oliwa z oliwek', 884, 0, 100, 0, 'dry_goods', 5, null),
  ('5eed0001-0000-4000-8000-000000000025', 'Makaron spaghetti', 355, 12.5, 1.5, 71, 'dry_goods', 10, null),
  ('5eed0001-0000-4000-8000-000000000026', 'Krewetki koktajlowe mrożone', 70, 15, 0.8, 0.5, 'frozen', 10, null),
  ('5eed0001-0000-4000-8000-000000000027', 'Pomidorki koktajlowe', 20, 0.9, 0.2, 3, 'produce', 10, null),
  ('5eed0001-0000-4000-8000-000000000028', 'Natka pietruszki', 36, 3, 0.8, 3.6, 'produce', 5, null),
  ('5eed0001-0000-4000-8000-000000000029', 'Papryka czerwona', 31, 1, 0.3, 6, 'produce', 10, null),
  ('5eed0001-0000-4000-8000-000000000030', 'Cukinia', 17, 1.2, 0.3, 2.2, 'produce', 10, null),
  ('5eed0001-0000-4000-8000-000000000031', 'Kiełbasa śląska', 290, 14, 26, 1, 'meat_fish', 10, null),
  ('5eed0001-0000-4000-8000-000000000032', 'Papryka słodka mielona', 282, 14, 13, 19, 'spices', 1, null),
  ('5eed0001-0000-4000-8000-000000000033', 'Koncentrat pomidorowy 30%', 98, 4.5, 0.5, 17, 'dry_goods', 10, null),
  ('5eed0001-0000-4000-8000-000000000034', 'Twaróg półtłusty', 133, 18, 4.7, 3.7, 'dairy', 10, null),
  ('5eed0001-0000-4000-8000-000000000035', 'Rzodkiewka', 16, 1, 0.1, 2.4, 'produce', 10, null),
  ('5eed0001-0000-4000-8000-000000000036', 'Bułka grahamka', 250, 9, 3, 44, 'bakery', 10, 60),
  ('5eed0001-0000-4000-8000-000000000037', 'Ser gouda', 356, 25, 28, 0.1, 'dairy', 10, null),
  ('5eed0001-0000-4000-8000-000000000038', 'Brokuł mrożony', 28, 2.8, 0.4, 2.7, 'frozen', 10, null),
  ('5eed0001-0000-4000-8000-000000000039', 'Śmietanka 18%', 184, 2.5, 18, 3.5, 'dairy', 10, null),
  ('5eed0001-0000-4000-8000-000000000040', 'Makaron penne', 355, 12.5, 1.5, 71, 'dry_goods', 10, null),
  ('5eed0001-0000-4000-8000-000000000041', 'Bułka tarta', 350, 11, 2, 70, 'bakery', 10, null),
  -- Common extras, not used by the seed recipes yet.
  ('5eed0001-0000-4000-8000-000000000042', 'Jabłko', 52, 0.3, 0.2, 12, 'produce', 10, 180),
  ('5eed0001-0000-4000-8000-000000000043', 'Pomidor', 18, 0.9, 0.2, 3, 'produce', 10, null),
  ('5eed0001-0000-4000-8000-000000000044', 'Oregano suszone', 265, 9, 4.3, 27, 'spices', 1, null),
  ('5eed0001-0000-4000-8000-000000000045', 'Filet z łososia', 200, 20, 13, 0, 'meat_fish', 10, null),
  ('5eed0001-0000-4000-8000-000000000046', 'Kasza gryczana', 346, 12.6, 3.1, 62, 'dry_goods', 10, null);

-- ---------------------------------------------------------------------------
-- Recipes
-- ---------------------------------------------------------------------------
insert into private.seed_recipes (id, name, cuisine, prep_minutes, meal_types, division_mode)
values
  ('5eed0002-0000-4000-8000-000000000001', 'Jajecznica na maśle z pieczywem', 'polska', 15,
    '{breakfast}', 'per_component'),
  ('5eed0002-0000-4000-8000-000000000002', 'Owsianka proteinowa (overnight)', 'fit', 10,
    '{breakfast,second_breakfast}', 'per_component'),
  ('5eed0002-0000-4000-8000-000000000003', 'Ciastka proteinowe', 'fit', 35,
    '{second_breakfast,afternoon_snack}', 'whole_dish'),
  ('5eed0002-0000-4000-8000-000000000004', 'Kurczak curry z ryżem', 'indyjska', 40,
    '{lunch,dinner}', 'per_component'),
  ('5eed0002-0000-4000-8000-000000000005', 'Makaron z krewetkami', 'włoska', 20,
    '{lunch,dinner}', 'per_component'),
  ('5eed0002-0000-4000-8000-000000000006', 'Leczo z kiełbasą', 'węgierska', 60,
    '{dinner}', 'whole_dish'),
  ('5eed0002-0000-4000-8000-000000000007', 'Twarożek ze szczypiorkiem', 'polska', 10,
    '{second_breakfast,afternoon_snack}', 'per_component'),
  ('5eed0002-0000-4000-8000-000000000008', 'Zapiekanka makaronowa', 'polska', 50,
    '{}', 'whole_dish');

-- ---------------------------------------------------------------------------
-- Components (cooked_yield_ratio = cooked weight / raw weight)
-- ---------------------------------------------------------------------------
insert into private.seed_recipe_components (id, recipe_id, position, name, cooked_yield_ratio)
values
  ('5eed0003-0000-4000-8000-000000000101', '5eed0002-0000-4000-8000-000000000001', 1, 'Jajecznica', null),
  ('5eed0003-0000-4000-8000-000000000102', '5eed0002-0000-4000-8000-000000000001', 2, 'Pieczywo', null),
  ('5eed0003-0000-4000-8000-000000000201', '5eed0002-0000-4000-8000-000000000002', 1, 'Baza owsiana', null),
  ('5eed0003-0000-4000-8000-000000000202', '5eed0002-0000-4000-8000-000000000002', 2, 'Owoce', null),
  ('5eed0003-0000-4000-8000-000000000301', '5eed0002-0000-4000-8000-000000000003', 1, 'Ciastka', null),
  ('5eed0003-0000-4000-8000-000000000401', '5eed0002-0000-4000-8000-000000000004', 1, 'Ryż', 2.50),
  ('5eed0003-0000-4000-8000-000000000402', '5eed0002-0000-4000-8000-000000000004', 2, 'Kurczak', 0.75),
  ('5eed0003-0000-4000-8000-000000000403', '5eed0002-0000-4000-8000-000000000004', 3, 'Sos curry', null),
  ('5eed0003-0000-4000-8000-000000000501', '5eed0002-0000-4000-8000-000000000005', 1, 'Makaron', 2.20),
  ('5eed0003-0000-4000-8000-000000000502', '5eed0002-0000-4000-8000-000000000005', 2, 'Krewetki w sosie', null),
  ('5eed0003-0000-4000-8000-000000000601', '5eed0002-0000-4000-8000-000000000006', 1, 'Leczo', null),
  ('5eed0003-0000-4000-8000-000000000701', '5eed0002-0000-4000-8000-000000000007', 1, 'Twarożek', null),
  ('5eed0003-0000-4000-8000-000000000702', '5eed0002-0000-4000-8000-000000000007', 2, 'Pieczywo', null),
  ('5eed0003-0000-4000-8000-000000000801', '5eed0002-0000-4000-8000-000000000008', 1, 'Zapiekanka', null);

-- ---------------------------------------------------------------------------
-- Ingredients (base batch in grams)
-- ---------------------------------------------------------------------------
insert into private.seed_recipe_ingredients
  (id, component_id, product_id, position, base_amount_g, rounding_step_g, min_amount_g, allow_half_pieces)
values
  -- 1. Jajecznica na maśle z pieczywem
  ('5eed0004-0000-4000-8000-000000010101', '5eed0003-0000-4000-8000-000000000101', pg_temp.seed_product('Jajko kurze (rozmiar M)'), 1, 200, null, 50, false),
  ('5eed0004-0000-4000-8000-000000010102', '5eed0003-0000-4000-8000-000000000101', pg_temp.seed_product('Masło extra 82%'), 2, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000010103', '5eed0003-0000-4000-8000-000000000101', pg_temp.seed_product('Sól'), 3, 1, null, null, false),
  ('5eed0004-0000-4000-8000-000000010104', '5eed0003-0000-4000-8000-000000000101', pg_temp.seed_product('Pieprz czarny mielony'), 4, 1, null, null, false),
  ('5eed0004-0000-4000-8000-000000010105', '5eed0003-0000-4000-8000-000000000101', pg_temp.seed_product('Szczypiorek'), 5, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000010201', '5eed0003-0000-4000-8000-000000000102', pg_temp.seed_product('Chleb żytni na zakwasie'), 1, 140, null, null, true),
  -- 2. Owsianka proteinowa (overnight)
  ('5eed0004-0000-4000-8000-000000020101', '5eed0003-0000-4000-8000-000000000201', pg_temp.seed_product('Płatki owsiane górskie'), 1, 100, null, null, false),
  ('5eed0004-0000-4000-8000-000000020102', '5eed0003-0000-4000-8000-000000000201', pg_temp.seed_product('Mleko 2%'), 2, 300, null, null, false),
  ('5eed0004-0000-4000-8000-000000020103', '5eed0003-0000-4000-8000-000000000201', pg_temp.seed_product('Jogurt naturalny 2%'), 3, 200, null, null, false),
  ('5eed0004-0000-4000-8000-000000020104', '5eed0003-0000-4000-8000-000000000201', pg_temp.seed_product('Odżywka białkowa WPC'), 4, 35, null, null, false),
  ('5eed0004-0000-4000-8000-000000020105', '5eed0003-0000-4000-8000-000000000201', pg_temp.seed_product('Miód wielokwiatowy'), 5, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000020201', '5eed0003-0000-4000-8000-000000000202', pg_temp.seed_product('Banan'), 1, 120, null, null, true),
  ('5eed0004-0000-4000-8000-000000020202', '5eed0003-0000-4000-8000-000000000202', pg_temp.seed_product('Borówki amerykańskie mrożone'), 2, 100, null, null, false),
  -- 3. Ciastka proteinowe (cocoa overrides its 5 g product step with 1 g)
  ('5eed0004-0000-4000-8000-000000030101', '5eed0003-0000-4000-8000-000000000301', pg_temp.seed_product('Płatki owsiane górskie'), 1, 100, null, null, false),
  ('5eed0004-0000-4000-8000-000000030102', '5eed0003-0000-4000-8000-000000000301', pg_temp.seed_product('Banan'), 2, 240, null, null, false),
  ('5eed0004-0000-4000-8000-000000030103', '5eed0003-0000-4000-8000-000000000301', pg_temp.seed_product('Jajko kurze (rozmiar M)'), 3, 50, null, null, false),
  ('5eed0004-0000-4000-8000-000000030104', '5eed0003-0000-4000-8000-000000000301', pg_temp.seed_product('Odżywka białkowa WPC'), 4, 60, null, null, false),
  ('5eed0004-0000-4000-8000-000000030105', '5eed0003-0000-4000-8000-000000000301', pg_temp.seed_product('Masło orzechowe 100%'), 5, 30, null, null, false),
  ('5eed0004-0000-4000-8000-000000030106', '5eed0003-0000-4000-8000-000000000301', pg_temp.seed_product('Kakao naturalne'), 6, 12, 1, null, false),
  ('5eed0004-0000-4000-8000-000000030107', '5eed0003-0000-4000-8000-000000000301', pg_temp.seed_product('Proszek do pieczenia'), 7, 4, null, null, false),
  -- 4. Kurczak curry z ryżem
  ('5eed0004-0000-4000-8000-000000040101', '5eed0003-0000-4000-8000-000000000401', pg_temp.seed_product('Ryż basmati'), 1, 160, null, null, false),
  ('5eed0004-0000-4000-8000-000000040102', '5eed0003-0000-4000-8000-000000000401', pg_temp.seed_product('Sól'), 2, 1, null, null, false),
  ('5eed0004-0000-4000-8000-000000040201', '5eed0003-0000-4000-8000-000000000402', pg_temp.seed_product('Pierś z kurczaka'), 1, 400, null, null, false),
  ('5eed0004-0000-4000-8000-000000040202', '5eed0003-0000-4000-8000-000000000402', pg_temp.seed_product('Curry w proszku'), 2, 4, null, null, false),
  ('5eed0004-0000-4000-8000-000000040203', '5eed0003-0000-4000-8000-000000000402', pg_temp.seed_product('Sól'), 3, 2, null, null, false),
  ('5eed0004-0000-4000-8000-000000040204', '5eed0003-0000-4000-8000-000000000402', pg_temp.seed_product('Oliwa z oliwek'), 4, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000040301', '5eed0003-0000-4000-8000-000000000403', pg_temp.seed_product('Mleczko kokosowe 18%'), 1, 200, null, null, false),
  ('5eed0004-0000-4000-8000-000000040302', '5eed0003-0000-4000-8000-000000000403', pg_temp.seed_product('Cebula'), 2, 100, null, null, false),
  ('5eed0004-0000-4000-8000-000000040303', '5eed0003-0000-4000-8000-000000000403', pg_temp.seed_product('Czosnek'), 3, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000040304', '5eed0003-0000-4000-8000-000000000403', pg_temp.seed_product('Pomidory krojone z puszki'), 4, 200, null, null, false),
  ('5eed0004-0000-4000-8000-000000040305', '5eed0003-0000-4000-8000-000000000403', pg_temp.seed_product('Curry w proszku'), 5, 6, null, null, false),
  ('5eed0004-0000-4000-8000-000000040306', '5eed0003-0000-4000-8000-000000000403', pg_temp.seed_product('Sól'), 6, 1, null, null, false),
  -- 5. Makaron z krewetkami
  ('5eed0004-0000-4000-8000-000000050101', '5eed0003-0000-4000-8000-000000000501', pg_temp.seed_product('Makaron spaghetti'), 1, 160, null, null, false),
  ('5eed0004-0000-4000-8000-000000050102', '5eed0003-0000-4000-8000-000000000501', pg_temp.seed_product('Sól'), 2, 2, null, null, false),
  ('5eed0004-0000-4000-8000-000000050201', '5eed0003-0000-4000-8000-000000000502', pg_temp.seed_product('Krewetki koktajlowe mrożone'), 1, 300, null, null, false),
  ('5eed0004-0000-4000-8000-000000050202', '5eed0003-0000-4000-8000-000000000502', pg_temp.seed_product('Oliwa z oliwek'), 2, 15, null, null, false),
  ('5eed0004-0000-4000-8000-000000050203', '5eed0003-0000-4000-8000-000000000502', pg_temp.seed_product('Czosnek'), 3, 15, null, null, false),
  ('5eed0004-0000-4000-8000-000000050204', '5eed0003-0000-4000-8000-000000000502', pg_temp.seed_product('Pomidorki koktajlowe'), 4, 200, null, null, false),
  ('5eed0004-0000-4000-8000-000000050205', '5eed0003-0000-4000-8000-000000000502', pg_temp.seed_product('Natka pietruszki'), 5, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000050206', '5eed0003-0000-4000-8000-000000000502', pg_temp.seed_product('Sól'), 6, 1, null, null, false),
  ('5eed0004-0000-4000-8000-000000050207', '5eed0003-0000-4000-8000-000000000502', pg_temp.seed_product('Pieprz czarny mielony'), 7, 1, null, null, false),
  -- 6. Leczo z kiełbasą
  ('5eed0004-0000-4000-8000-000000060101', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Kiełbasa śląska'), 1, 300, null, null, false),
  ('5eed0004-0000-4000-8000-000000060102', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Papryka czerwona'), 2, 400, null, null, false),
  ('5eed0004-0000-4000-8000-000000060103', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Cukinia'), 3, 300, null, null, false),
  ('5eed0004-0000-4000-8000-000000060104', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Cebula'), 4, 150, null, null, false),
  ('5eed0004-0000-4000-8000-000000060105', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Czosnek'), 5, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000060106', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Pomidory krojone z puszki'), 6, 400, null, null, false),
  ('5eed0004-0000-4000-8000-000000060107', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Koncentrat pomidorowy 30%'), 7, 50, null, null, false),
  ('5eed0004-0000-4000-8000-000000060108', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Oliwa z oliwek'), 8, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000060109', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Papryka słodka mielona'), 9, 3, null, null, false),
  ('5eed0004-0000-4000-8000-000000060110', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Sól'), 10, 3, null, null, false),
  ('5eed0004-0000-4000-8000-000000060111', '5eed0003-0000-4000-8000-000000000601', pg_temp.seed_product('Pieprz czarny mielony'), 11, 1, null, null, false),
  -- 7. Twarożek ze szczypiorkiem
  ('5eed0004-0000-4000-8000-000000070101', '5eed0003-0000-4000-8000-000000000701', pg_temp.seed_product('Twaróg półtłusty'), 1, 250, null, null, false),
  ('5eed0004-0000-4000-8000-000000070102', '5eed0003-0000-4000-8000-000000000701', pg_temp.seed_product('Jogurt naturalny 2%'), 2, 100, null, null, false),
  ('5eed0004-0000-4000-8000-000000070103', '5eed0003-0000-4000-8000-000000000701', pg_temp.seed_product('Szczypiorek'), 3, 20, null, null, false),
  ('5eed0004-0000-4000-8000-000000070104', '5eed0003-0000-4000-8000-000000000701', pg_temp.seed_product('Rzodkiewka'), 4, 100, null, null, false),
  ('5eed0004-0000-4000-8000-000000070105', '5eed0003-0000-4000-8000-000000000701', pg_temp.seed_product('Sól'), 5, 1, null, null, false),
  ('5eed0004-0000-4000-8000-000000070106', '5eed0003-0000-4000-8000-000000000701', pg_temp.seed_product('Pieprz czarny mielony'), 6, 1, null, null, false),
  ('5eed0004-0000-4000-8000-000000070201', '5eed0003-0000-4000-8000-000000000702', pg_temp.seed_product('Bułka grahamka'), 1, 120, null, null, true),
  -- 8. Zapiekanka makaronowa
  ('5eed0004-0000-4000-8000-000000080101', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Makaron penne'), 1, 250, null, null, false),
  ('5eed0004-0000-4000-8000-000000080102', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Pierś z kurczaka'), 2, 300, null, null, false),
  ('5eed0004-0000-4000-8000-000000080103', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Brokuł mrożony'), 3, 400, null, null, false),
  ('5eed0004-0000-4000-8000-000000080104', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Śmietanka 18%'), 4, 200, null, null, false),
  ('5eed0004-0000-4000-8000-000000080105', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Ser gouda'), 5, 100, null, null, false),
  ('5eed0004-0000-4000-8000-000000080106', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Bułka tarta'), 6, 20, null, null, false),
  ('5eed0004-0000-4000-8000-000000080107', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Czosnek'), 7, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000080108', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Oliwa z oliwek'), 8, 10, null, null, false),
  ('5eed0004-0000-4000-8000-000000080109', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Sól'), 9, 3, null, null, false),
  ('5eed0004-0000-4000-8000-000000080110', '5eed0003-0000-4000-8000-000000000801', pg_temp.seed_product('Pieprz czarny mielony'), 10, 1, null, null, false);

-- ---------------------------------------------------------------------------
-- Steps (make_ahead: the evening before; fresh: right before eating)
-- ---------------------------------------------------------------------------
insert into private.seed_recipe_steps (id, recipe_id, position, instruction, timing, component_id, duration_minutes)
values
  -- 1. Jajecznica na maśle z pieczywem
  ('5eed0005-0000-4000-8000-000000000101', '5eed0002-0000-4000-8000-000000000001', 1,
    'Roztop masło na patelni na średnim ogniu.', 'fresh', '5eed0003-0000-4000-8000-000000000101', 2),
  ('5eed0005-0000-4000-8000-000000000102', '5eed0002-0000-4000-8000-000000000001', 2,
    'Wbij jajka, dopraw solą i pieprzem, smaż, mieszając, aż się zetną.', 'fresh', '5eed0003-0000-4000-8000-000000000101', 5),
  ('5eed0005-0000-4000-8000-000000000103', '5eed0002-0000-4000-8000-000000000001', 3,
    'Posyp jajecznicę posiekanym szczypiorkiem.', 'fresh', '5eed0003-0000-4000-8000-000000000101', 1),
  ('5eed0005-0000-4000-8000-000000000104', '5eed0002-0000-4000-8000-000000000001', 4,
    'Pokrój chleb na kromki i podaj z jajecznicą.', 'fresh', '5eed0003-0000-4000-8000-000000000102', 2),
  -- 2. Owsianka proteinowa (overnight)
  ('5eed0005-0000-4000-8000-000000000201', '5eed0002-0000-4000-8000-000000000002', 1,
    'Wymieszaj płatki, mleko, jogurt, odżywkę i miód, rozłóż do słoików.', 'make_ahead', '5eed0003-0000-4000-8000-000000000201', 5),
  ('5eed0005-0000-4000-8000-000000000202', '5eed0002-0000-4000-8000-000000000002', 2,
    'Zamknij słoiki i wstaw na noc do lodówki.', 'make_ahead', '5eed0003-0000-4000-8000-000000000201', null),
  ('5eed0005-0000-4000-8000-000000000203', '5eed0002-0000-4000-8000-000000000002', 3,
    'Rano pokrój banana i wyłóż na owsiankę razem z borówkami.', 'fresh', '5eed0003-0000-4000-8000-000000000202', 3),
  -- 3. Ciastka proteinowe
  ('5eed0005-0000-4000-8000-000000000301', '5eed0002-0000-4000-8000-000000000003', 1,
    'Rozgrzej piekarnik do 180°C.', 'make_ahead', null, 10),
  ('5eed0005-0000-4000-8000-000000000302', '5eed0002-0000-4000-8000-000000000003', 2,
    'Rozgnieć banany widelcem, dodaj jajko i masło orzechowe, wymieszaj.', 'make_ahead', '5eed0003-0000-4000-8000-000000000301', 5),
  ('5eed0005-0000-4000-8000-000000000303', '5eed0002-0000-4000-8000-000000000003', 3,
    'Dodaj płatki, odżywkę, kakao i proszek do pieczenia, wymieszaj na gęstą masę.', 'make_ahead', '5eed0003-0000-4000-8000-000000000301', 5),
  ('5eed0005-0000-4000-8000-000000000304', '5eed0002-0000-4000-8000-000000000003', 4,
    'Uformuj ciastka na blasze z papierem i piecz 15 minut.', 'make_ahead', '5eed0003-0000-4000-8000-000000000301', 15),
  ('5eed0005-0000-4000-8000-000000000305', '5eed0002-0000-4000-8000-000000000003', 5,
    'Wystudź ciastka i przełóż do szczelnego pojemnika.', 'make_ahead', '5eed0003-0000-4000-8000-000000000301', 10),
  -- 4. Kurczak curry z ryżem
  ('5eed0005-0000-4000-8000-000000000401', '5eed0002-0000-4000-8000-000000000004', 1,
    'Ugotuj ryż w osolonej wodzie i zważ go po ugotowaniu.', 'make_ahead', '5eed0003-0000-4000-8000-000000000401', 15),
  ('5eed0005-0000-4000-8000-000000000402', '5eed0002-0000-4000-8000-000000000004', 2,
    'Pokrój kurczaka w kostkę, dopraw curry i solą.', 'make_ahead', '5eed0003-0000-4000-8000-000000000402', 5),
  ('5eed0005-0000-4000-8000-000000000403', '5eed0002-0000-4000-8000-000000000004', 3,
    'Obsmaż kurczaka na oliwie i zważ go po usmażeniu.', 'make_ahead', '5eed0003-0000-4000-8000-000000000402', 10),
  ('5eed0005-0000-4000-8000-000000000404', '5eed0002-0000-4000-8000-000000000004', 4,
    'Zeszklij cebulę z czosnkiem, dodaj pomidory, mleczko kokosowe i curry, gotuj 10 minut.', 'make_ahead', '5eed0003-0000-4000-8000-000000000403', 15),
  ('5eed0005-0000-4000-8000-000000000405', '5eed0002-0000-4000-8000-000000000004', 5,
    'Odważ porcje każdego składnika, odgrzej i podaj.', 'fresh', null, 5),
  -- 5. Makaron z krewetkami
  ('5eed0005-0000-4000-8000-000000000501', '5eed0002-0000-4000-8000-000000000005', 1,
    'Przełóż krewetki z zamrażarki do lodówki, aby się rozmroziły.', 'make_ahead', '5eed0003-0000-4000-8000-000000000502', null),
  ('5eed0005-0000-4000-8000-000000000502', '5eed0002-0000-4000-8000-000000000005', 2,
    'Ugotuj makaron al dente w osolonej wodzie i zważ go po ugotowaniu.', 'fresh', '5eed0003-0000-4000-8000-000000000501', 10),
  ('5eed0005-0000-4000-8000-000000000503', '5eed0002-0000-4000-8000-000000000005', 3,
    'Na oliwie podsmaż czosnek, dodaj krewetki i przekrojone pomidorki, smaż 5 minut.', 'fresh', '5eed0003-0000-4000-8000-000000000502', 6),
  ('5eed0005-0000-4000-8000-000000000504', '5eed0002-0000-4000-8000-000000000005', 4,
    'Dopraw solą i pieprzem, posyp natką i podaj z makaronem.', 'fresh', '5eed0003-0000-4000-8000-000000000502', 2),
  -- 6. Leczo z kiełbasą
  ('5eed0005-0000-4000-8000-000000000601', '5eed0002-0000-4000-8000-000000000006', 1,
    'Pokrój kiełbasę, paprykę, cukinię, cebulę i czosnek.', 'make_ahead', '5eed0003-0000-4000-8000-000000000601', 15),
  ('5eed0005-0000-4000-8000-000000000602', '5eed0002-0000-4000-8000-000000000006', 2,
    'Podsmaż kiełbasę z cebulą i czosnkiem na oliwie.', 'make_ahead', '5eed0003-0000-4000-8000-000000000601', 10),
  ('5eed0005-0000-4000-8000-000000000603', '5eed0002-0000-4000-8000-000000000006', 3,
    'Dodaj paprykę, cukinię, pomidory i koncentrat, duś pod przykryciem 30 minut.', 'make_ahead', '5eed0003-0000-4000-8000-000000000601', 30),
  ('5eed0005-0000-4000-8000-000000000604', '5eed0002-0000-4000-8000-000000000006', 4,
    'Dopraw papryką słodką, solą i pieprzem, wystudź i przełóż do pojemnika.', 'make_ahead', '5eed0003-0000-4000-8000-000000000601', 5),
  ('5eed0005-0000-4000-8000-000000000605', '5eed0002-0000-4000-8000-000000000006', 5,
    'Odgrzej porcje przed podaniem.', 'fresh', '5eed0003-0000-4000-8000-000000000601', 5),
  -- 7. Twarożek ze szczypiorkiem
  ('5eed0005-0000-4000-8000-000000000701', '5eed0002-0000-4000-8000-000000000007', 1,
    'Rozgnieć twaróg widelcem z jogurtem.', 'make_ahead', '5eed0003-0000-4000-8000-000000000701', 3),
  ('5eed0005-0000-4000-8000-000000000702', '5eed0002-0000-4000-8000-000000000007', 2,
    'Posiekaj szczypiorek i rzodkiewkę, wmieszaj do twarogu, dopraw solą i pieprzem.', 'make_ahead', '5eed0003-0000-4000-8000-000000000701', 5),
  ('5eed0005-0000-4000-8000-000000000703', '5eed0002-0000-4000-8000-000000000007', 3,
    'Przekrój bułki i podaj z twarożkiem.', 'fresh', '5eed0003-0000-4000-8000-000000000702', 1),
  -- 8. Zapiekanka makaronowa
  ('5eed0005-0000-4000-8000-000000000801', '5eed0002-0000-4000-8000-000000000008', 1,
    'Ugotuj makaron al dente.', 'make_ahead', '5eed0003-0000-4000-8000-000000000801', 10),
  ('5eed0005-0000-4000-8000-000000000802', '5eed0002-0000-4000-8000-000000000008', 2,
    'Pokrój kurczaka w kostkę i podsmaż na oliwie z czosnkiem.', 'make_ahead', '5eed0003-0000-4000-8000-000000000801', 10),
  ('5eed0005-0000-4000-8000-000000000803', '5eed0002-0000-4000-8000-000000000008', 3,
    'Wymieszaj makaron, kurczaka, brokuł i śmietankę, dopraw, przełóż do naczynia żaroodpornego, posyp serem i bułką tartą.', 'make_ahead', '5eed0003-0000-4000-8000-000000000801', 10),
  ('5eed0005-0000-4000-8000-000000000804', '5eed0002-0000-4000-8000-000000000008', 4,
    'Zapiekaj 25 minut w 200°C.', 'fresh', '5eed0003-0000-4000-8000-000000000801', 25);

drop function pg_temp.seed_product(text);

-- ---------------------------------------------------------------------------
-- Backfill: every existing household gets the seed set (idempotent; no household can edit or
-- delete seed rows yet, so nothing is resurrected).
-- ---------------------------------------------------------------------------
do $$
declare
  h record;
begin
  for h in select id from public.households loop
    perform private.seed_household(h.id);
  end loop;
end;
$$;
