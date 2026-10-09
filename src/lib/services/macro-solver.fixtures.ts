import type { MacroTargetsInput, PlanMealRecord, SolverComponent, SolverIngredient, SolverRecipe } from "@/types";

// The 8 seed recipes as solver input, transcribed from
// supabase/migrations/20261007120100_seed_products_and_recipes.sql (moved unchanged into the public
// library by 20261008150000_shared_recipe_library.sql). Ids are the seed's stable 5eed000N-… ids.

interface Product {
  name: string;
  kcal: number;
  protein: number;
  fat: number;
  carbs: number;
  step: number;
  piece: number | null;
}

const P = {
  egg: { name: "Jajko kurze (rozmiar M)", kcal: 140, protein: 12.5, fat: 9.7, carbs: 0.6, step: 10, piece: 50 },
  butter: { name: "Masło extra 82%", kcal: 740, protein: 0.7, fat: 82, carbs: 0.7, step: 5, piece: null },
  ryeBread: { name: "Chleb żytni na zakwasie", kcal: 230, protein: 6, fat: 1.5, carbs: 45, step: 10, piece: 35 },
  salt: { name: "Sól", kcal: 0, protein: 0, fat: 0, carbs: 0, step: 1, piece: null },
  pepper: { name: "Pieprz czarny mielony", kcal: 250, protein: 10, fat: 3.3, carbs: 39, step: 1, piece: null },
  chives: { name: "Szczypiorek", kcal: 30, protein: 3.3, fat: 0.7, carbs: 1.9, step: 5, piece: null },
  oats: { name: "Płatki owsiane górskie", kcal: 370, protein: 13, fat: 7, carbs: 60, step: 10, piece: null },
  milk: { name: "Mleko 2%", kcal: 50, protein: 3.4, fat: 2, carbs: 4.8, step: 10, piece: null },
  wpc: { name: "Odżywka białkowa WPC", kcal: 390, protein: 75, fat: 6, carbs: 8, step: 5, piece: null },
  banana: { name: "Banan", kcal: 97, protein: 1.1, fat: 0.3, carbs: 21.8, step: 10, piece: 120 },
  yogurt: { name: "Jogurt naturalny 2%", kcal: 60, protein: 4.3, fat: 2, carbs: 6, step: 10, piece: null },
  blueberries: {
    name: "Borówki amerykańskie mrożone",
    kcal: 57,
    protein: 0.7,
    fat: 0.3,
    carbs: 12,
    step: 10,
    piece: null,
  },
  cocoa: { name: "Kakao naturalne", kcal: 334, protein: 23, fat: 10.5, carbs: 13, step: 5, piece: null },
  bakingPowder: { name: "Proszek do pieczenia", kcal: 53, protein: 0, fat: 0, carbs: 13, step: 1, piece: null },
  honey: { name: "Miód wielokwiatowy", kcal: 324, protein: 0.3, fat: 0, carbs: 80, step: 5, piece: null },
  peanutButter: { name: "Masło orzechowe 100%", kcal: 600, protein: 25, fat: 50, carbs: 12, step: 10, piece: null },
  chicken: { name: "Pierś z kurczaka", kcal: 98, protein: 21.5, fat: 1.3, carbs: 0, step: 10, piece: null },
  rice: { name: "Ryż basmati", kcal: 350, protein: 8, fat: 0.6, carbs: 78, step: 10, piece: null },
  coconutMilk: { name: "Mleczko kokosowe 18%", kcal: 180, protein: 1.5, fat: 18, carbs: 3, step: 10, piece: null },
  curry: { name: "Curry w proszku", kcal: 325, protein: 14, fat: 14, carbs: 25, step: 1, piece: null },
  onion: { name: "Cebula", kcal: 40, protein: 1.1, fat: 0.1, carbs: 7.6, step: 10, piece: null },
  garlic: { name: "Czosnek", kcal: 149, protein: 6.4, fat: 0.5, carbs: 30, step: 5, piece: 5 },
  cannedTomatoes: {
    name: "Pomidory krojone z puszki",
    kcal: 22,
    protein: 1.2,
    fat: 0.2,
    carbs: 3.5,
    step: 10,
    piece: null,
  },
  oliveOil: { name: "Oliwa z oliwek", kcal: 884, protein: 0, fat: 100, carbs: 0, step: 5, piece: null },
  spaghetti: { name: "Makaron spaghetti", kcal: 355, protein: 12.5, fat: 1.5, carbs: 71, step: 10, piece: null },
  shrimp: { name: "Krewetki koktajlowe mrożone", kcal: 70, protein: 15, fat: 0.8, carbs: 0.5, step: 10, piece: null },
  cherryTomatoes: { name: "Pomidorki koktajlowe", kcal: 20, protein: 0.9, fat: 0.2, carbs: 3, step: 10, piece: null },
  parsley: { name: "Natka pietruszki", kcal: 36, protein: 3, fat: 0.8, carbs: 3.6, step: 5, piece: null },
  redPepper: { name: "Papryka czerwona", kcal: 31, protein: 1, fat: 0.3, carbs: 6, step: 10, piece: null },
  zucchini: { name: "Cukinia", kcal: 17, protein: 1.2, fat: 0.3, carbs: 2.2, step: 10, piece: null },
  sausage: { name: "Kiełbasa śląska", kcal: 290, protein: 14, fat: 26, carbs: 1, step: 10, piece: null },
  paprika: { name: "Papryka słodka mielona", kcal: 282, protein: 14, fat: 13, carbs: 19, step: 1, piece: null },
  tomatoPaste: {
    name: "Koncentrat pomidorowy 30%",
    kcal: 98,
    protein: 4.5,
    fat: 0.5,
    carbs: 17,
    step: 10,
    piece: null,
  },
  quark: { name: "Twaróg półtłusty", kcal: 133, protein: 18, fat: 4.7, carbs: 3.7, step: 10, piece: null },
  radish: { name: "Rzodkiewka", kcal: 16, protein: 1, fat: 0.1, carbs: 2.4, step: 10, piece: null },
  grahamRoll: { name: "Bułka grahamka", kcal: 250, protein: 9, fat: 3, carbs: 44, step: 10, piece: 60 },
  gouda: { name: "Ser gouda", kcal: 356, protein: 25, fat: 28, carbs: 0.1, step: 10, piece: null },
  broccoli: { name: "Brokuł mrożony", kcal: 28, protein: 2.8, fat: 0.4, carbs: 2.7, step: 10, piece: null },
  cream: { name: "Śmietanka 18%", kcal: 184, protein: 2.5, fat: 18, carbs: 3.5, step: 10, piece: null },
  penne: { name: "Makaron penne", kcal: 355, protein: 12.5, fat: 1.5, carbs: 71, step: 10, piece: null },
  breadcrumbs: { name: "Bułka tarta", kcal: 350, protein: 11, fat: 2, carbs: 70, step: 10, piece: null },
} satisfies Record<string, Product>;

