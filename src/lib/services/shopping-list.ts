import type {
  DaySolution,
  DaySolutionMeal,
  IngredientProduct,
  MealPlan,
  PlanDayIndex,
  PlanMealRecord,
  ShoppingAisle,
  ShoppingDaySource,
  ShoppingItem,
  ShoppingList,
  SolverRecipe,
  StoreAisle,
} from "@/types";
import { formatIngredientAmount } from "@/lib/services/recipe-macros";
import { joinList } from "@/lib/utils";

// The shopping list of one plan (S-09), as a pure function of stored state: the plan, the current
// stored solves, the library and the household's checks. No I/O, and nothing that pulls in the solver,
// zod or Supabase: the check-off island imports this module in the browser. The reads live in
// shopping.ts.

// FR-021's fixed aisle order, which is also the store_aisle enum order.
export const STORE_AISLES: readonly StoreAisle[] = [
  "produce",
  "dairy",
  "meat_fish",
  "bakery",
  "dry_goods",
  "spices",
  "frozen",
  "other",
];

const DAYS: readonly PlanDayIndex[] = [0, 1, 2];

export interface ShoppingListInput {
  plan: MealPlan;
  // The days of current solve groups only (getPlanSolveState()); every other day is an estimate.
  currentSolutions: Partial<Record<PlanDayIndex, DaySolution>>;
  recipes: Record<string, SolverRecipe>;
  ingredientProducts: Record<string, IngredientProduct>;
  checkedProductIds: ReadonlySet<string>;
}

// The one stored meal each dish of the current days takes its amounts from. Every meal of a shared
// batch carries the FULL batch amounts (on every day of it, and twice on a day it feeds two meals of),
// so the first stored meal seen per dish is used and the rest are ignored — never summed.
function storedMealsByDish(
  plan: MealPlan,
  currentSolutions: Partial<Record<PlanDayIndex, DaySolution>>,
): Map<string, DaySolutionMeal> {
  // A null batch is a dish feeding one meal; in a current group its mealId is the plan's.
  const dishOfMeal = new Map(plan.meals.map((meal) => [meal.mealId, meal.dishId]));
  const byDish = new Map<string, DaySolutionMeal>();
  for (const day of DAYS) {
    for (const meal of currentSolutions[day]?.meals ?? []) {
      const dishId = meal.batch?.dishId ?? dishOfMeal.get(meal.mealId);
      if (dishId !== undefined && !byDish.has(dishId)) {
        byDish.set(dishId, meal);
      }
    }
  }
  return byDish;
}

