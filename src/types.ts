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

export interface MealPlan {
  id: string;
  startDate: string;
  updatedAt: string;
  meals: PlanMeal[];
}