interface IngredientSpec {
  product: Product;
  base: number;
  step?: number;
  min?: number;
  half?: boolean;
}

// Ingredient id 5eed0004-…-000000RRCCII, component id 5eed0003-…-00000000RRCC.
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ingredient(r: number, c: number, position: number, spec: IngredientSpec): SolverIngredient {
  return {
    id: `5eed0004-0000-4000-8000-000000${pad(r)}${pad(c)}${pad(position)}`,
    position,
    productName: spec.product.name,
    baseAmountG: spec.base,
    effectiveRoundingStepG: spec.step ?? spec.product.step,
    minAmountG: spec.min ?? null,
    gramsPerPiece: spec.product.piece,
    allowHalfPieces: spec.half ?? false,
    kcalPer100g: spec.product.kcal,
    proteinPer100g: spec.product.protein,
    fatPer100g: spec.product.fat,
    carbsPer100g: spec.product.carbs,
  };
}

function component(
  r: number,
  c: number,
  name: string,
  cookedYieldRatio: number | null,
  specs: IngredientSpec[],
): SolverComponent {
  return {
    id: `5eed0003-0000-4000-8000-00000000${pad(r)}${pad(c)}`,
    position: c,
    name,
    cookedYieldRatio,
    ingredients: specs.map((spec, i) => ingredient(r, c, i + 1, spec)),
  };
}

