import type { SupabaseClient } from "@supabase/supabase-js";
import type { MealPlan, PlanDayIndex, PlanDaySolveStatus, ShoppingList } from "@/types";
import { getPlanSolveState } from "@/lib/services/day-solutions";
import { errorCode, getMealPlan, type RpcResult } from "@/lib/services/meal-plans";
import { getIngredientProducts } from "@/lib/services/recipes";
import { SHOPPING_ERRORS, SHOPPING_SAVE_FAILED, buildShoppingList } from "@/lib/services/shopping-list";

// The shopping list's I/O (S-09): the reads feeding the pure builder (shopping-list.ts) and the one
// write path. The list is derived on every read; only the checks are stored, and clients write them
// through set_shopping_item_checked alone (shopping_list_checks is write-revoked).

// The list of the plan starting `startDate` (or of the most recently saved plan), with the plan and
// its per-day solve statuses, or null when there is no such plan. A failed read throws: it must never
// degrade into "no plan" or an empty list.
export async function getShoppingList(
  supabase: SupabaseClient,
  startDate?: string,
): Promise<{ plan: MealPlan; list: ShoppingList; statuses: Record<PlanDayIndex, PlanDaySolveStatus> } | null> {
  const plan = await getMealPlan(supabase, startDate);
  if (!plan) {
    return null;
  }
  // getPlanSolveState() is the single currency rule shared with /plan, so the two never disagree
  // about which days are exact.
  const [state, ingredientProducts, checks] = await Promise.all([
    getPlanSolveState(supabase, plan),
    getIngredientProducts(
      supabase,
      plan.meals.map((meal) => meal.recipeId),
    ),
    supabase.from("shopping_list_checks").select("product_id").eq("plan_id", plan.id),
  ]);
  if (checks.error) {
    throw checks.error;
  }

  const list = buildShoppingList({
    plan,
    currentSolutions: state.currentSolutions,
    recipes: state.recipes,
    ingredientProducts,
    checkedProductIds: new Set((checks.data as { product_id: string }[]).map((row) => row.product_id)),
  });
  const { missingRecipeIds, unmatchedIngredientIds, dishesFellBack } = list.diagnostics;
  if (missingRecipeIds.length > 0 || unmatchedIngredientIds.length > 0 || dishesFellBack.length > 0) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("buildShoppingList worked around inconsistent inputs", plan.id, list.diagnostics);
  }
  return { plan, list, statuses: state.statuses };
}

// Checks (or unchecks) one product on the plan starting `startDate`. The household is resolved
// server-side; a check of a product the plan does not use is rejected (KD019), an uncheck never is.
export async function setShoppingItemChecked(
  supabase: SupabaseClient,
  startDate: string,
  productId: string,
  checked: boolean,
): Promise<void> {
  const { error } = (await supabase.rpc("set_shopping_item_checked", {
    p_start_date: startDate,
    p_product_id: productId,
    p_checked: checked,
  })) as RpcResult<null>;

  if (error) {
    throw error;
  }
}

export function shoppingErrorMessage(error: unknown): string {
  const code = errorCode(error);
  return code !== null && code in SHOPPING_ERRORS
    ? SHOPPING_ERRORS[code as keyof typeof SHOPPING_ERRORS]
    : SHOPPING_SAVE_FAILED;
}
