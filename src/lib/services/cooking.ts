import type { SupabaseClient } from "@supabase/supabase-js";
import type { CookingSchedule, CookModeView, MealPlan, RecipeSteps } from "@/types";
import { buildCookMode } from "@/lib/services/cook-mode";
import { buildCookingSessions } from "@/lib/services/cooking-sessions";
import { getPlanSolveState } from "@/lib/services/day-solutions";
import { getMealPlan } from "@/lib/services/meal-plans";
import { getRecipeSteps } from "@/lib/services/recipes";

// The cooking sessions' I/O (S-10) and cook mode's (S-11): the reads feeding the pure builders
// (cooking-sessions.ts, cook-mode.ts). Both are derived on every read and never stored. The schedule
// needs no solve (it shows steps only); cook mode reads the current stored solves for its amounts.

function scheduleOf(plan: MealPlan, recipeSteps: Record<string, RecipeSteps>): CookingSchedule {
  const schedule = buildCookingSessions({ plan, recipeSteps });
  const { missingRecipeIds, recipesWithoutSteps, makeAheadDemoted } = schedule.diagnostics;
  if (missingRecipeIds.length > 0 || recipesWithoutSteps.length > 0 || makeAheadDemoted.length > 0) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("buildCookingSessions worked around inconsistent inputs", plan.id, schedule.diagnostics);
  }
  return schedule;
}

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
  return { plan, schedule: scheduleOf(plan, recipeSteps) };
}

// The cook view of one session (`sessionKey`) of the plan starting `startDate`, seen by `viewerId`.
// Null when there is no such plan; `view: null` when the key is not one of the plan's sessions.
// A failed read throws: it must never degrade into "no plan".
export async function getCookMode(
  supabase: SupabaseClient,
  startDate: string,
  sessionKey: string,
  viewerId: string,
): Promise<{ plan: MealPlan; view: CookModeView | null } | null> {
  const plan = await getMealPlan(supabase, startDate);
  if (!plan) {
    return null;
  }
  // getPlanSolveState() is the single currency rule shared with /plan and the shopping list, so they
  // never disagree about which days are exact.
  const [recipeSteps, state] = await Promise.all([
    getRecipeSteps(
      supabase,
      plan.meals.map((meal) => meal.recipeId),
    ),
    getPlanSolveState(supabase, plan),
  ]);

  const session = scheduleOf(plan, recipeSteps).sessions.find((candidate) => candidate.key === sessionKey);
  if (!session) {
    return { plan, view: null };
  }
  const view = buildCookMode({
    plan,
    session,
    currentSolutions: state.currentSolutions,
    recipes: state.recipes,
    viewerId,
  });
  const { dishesFellBack, missingRecipeIds } = view.diagnostics;
  if (dishesFellBack.length > 0 || missingRecipeIds.length > 0) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("buildCookMode worked around inconsistent inputs", plan.id, view.diagnostics);
  }
  return { plan, view };
}
