import type { SupabaseClient } from "@supabase/supabase-js";
import type { MealType, RecipeLibrarySummary, RecipeListItem } from "@/types";

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

// Recipe list for the plan picker (S-03). Deliberately minimal and unfiltered: browsing, filters
// and sorting are S-05/S-06, which extend this reader.
interface RecipeListRow {
  id: string;
  name: string;
  cuisine: string;
  prep_minutes: number;
  meal_types: MealType[];
}

export async function listRecipes(supabase: SupabaseClient): Promise<RecipeListItem[]> {
  const { data, error } = await supabase
    .from("recipes")
    .select("id, name, cuisine, prep_minutes, meal_types")
    .order("name");

  if (error) {
    throw error;
  }

  return (data as RecipeListRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    cuisine: row.cuisine,
    prepMinutes: row.prep_minutes,
    mealTypes: row.meal_types,
  }));
}
