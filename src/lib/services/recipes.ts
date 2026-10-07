import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecipeLibrarySummary } from "@/types";

// RLS scopes `recipes` and `products` to the caller's household, so no explicit household filter is needed.
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
