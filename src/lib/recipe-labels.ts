import type {
  DivisionMode,
  MacroKey,
  MealType,
  SessionPart,
  SessionSectionKind,
  StepTiming,
  StoreAisle,
} from "@/types";

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

// --- S-04: solving a day's macros ---

// The short macro prefix of a totals line ("P 158 g").
export const MACRO_SHORT_LABELS: Record<MacroKey, string> = {
  kcal: "kcal",
  proteinG: "P",
  fatG: "F",
  carbsG: "C",
};

// The reason a recipe hinders a fit ("too much fat").
export const MACRO_DIRECTION_LABELS: Record<MacroKey, Record<"over" | "under", string>> = {
  kcal: { over: "too many calories", under: "too few calories" },
  proteinG: { over: "too much protein", under: "too little protein" },
  fatG: { over: "too much fat", under: "too little fat" },
  carbsG: { over: "too many carbs", under: "too few carbs" },
};

export const EATER_LABELS = { you: "You", partner: "Partner", both: "Both" } as const;

export const SPLIT_LABELS = {
  cooked: "cooked",
  ofTheDish: "of the dish",
  // A per-ingredient serving eaten at another meal of a shared batch (S-08).
  ofTheBatch: "of the batch",
  splitInHalf: "split in half",
  // An even split of a batch with more than two servings (S-08: one batch eaten on several days).
  splitEvenly: (count: number) => `split evenly ${count} ways`,
  allForYou: "All for you",
  allForPartner: "All for your partner",
} as const;

// --- S-09: shopping list ---

export const AISLE_LABELS: Record<StoreAisle, string> = {
  produce: "Produce",
  dairy: "Dairy",
  meat_fish: "Meat & fish",
  bakery: "Bakery",
  dry_goods: "Dry goods",
  spices: "Spices",
  frozen: "Frozen",
  other: "Other",
};

// --- S-10: cooking sessions ---

export const SESSION_PART_LABELS: Record<SessionPart, string> = {
  morning: "morning",
  evening: "evening",
};

// The `now` heading is rendered in evenings only; a morning has a single unlabelled section.
export const SESSION_SECTION_LABELS: Record<SessionSectionKind, string> = {
  now: "Tonight",
  ahead: "For tomorrow",
};

// --- S-11: cook mode ---

export const COOK_MODE_LABELS = {
  cookLink: "Cook step by step",
  previous: "Previous",
  next: "Next",
  doneNext: "Done — next step",
  finish: "Back to sessions",
  allSteps: "All steps",
  overview: "Ingredients and portions",
  amounts: "You need",
  portions: "Portions",
  batchEstimate: "(recipe base amounts — estimate)",
  keepScreenOn: "Keep screen on",
} as const;

// The smoke test matches this exact string.
export function formatMealTypes(types: MealType[]): string {
  return types.length === 0 ? "No suggested meal type" : types.map((t) => MEAL_TYPE_LABELS[t]).join(" · ");
}
