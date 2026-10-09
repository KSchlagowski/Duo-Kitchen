export interface HouseholdMember {
  userId: string;
  joinedAt: string;
}

export interface Household {
  id: string;
  createdAt: string;
  members: HouseholdMember[];
}

// The inviter's own live invite code (S-01). The redeemed/provenance columns are never surfaced to
// the UI in this slice, so they are deliberately absent.
export interface HouseholdInvite {
  id: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

// Language-neutral keys matching the Postgres enums (labels are mapped in the UI).
export type StoreAisle = "produce" | "dairy" | "meat_fish" | "bakery" | "dry_goods" | "spices" | "frozen" | "other";
export type MealType = "breakfast" | "second_breakfast" | "lunch" | "afternoon_snack" | "dinner";
export type DivisionMode = "per_component" | "whole_dish";
export type StepTiming = "make_ahead" | "fresh";

export interface RecipeLibrarySummary {
  recipeCount: number;
  productCount: number;
}

// --- S-05: browsing the public recipe library ------------------------------------------------
// Computed nutrition for an amount of food. Same shape as MacroTargetsInput, different meaning:
// an amount eaten, not a goal.
export interface MacroTotals {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
}

// One card in the library grid. No rating fields: ratings belong to S-06. `photoUrl` is always null
// until a slice that can supply photos adds the column.
export interface RecipeCard {
  id: string;
  name: string;
  cuisine: string;
  prepMinutes: number;
  mealTypes: MealType[];
  divisionMode: DivisionMode;
  photoUrl: string | null;
}

export interface RecipeDetailIngredient {
  id: string;
  position: number;
  productName: string;
  amountG: number;
  // The ingredient's own rounding step, falling back to the product's.
  effectiveRoundingStepG: number;
  minAmountG: number | null;
  gramsPerPiece: number | null;
  allowHalfPieces: boolean;
  macros: MacroTotals;
}

export interface RecipeDetailComponent {
  id: string;
  position: number;
  name: string;
  cookedYieldRatio: number | null;
  ingredients: RecipeDetailIngredient[];
  totals: MacroTotals;
  rawWeightG: number;
  cookedWeightG: number | null;
}

export interface RecipeDetailStep {
  id: string;
  position: number;
  instruction: string;
  timing: StepTiming;
  componentName: string | null;
  durationMinutes: number | null;
}

// Totals are for one whole base batch; splitting per person is S-04's job.
export interface RecipeDetail extends RecipeCard {
  components: RecipeDetailComponent[];
  steps: RecipeDetailStep[];
  totals: MacroTotals;
}
// --- end S-05 -------------------------------------------------------------------------------

// One person's daily targets (S-02). Keyed on the person, not the household: the row follows its
// owner through a redemption and stays readable by the partner.
export interface MacroTargets {
  userId: string;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbsG: number;
  updatedAt: string;
}

export type MacroTargetsInput = Omit<MacroTargets, "userId" | "updatedAt">;

// Recipe picker and meal plan (S-03)

// Form-level eater choice; stored as a user id, or null for "both".
export type PlanEater = "both" | "me" | "partner";

export type PlanDayIndex = 0 | 1 | 2;

// One filled slot. Empty slots are absent.
export interface PlanMeal {
  dayIndex: PlanDayIndex;
  mealType: MealType;
  recipeId: string;
  eaterUserId: string | null;
}

// A stored meal, with the id S-04 fingerprints (save_meal_plan keeps it across eater-only edits).
export interface PlanMealRecord extends PlanMeal {
  mealId: string;
}

export interface MealPlan {
  id: string;
  startDate: string;
  updatedAt: string;
  meals: PlanMealRecord[];
}

// --- S-04: solving a day's macros -----------------------------------------------------------
// Solver inputs: the library rows a day uses, flattened to what the LP and the rounding need.
export interface SolverIngredient {
  id: string;
  position: number;
  productName: string;
  baseAmountG: number;
  effectiveRoundingStepG: number;
  minAmountG: number | null;
  gramsPerPiece: number | null;
  allowHalfPieces: boolean;
  kcalPer100g: number;
  proteinPer100g: number;
  fatPer100g: number;
  carbsPer100g: number;
}

export interface SolverComponent {
  id: string;
  position: number;
  name: string;
  cookedYieldRatio: number | null;
  ingredients: SolverIngredient[];
}

export interface SolverRecipe {
  id: string;
  name: string;
  divisionMode: DivisionMode;
  components: SolverComponent[];
}

// One day's meals plus everything needed to solve them. `memberIds` resolves "both" (null eater).
export interface SolveDayInput {
  memberIds: string[];
  meals: PlanMealRecord[];
  recipes: Record<string, SolverRecipe>;
  targets: Record<string, MacroTargetsInput>;
}

export type MacroKey = keyof MacroTotals;
export type SolveTier = 10 | 15 | 20;
export type DaySolveStatus = "solved" | "needs_confirmation" | "no_fit";

export type UnsolvableReasonCode = "no_meals" | "missing_targets" | "empty_recipe" | "eater_not_member";

export interface UnsolvableReason {
  reason: UnsolvableReasonCode;
  userIds?: string[];
  recipeName?: string;
}

// How one component is shared between its eaters. `value` is per kind: cooked grams, a whole
// percentage, a piece count, or null ("per_ingredient" reads each ingredient's perPerson; "all" is
// a single eater). `fraction` is the share the totals were computed from.
export type DaySplitKind = "grams_cooked" | "percent" | "pieces" | "per_ingredient" | "all";

export interface DaySplitShare {
  userId: string;
  value: number | null;
  fraction: number;
}

export interface DaySplit {
  kind: DaySplitKind;
  evenSplit: boolean;
  shares: DaySplitShare[];
}

export interface DaySolutionIngredient {
  id: string;
  productName: string;
  // The batch cook amount (for a per-person component, the sum of its perPerson amounts).
  amountG: number;
  gramsPerPiece: number | null;
  allowHalfPieces: boolean;
  perPerson: Record<string, number> | null;
}

export interface DaySolutionComponent {
  id: string;
  name: string;
  cookedYieldRatio: number | null;
  ingredients: DaySolutionIngredient[];
  split: DaySplit;
}

export interface DaySolutionMeal {
  mealId: string;
  mealType: MealType;
  recipeId: string;
  recipeName: string;
  divisionMode: DivisionMode;
  eaterUserIds: string[];
  components: DaySolutionComponent[];
}

export interface DaySolutionPerson {
  userId: string;
  targets: MacroTargetsInput;
  totals: MacroTotals;
  // Signed fractions: (total − target) / target, or / 50 g for a zero target.
  deviations: MacroTotals;
}

export type DaySolveExplanation =
  | { kind: "recipe"; mealId: string; recipeName: string; macro: MacroKey; direction: "over" | "under" }
  | { kind: "targets"; userId: string };

// Also the persisted jsonb shape (S-04 phase 2).
export interface DaySolution {
  version: 1;
  people: DaySolutionPerson[];
  meals: DaySolutionMeal[];
  maxDeviationPct: number;
  requiredTier: SolveTier | null;
  explanation: DaySolveExplanation | null;
}

export type SolveDayResult = { kind: "solution"; solution: DaySolution } | ({ kind: "unsolvable" } & UnsolvableReason);

// One row of public.plan_day_solutions, as the app reads it.
export interface StoredDaySolution {
  status: DaySolveStatus;
  acceptedTolerancePct: SolveTier;
  inputFingerprint: string;
  solution: DaySolution;
  solvedAt: string;
}

// The day page's model: the current inputs (or why they cannot be solved), the stored result, and
// whether that result is out of date. `stale` is true when the stored fingerprint differs from the
// current one, or when a stored result exists but the current inputs are unsolvable.
export interface DayView {
  plan: MealPlan;
  input: SolveDayInput;
  unsolvable: UnsolvableReason | null;
  fingerprint: string;
  stored: StoredDaySolution | null;
  stale: boolean;
}
// --- end S-04 -------------------------------------------------------------------------------
