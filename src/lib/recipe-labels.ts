import type { DivisionMode, MealType, StepTiming } from "@/types";

// The single place enum keys become display labels, so localisation (S-14) swaps one file.

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  second_breakfast: "Second breakfast",
  lunch: "Lunch",
  afternoon_snack: "Afternoon snack",
  dinner: "Dinner",
};

export const DIVISION_MODE_LABELS: Record<DivisionMode, string> = {
  per_component: "Divisible components",
  whole_dish: "Whole dish only",
};

export const STEP_TIMING_LABELS: Record<StepTiming, string> = {
  make_ahead: "Make ahead",
  fresh: "Fresh",
};

// The smoke test matches this exact string.
export function formatMealTypes(types: MealType[]): string {
  return types.length === 0 ? "No suggested meal type" : types.map((t) => MEAL_TYPE_LABELS[t]).join(" · ");
}
