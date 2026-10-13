import { describe, expect, it } from "vitest";
import type {
  DaySolution,
  DaySolutionBatch,
  DaySolutionMeal,
  IngredientProduct,
  MealPlan,
  MealType,
  PlanDayIndex,
  PlanMealRecord,
  SolverIngredient,
  SolverRecipe,
  StoreAisle,
} from "@/types";
import {
  buildShoppingList,
  formatEstimateNote,
  formatExactNote,
  formatShoppingAmount,
  formatShoppingSummary,
  type ShoppingListInput,
} from "@/lib/services/shopping-list";

// Hand-built fixtures: two recipes sharing salt, plus an egg recipe for piece totals. Product names
// are the seed's (macro-solver.fixtures.ts), ids are short readable stand-ins.

const PRODUCTS: Record<string, { name: string; aisle: StoreAisle; piece: number | null }> = {
  salt: { name: "Sól", aisle: "spices", piece: null },
  rice: { name: "Ryż basmati", aisle: "dry_goods", piece: null },
  chicken: { name: "Pierś z kurczaka", aisle: "meat_fish", piece: null },
  onion: { name: "Cebula", aisle: "produce", piece: null },
  sausage: { name: "Kiełbasa śląska", aisle: "meat_fish", piece: null },
  zucchini: { name: "Cukinia", aisle: "produce", piece: null },
  egg: { name: "Jajko kurze (rozmiar M)", aisle: "dairy", piece: 50 },
  leek: { name: "Por", aisle: "produce", piece: null },
  lettuce: { name: "Łodyga selera", aisle: "produce", piece: null },
  lemon: { name: "Limonka", aisle: "produce", piece: null },
};

// Ingredient id → [recipe, product, base grams].
const INGREDIENTS: Record<string, [string, string, number]> = {
  "curry-rice": ["curry", "rice", 200],
  "curry-chicken": ["curry", "chicken", 400],
  "curry-onion": ["curry", "onion", 100],
  "curry-salt": ["curry", "salt", 4.1],
  "leczo-sausage": ["leczo", "sausage", 300],
  "leczo-zucchini": ["leczo", "zucchini", 250],
  "leczo-salt": ["leczo", "salt", 3],
  "eggs-a-egg": ["eggs-a", "egg", 25],
  "eggs-b-egg": ["eggs-b", "egg", 25],
  "greens-leek": ["greens", "leek", 100],
  "greens-lettuce": ["greens", "lettuce", 100],
  "greens-lemon": ["greens", "lemon", 100],
};

const INGREDIENT_PRODUCTS: Record<string, IngredientProduct> = Object.fromEntries(
  Object.entries(INGREDIENTS).map(([id, [, product]]) => [
    id,
    {
      ingredientId: id,
      productId: `p-${product}`,
      productName: PRODUCTS[product].name,
      aisle: PRODUCTS[product].aisle,
      gramsPerPiece: PRODUCTS[product].piece,
    },
  ]),
);

function solverIngredient(id: string): SolverIngredient {
  const [, product, grams] = INGREDIENTS[id];
  return {
    id,
    position: 1,
    productName: PRODUCTS[product].name,
    baseAmountG: grams,
    effectiveRoundingStepG: 1,
    minAmountG: null,
    gramsPerPiece: PRODUCTS[product].piece,
    allowHalfPieces: PRODUCTS[product].piece !== null,
    kcalPer100g: 0,
    proteinPer100g: 0,
    fatPer100g: 0,
    carbsPer100g: 0,
  };
}

const RECIPES: Record<string, SolverRecipe> = Object.fromEntries(
  ["curry", "leczo", "eggs-a", "eggs-b", "greens"].map((recipeId) => [
    recipeId,
    {
      id: recipeId,
      name: recipeId,
      divisionMode: "per_component",
      components: [
        {
          id: `${recipeId}-main`,
          position: 1,
          name: "Main",
          cookedYieldRatio: null,
          ingredients: Object.keys(INGREDIENTS)
            .filter((id) => INGREDIENTS[id][0] === recipeId)
            .map(solverIngredient),
        },
      ],
    },
  ]),
);

function meal(mealId: string, dishId: string, dayIndex: PlanDayIndex, mealType: MealType, recipeId: string) {
  return { mealId, dishId, dayIndex, mealType, recipeId, eaterUserId: null } satisfies PlanMealRecord;
}

