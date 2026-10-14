import type { SupabaseClient } from "@supabase/supabase-js";
import type { CookingSchedule, MealPlan } from "@/types";
import { buildCookingSessions } from "@/lib/services/cooking-sessions";
import { getMealPlan } from "@/lib/services/meal-plans";
import { getRecipeSteps } from "@/lib/services/recipes";

// The cooking sessions' I/O (S-10): the reads feeding the pure builder (cooking-sessions.ts). The
// schedule is derived on every read and never stored, and it needs no solve: it shows steps only.

// The schedule of the plan starting `startDate` (or of the most recently saved plan), with the plan,
// or null when there is no such plan. A failed read throws: it must never degrade into "no plan".
export async function getCookingSchedule(
  supabase: SupabaseClient,
  startDate?: string,
): Promise<{ plan: MealPlan; schedule: CookingSchedule } | null> {
  const plan = await getMealPlan(supabase, startDate);
  if (!plan) {
    return null;
  }
  const recipeSteps = await getRecipeSteps(
    supabase,
    plan.meals.map((meal) => meal.recipeId),
  );

  const schedule = buildCookingSessions({ plan, recipeSteps });
  const { missingRecipeIds, recipesWithoutSteps, makeAheadDemoted } = schedule.diagnostics;
  if (missingRecipeIds.length > 0 || recipesWithoutSteps.length > 0 || makeAheadDemoted.length > 0) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("buildCookingSessions worked around inconsistent inputs", plan.id, schedule.diagnostics);
  }
  return { plan, schedule };
}
