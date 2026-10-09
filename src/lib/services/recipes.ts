import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DivisionMode,
  MealType,
  RecipeCard,
  RecipeDetail,
  RecipeDetailComponent,
  RecipeDetailIngredient,
  RecipeLibrarySummary,
  StepTiming,
} from "@/types";
import { cookedWeight, ingredientMacros, sumMacros } from "@/lib/services/recipe-macros";

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

// --- S-05: browsing the library ----------------------------------------------------------------
// getRecipeCards() also feeds S-03's plan picker (it replaced S-03's narrower listRecipes()).

interface RecipeRow {
  id: string;
  name: string;
  cuisine: string;
  prep_minutes: number;
  meal_types: MealType[];
  division_mode: DivisionMode;
}

const RECIPE_COLUMNS = "id, name, cuisine, prep_minutes, meal_types, division_mode";

function toRecipeCard(row: RecipeRow): RecipeCard {
  return {
    id: row.id,
    name: row.name,
    cuisine: row.cuisine,
    prepMinutes: row.prep_minutes,
    mealTypes: row.meal_types,
    divisionMode: row.division_mode,
    // No photo column yet: it lands with the first slice that can supply a photo.
    photoUrl: null,
  };
}

// Sorted in TS with Polish collation: the hosted database's collation is not something to depend on.
export async function getRecipeCards(supabase: SupabaseClient): Promise<RecipeCard[]> {
  const { data, error } = await supabase.from("recipes").select(RECIPE_COLUMNS);

  if (error) {
    throw error;
  }

  return (data as RecipeRow[]).map(toRecipeCard).sort((x, y) => x.name.localeCompare(y.name, "pl"));
}

// numeric columns are read through Number(): PostgREST may hand them over as strings.
interface ProductRow {
  name: string;
  kcal_per_100g: number | string;
  protein_per_100g: number | string;
  fat_per_100g: number | string;
  carbs_per_100g: number | string;
  rounding_step_g: number | string;
  grams_per_piece: number | string | null;
}

interface IngredientRow {
  id: string;
  position: number;
  base_amount_g: number | string;
  rounding_step_g: number | string | null;
  min_amount_g: number | string | null;
  allow_half_pieces: boolean;
  products: ProductRow;
}

interface ComponentRow {
  id: string;
  position: number;
  name: string;
  cooked_yield_ratio: number | string | null;
  recipe_ingredients: IngredientRow[];
}

interface StepRow {
  id: string;
  position: number;
  instruction: string;
  timing: StepTiming;
  component_id: string | null;
  duration_minutes: number | null;
}

function toNumberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function byPosition<T extends { position: number }>(x: T, y: T): number {
  return x.position - y.position;
}

function toIngredient(row: IngredientRow): RecipeDetailIngredient {
  const amountG = Number(row.base_amount_g);
  const product = row.products;
  return {
    id: row.id,
    position: row.position,
    productName: product.name,
    amountG,
    effectiveRoundingStepG: Number(row.rounding_step_g ?? product.rounding_step_g),
    minAmountG: toNumberOrNull(row.min_amount_g),
    gramsPerPiece: toNumberOrNull(product.grams_per_piece),
    allowHalfPieces: row.allow_half_pieces,
    macros: ingredientMacros(amountG, {
      kcalPer100g: Number(product.kcal_per_100g),
      proteinPer100g: Number(product.protein_per_100g),
      fatPer100g: Number(product.fat_per_100g),
      carbsPer100g: Number(product.carbs_per_100g),
    }),
  };
}

function toComponent(row: ComponentRow): RecipeDetailComponent {
  const ingredients = row.recipe_ingredients.map(toIngredient).sort(byPosition);
  const cookedYieldRatio = toNumberOrNull(row.cooked_yield_ratio);
  const rawWeightG = ingredients.reduce((sum, i) => sum + i.amountG, 0);
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    cookedYieldRatio,
    ingredients,
    totals: sumMacros(ingredients.map((i) => i.macros)),
    rawWeightG,
    cookedWeightG: cookedWeight(rawWeightG, cookedYieldRatio),
  };
}

// Three flat queries instead of one nested embed: recipe_steps has FKs to both recipes and
// recipe_components, so embedding components and steps under recipes risks PostgREST's PGRST201
// (ambiguous relationship). The id must already be a valid uuid; validating it is the page's job.
export async function getRecipeDetail(supabase: SupabaseClient, id: string): Promise<RecipeDetail | null> {
  const [recipe, components, steps] = await Promise.all([
    supabase.from("recipes").select(RECIPE_COLUMNS).eq("id", id).maybeSingle(),
    supabase
      .from("recipe_components")
      .select(
        "id, position, name, cooked_yield_ratio, recipe_ingredients(id, position, base_amount_g, rounding_step_g, min_amount_g, allow_half_pieces, products(name, kcal_per_100g, protein_per_100g, fat_per_100g, carbs_per_100g, rounding_step_g, grams_per_piece))",
      )
      .eq("recipe_id", id),
    supabase
      .from("recipe_steps")
      .select("id, position, instruction, timing, component_id, duration_minutes")
      .eq("recipe_id", id),
  ]);

  if (recipe.error) {
    throw recipe.error;
  }
  if (components.error) {
    throw components.error;
  }
  if (steps.error) {
    throw steps.error;
  }
  if (!recipe.data) {
    return null;
  }

  const detailComponents = (components.data as unknown as ComponentRow[]).map(toComponent).sort(byPosition);
  const componentNames = new Map(detailComponents.map((c) => [c.id, c.name]));

  return {
    ...toRecipeCard(recipe.data),
    components: detailComponents,
    steps: (steps.data as StepRow[])
      .map((row) => ({
        id: row.id,
        position: row.position,
        instruction: row.instruction,
        timing: row.timing,
        componentName: row.component_id === null ? null : (componentNames.get(row.component_id) ?? null),
        durationMinutes: row.duration_minutes,
      }))
      .sort(byPosition),
    totals: sumMacros(detailComponents.map((c) => c.totals)),
  };
}
// --- end S-05 -------------------------------------------------------------------------------