function plan(meals: PlanMealRecord[]): MealPlan {
  return { id: "plan", startDate: "2031-01-27", updatedAt: "2031-01-27T00:00:00Z", meals };
}

// A stored meal of `recipeId` whose ingredients carry the given (batch) amounts.
function storedMeal(
  mealId: string,
  recipeId: string,
  amounts: Record<string, number>,
  batch: DaySolutionBatch | null = null,
): DaySolutionMeal {
  return {
    mealId,
    mealType: "lunch",
    recipeId,
    recipeName: recipeId,
    divisionMode: "per_component",
    eaterUserIds: ["user-a", "user-b"],
    components: [
      {
        id: `${recipeId}-main`,
        name: "Main",
        cookedYieldRatio: null,
        ingredients: Object.entries(amounts).map(([id, amountG]) => ({
          id,
          productName: PRODUCTS[INGREDIENTS[id][1]].name,
          amountG,
          gramsPerPiece: PRODUCTS[INGREDIENTS[id][1]].piece,
          allowHalfPieces: false,
          perPerson: null,
        })),
        split: { kind: "percent", evenSplit: true, shares: [] },
      },
    ],
    batch,
  };
}

function solution(meals: DaySolutionMeal[]): DaySolution {
  return {
    version: 1,
    people: [],
    meals,
    maxDeviationPct: 5,
    requiredTier: 10,
    explanation: null,
    boundsViolated: false,
  };
}

function build(overrides: Partial<ShoppingListInput> & Pick<ShoppingListInput, "plan">) {
  return buildShoppingList({
    currentSolutions: {},
    recipes: RECIPES,
    ingredientProducts: INGREDIENT_PRODUCTS,
    checkedProductIds: new Set(),
    ...overrides,
  });
}

function amounts(list: ReturnType<typeof buildShoppingList>): Record<string, number> {
  return Object.fromEntries(list.aisles.flatMap((a) => a.items).map((item) => [item.productId, item.amountG]));
}

const CURRY_EXACT = { "curry-rice": 260, "curry-chicken": 520, "curry-onion": 130, "curry-salt": 5 };

