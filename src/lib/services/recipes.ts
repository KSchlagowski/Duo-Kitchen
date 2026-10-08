import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecipeLibrarySummary } from "@/types";

// The library is public to every signed-in user (F-04): RLS lets any authenticated caller read every
// `recipes` and `products` row, so these counts are global, not per household.
export async function getRecipeLibrarySummary(supabase: SupabaseClient): Promise<RecipeLibrarySummary> {
  const [recipes, products] = await Promise.all([
    supabase.from("recipes").select("*", { count: "exact", head: true }),
    supabase.from("products").select("*", { count: "exact", head: true }),
  ]);

  if (recipes.error) {
    throw recipes.error;
  }
  if (products.error) {
    throw products.error;
  }

  return {
    recipeCount: recipes.count ?? 0,
    productCount: products.count ?? 0,
  };
}