export function buildShoppingList(input: ShoppingListInput): ShoppingList {
  const { plan, currentSolutions, recipes, ingredientProducts, checkedProductIds } = input;

  // The dish is the shopping unit: each is cooked once, whatever its meals or eaters.
  const dishes = new Map<string, PlanMealRecord[]>();
  for (const meal of plan.meals) {
    dishes.set(meal.dishId, [...(dishes.get(meal.dishId) ?? []), meal]);
  }
  const stored = storedMealsByDish(plan, currentSolutions);

  const missingRecipeIds = new Set<string>();
  const unmatchedIngredientIds = new Set<string>();
  const dishesFellBack: string[] = [];
  const totals = new Map<string, { product: IngredientProduct; grams: number }>();

  for (const [dishId, meals] of dishes) {
    // Solve groups never split a dish, so its first meal's day speaks for all of them.
    const exact = currentSolutions[meals[0].dayIndex] !== undefined;
    const storedMeal = exact ? stored.get(dishId) : undefined;
    let ingredients: { id: string; amountG: number }[];
    if (storedMeal) {
      ingredients = storedMeal.components.flatMap((component) => component.ingredients);
    } else {
      if (exact) {
        dishesFellBack.push(dishId);
      }
      // Not current (or a current solution unexpectedly without the dish): one base batch per dish.
      const recipe = recipes[meals[0].recipeId] as SolverRecipe | undefined;
      if (!recipe) {
        missingRecipeIds.add(meals[0].recipeId);
        continue;
      }
      ingredients = recipe.components.flatMap((component) =>
        component.ingredients.map((ingredient) => ({ id: ingredient.id, amountG: ingredient.baseAmountG })),
      );
    }

    for (const ingredient of ingredients) {
      const product = ingredientProducts[ingredient.id] as IngredientProduct | undefined;
      if (!product) {
        unmatchedIngredientIds.add(ingredient.id);
        continue;
      }
      const entry = totals.get(product.productId);
      if (entry) {
        entry.grams += ingredient.amountG;
      } else {
        totals.set(product.productId, { product, grams: ingredient.amountG });
      }
    }
  }

  const items: ShoppingItem[] = [...totals.values()].map(({ product, grams }) => ({
    productId: product.productId,
    productName: product.productName,
    aisle: product.aisle,
    // Sums of numeric(7,1) values pick up float noise (0.30000000000000004).
    amountG: Number(grams.toFixed(1)),
    gramsPerPiece: product.gramsPerPiece,
    checked: checkedProductIds.has(product.productId),
  }));

  // Aisles in enum order, empty ones omitted. Checked items stay in place so nothing jumps while shopping.
  const aisles: ShoppingAisle[] = STORE_AISLES.map((aisle) => ({
    aisle,
    items: items
      .filter((item) => item.aisle === aisle)
      .sort(
        (a, b) =>
          a.productName.localeCompare(b.productName, "pl") ||
          (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
      ),
  })).filter((aisle) => aisle.items.length > 0);

  const daySources = {} as Record<PlanDayIndex, ShoppingDaySource>;
  for (const day of DAYS) {
    daySources[day] = !plan.meals.some((meal) => meal.dayIndex === day)
      ? "empty"
      : currentSolutions[day] !== undefined
        ? "exact"
        : "estimate";
  }

  return {
    planId: plan.id,
    startDate: plan.startDate,
    aisles,
    daySources,
    itemCount: items.length,
    checkedCount: items.filter((item) => item.checked).length,
    diagnostics: {
      missingRecipeIds: [...missingRecipeIds],
      unmatchedIngredientIds: [...unmatchedIngredientIds],
      dishesFellBack,
    },
  };
}

// --- display text --------------------------------------------------------------------------------

export const SHOPPING_UNAVAILABLE = "Shopping list is unavailable right now.";
export const SHOPPING_NO_PLAN = "No plan yet — start one to get a shopping list.";
export const SHOPPING_NO_PLAN_FOR_DATE = "No plan for that date.";
export const SHOPPING_SAVE_FAILED = "That item could not be updated right now. Please try again.";

// Rejection SQLSTATEs raised by set_shopping_item_checked. KD007 and KD014 are shared with earlier
// slices but get shopping wording.
export const SHOPPING_ERRORS = {
  KD007: "You need to be signed in to check off items.",
  KD014: "Save the plan before shopping for it.",
  KD018: "That item could not be updated. Please try again.",
  KD019: "That product is not on this plan's shopping list.",
} as const;

// The smoke test matches these exact strings.
export function formatShoppingSummary(list: Pick<ShoppingList, "itemCount" | "checkedCount">): string {
  if (list.itemCount === 0) {
    return "Shopping list: no items yet";
  }
  return `Shopping list: ${list.itemCount} ${list.itemCount === 1 ? "item" : "items"} · ${list.checkedCount} checked`;
}

export function formatExactNote(weekdays: readonly string[]): string {
  return `Exact amounts from the day solve of ${joinList(weekdays)}.`;
}

export function formatEstimateNote(weekdays: readonly string[]): string {
  return `${joinList(weekdays)}: recipe base amounts (estimate) — solve to get exact amounts.`;
}

// A summed total is always a whole or half piece multiple (every ingredient amount is), so half pieces
// are allowed here whatever the single ingredients allowed; any other count falls back to grams.
export function formatShoppingAmount(item: Pick<ShoppingItem, "amountG" | "gramsPerPiece">): string {
  return formatIngredientAmount(item.amountG, item.gramsPerPiece, true);
}