describe("buildShoppingList", () => {
  it("sums base batches of an unsolved plan, combining a product two recipes share", () => {
    const list = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry"), meal("m2", "d2", 0, "dinner", "leczo")]),
    });
    expect(amounts(list)).toEqual({
      "p-rice": 200,
      "p-chicken": 400,
      "p-onion": 100,
      "p-salt": 7.1,
      "p-sausage": 300,
      "p-zucchini": 250,
    });
    expect(list.itemCount).toBe(6);
    expect(list.daySources).toEqual({ 0: "estimate", 1: "empty", 2: "empty" });
  });

  it("counts an unsolved dish eaten at two meals of one day once", () => {
    const list = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry"), meal("m2", "d1", 0, "dinner", "curry")]),
    });
    expect(amounts(list)["p-rice"]).toBe(200);
  });

  it("counts a batch shared across two current days once, at the stored amount", () => {
    const batch: DaySolutionBatch = { dishId: "d1", cookDayIndex: 0, mealIds: ["m1", "m2"] };
    const list = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry"), meal("m2", "d1", 1, "lunch", "curry")]),
      currentSolutions: {
        0: solution([storedMeal("m1", "curry", CURRY_EXACT, batch)]),
        1: solution([storedMeal("m2", "curry", CURRY_EXACT, batch)]),
      },
    });
    expect(amounts(list)).toEqual({ "p-rice": 260, "p-chicken": 520, "p-onion": 130, "p-salt": 5 });
    expect(list.daySources).toEqual({ 0: "exact", 1: "exact", 2: "empty" });
    expect(list.diagnostics.dishesFellBack).toEqual([]);
  });

  it("counts a batch eaten at lunch and dinner of one current day once", () => {
    const batch: DaySolutionBatch = { dishId: "d1", cookDayIndex: 0, mealIds: ["m1", "m2"] };
    const list = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry"), meal("m2", "d1", 0, "dinner", "curry")]),
      currentSolutions: {
        0: solution([storedMeal("m1", "curry", CURRY_EXACT, batch), storedMeal("m2", "curry", CURRY_EXACT, batch)]),
      },
    });
    expect(amounts(list)["p-chicken"]).toBe(520);
  });

  it("mixes exact amounts of a current day with base amounts of an unsolved one", () => {
    const list = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry"), meal("m2", "d2", 1, "lunch", "leczo")]),
      currentSolutions: { 0: solution([storedMeal("m1", "curry", CURRY_EXACT)]) },
    });
    expect(amounts(list)).toEqual({
      "p-rice": 260,
      "p-chicken": 520,
      "p-onion": 130,
      "p-salt": 8,
      "p-sausage": 300,
      "p-zucchini": 250,
    });
    expect(list.daySources).toEqual({ 0: "exact", 1: "estimate", 2: "empty" });
  });

  it("totals pieces and strips float noise", () => {
    const list = build({
      plan: plan([meal("m1", "d1", 0, "breakfast", "eggs-a"), meal("m2", "d2", 1, "breakfast", "eggs-b")]),
    });
    const egg = list.aisles.flatMap((a) => a.items).find((item) => item.productId === "p-egg");
    expect(egg?.amountG).toBe(50);
    expect(egg && formatShoppingAmount(egg)).toBe("1 pc (50 g)");

    const noisy = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry"), meal("m2", "d2", 1, "lunch", "curry")]),
      currentSolutions: {
        0: solution([storedMeal("m1", "curry", { "curry-salt": 0.1 })]),
        1: solution([storedMeal("m2", "curry", { "curry-salt": 0.2 })]),
      },
    });
    expect(amounts(noisy)["p-salt"]).toBe(0.3);
  });

  it("orders aisles by enum and items by Polish collation, deterministically", () => {
    const input = {
      plan: plan([
        meal("m1", "d1", 0, "lunch", "greens"),
        meal("m2", "d2", 0, "dinner", "curry"),
        meal("m3", "d3", 1, "breakfast", "eggs-a"),
      ]),
    };
    const list = build(input);
    expect(list.aisles.map((a) => a.aisle)).toEqual(["produce", "dairy", "meat_fish", "dry_goods", "spices"]);
    // "Ł" sorts after "L" in Polish, not after "Z" as a code-point sort would put it.
    expect(list.aisles[0].items.map((item) => item.productName)).toEqual(["Cebula", "Limonka", "Łodyga selera", "Por"]);
    expect(build(input)).toEqual(list);
  });

  it("overlays checks and ignores a check of a product that is not on the list", () => {
    const list = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry")]),
      checkedProductIds: new Set(["p-salt", "p-sausage"]),
    });
    const checked = list.aisles.flatMap((a) => a.items).filter((item) => item.checked);
    expect(checked.map((item) => item.productId)).toEqual(["p-salt"]);
    expect(list.checkedCount).toBe(1);
    expect(formatShoppingSummary(list)).toBe("Shopping list: 4 items · 1 checked");
  });

  it("reports a missing recipe and an unmatched ingredient without throwing", () => {
    const withoutOnion = Object.fromEntries(Object.entries(INGREDIENT_PRODUCTS).filter(([id]) => id !== "curry-onion"));
    const list = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry"), meal("m2", "d2", 0, "dinner", "gone")]),
      ingredientProducts: withoutOnion,
    });
    expect(list.diagnostics.missingRecipeIds).toEqual(["gone"]);
    expect(list.diagnostics.unmatchedIngredientIds).toEqual(["curry-onion"]);
    expect(amounts(list)).toEqual({ "p-rice": 200, "p-chicken": 400, "p-salt": 4.1 });
  });

  it("falls back to the base batch when a current solution lacks the dish", () => {
    const list = build({
      plan: plan([meal("m1", "d1", 0, "lunch", "curry"), meal("m2", "d2", 0, "dinner", "leczo")]),
      currentSolutions: { 0: solution([storedMeal("m1", "curry", CURRY_EXACT)]) },
    });
    expect(list.diagnostics.dishesFellBack).toEqual(["d2"]);
    expect(amounts(list)["p-sausage"]).toBe(300);
    expect(amounts(list)["p-salt"]).toBe(8);
  });
});

describe("shopping display text", () => {
  it("formats the summary and the source notes", () => {
    expect(formatShoppingSummary({ itemCount: 0, checkedCount: 0 })).toBe("Shopping list: no items yet");
    expect(formatExactNote(["Monday", "Tuesday"])).toBe("Exact amounts from the day solve of Monday and Tuesday.");
    expect(formatEstimateNote(["Wednesday"])).toBe(
      "Wednesday: recipe base amounts (estimate) — solve to get exact amounts.",
    );
    expect(formatShoppingAmount({ amountG: 75, gramsPerPiece: 50 })).toBe("1½ pcs (75 g)");
  });
});