export function recipeId(r: number): string {
  return `5eed0002-0000-4000-8000-0000000000${pad(r)}`;
}

function recipe(
  r: number,
  name: string,
  divisionMode: SolverRecipe["divisionMode"],
  components: SolverComponent[],
): SolverRecipe {
  return { id: recipeId(r), name, divisionMode, components };
}

export const JAJECZNICA = recipeId(1);
export const OWSIANKA = recipeId(2);
export const CIASTKA = recipeId(3);
export const CURRY = recipeId(4);
export const KREWETKI = recipeId(5);
export const LECZO = recipeId(6);
export const TWAROZEK = recipeId(7);
export const ZAPIEKANKA = recipeId(8);

export const SEED_RECIPES: Record<string, SolverRecipe> = Object.fromEntries(
  [
    recipe(1, "Jajecznica na maśle z pieczywem", "per_component", [
      component(1, 1, "Jajecznica", null, [
        { product: P.egg, base: 200, min: 50 },
        { product: P.butter, base: 10 },
        { product: P.salt, base: 1 },
        { product: P.pepper, base: 1 },
        { product: P.chives, base: 10 },
      ]),
      component(1, 2, "Pieczywo", null, [{ product: P.ryeBread, base: 140, half: true }]),
    ]),
    recipe(2, "Owsianka proteinowa (overnight)", "per_component", [
      component(2, 1, "Baza owsiana", null, [
        { product: P.oats, base: 100 },
        { product: P.milk, base: 300 },
        { product: P.yogurt, base: 200 },
        { product: P.wpc, base: 35 },
        { product: P.honey, base: 10 },
      ]),
      component(2, 2, "Owoce", null, [
        { product: P.banana, base: 120, half: true },
        { product: P.blueberries, base: 100 },
      ]),
    ]),
    recipe(3, "Ciastka proteinowe", "whole_dish", [
      component(3, 1, "Ciastka", null, [
        { product: P.oats, base: 100 },
        { product: P.banana, base: 240 },
        { product: P.egg, base: 50 },
        { product: P.wpc, base: 60 },
        { product: P.peanutButter, base: 30 },
        { product: P.cocoa, base: 12, step: 1 },
        { product: P.bakingPowder, base: 4 },
      ]),
    ]),
    recipe(4, "Kurczak curry z ryżem", "per_component", [
      component(4, 1, "Ryż", 2.5, [
        { product: P.rice, base: 160 },
        { product: P.salt, base: 1 },
      ]),
      component(4, 2, "Kurczak", 0.75, [
        { product: P.chicken, base: 400 },
        { product: P.curry, base: 4 },
        { product: P.salt, base: 2 },
        { product: P.oliveOil, base: 10 },
      ]),
      component(4, 3, "Sos curry", null, [
        { product: P.coconutMilk, base: 200 },
        { product: P.onion, base: 100 },
        { product: P.garlic, base: 10 },
        { product: P.cannedTomatoes, base: 200 },
        { product: P.curry, base: 6 },
        { product: P.salt, base: 1 },
      ]),
    ]),
    recipe(5, "Makaron z krewetkami", "per_component", [
      component(5, 1, "Makaron", 2.2, [
        { product: P.spaghetti, base: 160 },
        { product: P.salt, base: 2 },
      ]),
      component(5, 2, "Krewetki w sosie", null, [
        { product: P.shrimp, base: 300 },
        { product: P.oliveOil, base: 15 },
        { product: P.garlic, base: 15 },
        { product: P.cherryTomatoes, base: 200 },
        { product: P.parsley, base: 10 },
        { product: P.salt, base: 1 },
        { product: P.pepper, base: 1 },
      ]),
    ]),
    recipe(6, "Leczo z kiełbasą", "whole_dish", [
      component(6, 1, "Leczo", null, [
        { product: P.sausage, base: 300 },
        { product: P.redPepper, base: 400 },
        { product: P.zucchini, base: 300 },
        { product: P.onion, base: 150 },
        { product: P.garlic, base: 10 },
        { product: P.cannedTomatoes, base: 400 },
        { product: P.tomatoPaste, base: 50 },
        { product: P.oliveOil, base: 10 },
        { product: P.paprika, base: 3 },
        { product: P.salt, base: 3 },
        { product: P.pepper, base: 1 },
      ]),
    ]),
    recipe(7, "Twarożek ze szczypiorkiem", "per_component", [
      component(7, 1, "Twarożek", null, [
        { product: P.quark, base: 250 },
        { product: P.yogurt, base: 100 },
        { product: P.chives, base: 20 },
        { product: P.radish, base: 100 },
        { product: P.salt, base: 1 },
        { product: P.pepper, base: 1 },
      ]),
      component(7, 2, "Pieczywo", null, [{ product: P.grahamRoll, base: 120, half: true }]),
    ]),
    recipe(8, "Zapiekanka makaronowa", "whole_dish", [
      component(8, 1, "Zapiekanka", null, [
        { product: P.penne, base: 250 },
        { product: P.chicken, base: 300 },
        { product: P.broccoli, base: 400 },
        { product: P.cream, base: 200 },
        { product: P.gouda, base: 100 },
        { product: P.breadcrumbs, base: 20 },
        { product: P.garlic, base: 10 },
        { product: P.oliveOil, base: 10 },
        { product: P.salt, base: 3 },
        { product: P.pepper, base: 1 },
      ]),
    ]),
  ].map((r) => [r.id, r]),
);

