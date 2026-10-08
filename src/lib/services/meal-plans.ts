import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { MealPlan, MealType, PlanDayIndex, PlanMeal } from "@/types";

// Household meal plans (S-03). RLS scopes reads to the caller's household, so no explicit household
// filter is needed. Writes are revoked from `authenticated`: every save goes through the
// security-definer RPC in 20261008170000_meal_plans.sql.

// Grid rows in `public.meal_type` enum order (FR-013).
export const MEAL_TYPES: readonly MealType[] = ["breakfast", "second_breakfast", "lunch", "afternoon_snack", "dinner"];

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  second_breakfast: "Second breakfast",
  lunch: "Lunch",
  afternoon_snack: "Afternoon snack",
  dinner: "Dinner",
};

export const PLAN_DAYS: readonly PlanDayIndex[] = [0, 1, 2];

export const PLAN_SLOT_COUNT = PLAN_DAYS.length * MEAL_TYPES.length;

// A real calendar date in YYYY-MM-DD form (rejects 2030-02-30, which Date.UTC would roll over).
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Pure UTC arithmetic on a YYYY-MM-DD string, so no time zone can shift the day.
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}

// Tomorrow in the household's locale (Europe/Warsaw), the default start for a first plan.
export function defaultPlanStart(now: Date = new Date()): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return addDays(today, 1);
}

// The smoke test matches these exact strings (dashboard `plan`, /plan `plan-summary`).
export function formatPlanSummary(plan: MealPlan | null): string {
  return plan ? `Plan: from ${plan.startDate} · ${plan.meals.length} of ${PLAN_SLOT_COUNT} meals` : "Plan: none yet";
}

export const PLAN_UNAVAILABLE = "Plan is unavailable right now.";

// Rejection SQLSTATEs raised by save_meal_plan. KD007 is shared with S-01 but gets plan wording here.
const PLAN_ERRORS: Record<string, string> = {
  KD007: "You need to be signed in to save a plan.",
  KD010: "That plan could not be read. Please try again.",
  KD011: "One of the chosen recipes no longer exists.",
  KD012: "A meal is marked for someone who isn't in your household.",
};

export const PLAN_SAVE_FAILED = "Your plan could not be saved. Please try again.";

// PostgREST surfaces the SQLSTATE as the error's `code` field (see invites.ts).
function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const { code } = error;
  return typeof code === "string" ? code : null;
}

export function mealPlanErrorMessage(error: unknown): string {
  const code = errorCode(error);
  return (code !== null ? PLAN_ERRORS[code] : undefined) ?? PLAN_SAVE_FAILED;
}

interface MealPlanRow {
  id: string;
  start_date: string;
  updated_at: string;
  plan_meals: {
    day_index: PlanDayIndex;
    meal_type: MealType;
    eater_user_id: string | null;
    plan_dishes: { recipe_id: string } | null;
  }[];
}

// With startDate: that plan. Without: the most recently SAVED plan (updated_at, bumped by every
// save), so a stray mistyped date stops being the default as soon as the intended plan is saved.
// The embeds name their FKs because plan_meals references both meal_plans and plan_dishes.
export async function getMealPlan(supabase: SupabaseClient, startDate?: string): Promise<MealPlan | null> {
  const select =
    "id, start_date, updated_at, plan_meals!plan_meals_plan_fkey(day_index, meal_type, eater_user_id, plan_dishes!plan_meals_dish_fkey(recipe_id))";
  const query = supabase.from("meal_plans").select(select);
  const { data, error } = await (startDate
    ? query.eq("start_date", startDate).maybeSingle()
    : query.order("updated_at", { ascending: false }).limit(1).maybeSingle());

  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }

  // Without a generated Database type the client guesses every embed is an array; plan_dishes is
  // many-to-one (plan_meals.dish_id), which PostgREST returns as a single object.
  const row = data as unknown as MealPlanRow;
  return {
    id: row.id,
    startDate: row.start_date,
    updatedAt: row.updated_at,
    meals: row.plan_meals.flatMap((meal) =>
      meal.plan_dishes
        ? [
            {
              dayIndex: meal.day_index,
              mealType: meal.meal_type,
              recipeId: meal.plan_dishes.recipe_id,
              eaterUserId: meal.eater_user_id,
            },
          ]
        : [],
    ),
  };
}

// There is no generated `Database` type, so `rpc()` resolves to `any`; cast at the boundary.
interface RpcResult<T> {
  data: T | null;
  error: PostgrestError | null;
}

// Returns the saved plan's id.
export async function saveMealPlan(supabase: SupabaseClient, startDate: string, meals: PlanMeal[]): Promise<string> {
  const { data, error } = (await supabase.rpc("save_meal_plan", {
    p_start_date: startDate,
    p_meals: meals.map((meal) => ({
      day_index: meal.dayIndex,
      meal_type: meal.mealType,
      recipe_id: meal.recipeId,
      eater_user_id: meal.eaterUserId,
    })),
  })) as RpcResult<string>;

  if (error) {
    throw error;
  }
  if (data === null) {
    throw new Error("save_meal_plan returned no plan id");
  }
  return data;
}