// The smoke test's accounts and targets (scripts/smoke.mjs). A sorts before B by user id.
export const USER_A = "00000000-0000-4000-8000-00000000000a";
export const USER_B = "00000000-0000-4000-8000-00000000000b";
export const TARGET_A: MacroTargetsInput = { kcal: 2200, proteinG: 160, fatG: 70, carbsG: 230 };
export const TARGET_B: MacroTargetsInput = { kcal: 1800, proteinG: 120, fatG: 60, carbsG: 180 };

const SLOTS = ["breakfast", "second_breakfast", "lunch", "afternoon_snack", "dinner"] as const;

// One day of meals, slot by slot; `null` leaves the slot empty. Eater null = both.
export function day(recipes: (string | null)[], eaters: (string | null)[] = []): PlanMealRecord[] {
  return recipes.flatMap((recipeIdValue, slot) =>
    recipeIdValue === null
      ? []
      : [
          {
            mealId: `00000000-0000-4000-8000-0000000001${pad(slot)}`,
            dayIndex: 0 as const,
            mealType: SLOTS[slot],
            recipeId: recipeIdValue,
            eaterUserId: eaters[slot] ?? null,
          },
        ],
  );
}

export const F1 = day([JAJECZNICA, OWSIANKA, CURRY, TWAROZEK, LECZO]);
export const F2 = day([CIASTKA, LECZO, ZAPIEKANKA, CIASTKA, LECZO]);
export const F3 = day([CIASTKA, LECZO, ZAPIEKANKA, CIASTKA, null]);
export const F4 = day([JAJECZNICA, OWSIANKA, CURRY, TWAROZEK, LECZO], [null, USER_A, null, USER_B, null]);
