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
  // The library component id (S-11 ties a step to its component's stored amounts by it).
  componentId: string | null;
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

// A slot the form saves, plus the slot it shares a batch with (S-08). Write-side only: a read
// carries the shared batch as PlanMealRecord.dishId instead.
export type PlanMealInput = PlanMeal & { shareWith: { dayIndex: PlanDayIndex; mealType: MealType } | null };

// A stored meal, with the id S-04 fingerprints (save_meal_plan keeps it across eater-only edits) and
// the plan_dishes row it eats from (S-08: several meals, possibly on several days, may share one).
export interface PlanMealRecord extends PlanMeal {
  mealId: string;
  dishId: string;
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

// One solve group's meals (one day, or the days a shared dish joins — S-08) plus everything needed
// to solve them. `memberIds` resolves "both" (null eater).
export interface SolveDayInput {
  memberIds: string[];
  meals: PlanMealRecord[];
  recipes: Record<string, SolverRecipe>;
  targets: Record<string, MacroTargetsInput>;
}

export type MacroKey = keyof MacroTotals;
export type SolveTier = 10 | 15 | 20;
export type DaySolveStatus = "solved" | "needs_confirmation" | "no_fit";

export type UnsolvableReasonCode =
  "no_meals" | "missing_targets" | "empty_recipe" | "invalid_recipe" | "eater_not_member";

export interface UnsolvableReason {
  reason: UnsolvableReasonCode;
  userIds?: string[];
  recipeName?: string;
}

// How one component is shared between its eaters. `value` is per kind: cooked grams, a whole
// percentage, a piece count, or null ("per_ingredient" reads each ingredient's perPerson; "all" is
// a single eater). `fraction` is the share the totals were computed from. One share per serving —
// a (meal, eater) pair — so a batch eaten on two days by two people has four (S-08).
export type DaySplitKind = "grams_cooked" | "percent" | "pieces" | "per_ingredient" | "all";

export interface DaySplitShare {
  userId: string;
  // The meal and day this serving is eaten at; null only in rows stored before S-08.
  mealId: string | null;
  dayIndex: PlanDayIndex | null;
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
  // Per-person components only: the grams each eater of THIS meal gets, keyed by user id. A shared
  // batch's other meals carry their own eaters' amounts in their own rows.
  perPerson: Record<string, number> | null;
}

export interface DaySolutionComponent {
  id: string;
  name: string;
  cookedYieldRatio: number | null;
  ingredients: DaySolutionIngredient[];
  split: DaySplit;
}

// A batch several meals eat from (S-08). Every meal of it carries the full batch amounts, so a
// consumer that sums amounts (shopping list, cooking) must count each dishId once.
export interface DaySolutionBatch {
  dishId: string;
  // The lowest day any meal of the batch is on: the day it is cooked.
  cookDayIndex: PlanDayIndex;
  mealIds: string[];
}

export interface DaySolutionMeal {
  mealId: string;
  mealType: MealType;
  recipeId: string;
  recipeName: string;
  divisionMode: DivisionMode;
  eaterUserIds: string[];
  components: DaySolutionComponent[];
  // Null when the meal's batch is cooked for this meal alone.
  batch: DaySolutionBatch | null;
}

export interface DaySolutionPerson {
  userId: string;
  targets: MacroTargetsInput;
  totals: MacroTotals;
  // Signed fractions: (total − target) / target, or / 50 g for a zero target.
  deviations: MacroTotals;
}

export type DaySolveExplanation =
  | {
      kind: "recipe";
      mealId: string;
      recipeName: string;
      macro: MacroKey;
      direction: "over" | "under";
      // The blamed batch is eaten on more than one day (S-08).
      sharedAcrossDays: boolean;
    }
  | { kind: "targets"; userId: string };

// Also the persisted jsonb shape (S-04 phase 2; grown additively by S-08, still version 1).
export interface DaySolution {
  version: 1;
  people: DaySolutionPerson[];
  meals: DaySolutionMeal[];
  // This day's own worst |deviation|.
  maxDeviationPct: number;
  // The solve group's tier (the worst over its days), identical on every day of the group.
  requiredTier: SolveTier | null;
  explanation: DaySolveExplanation | null;
  // True when the repaired rounding still breaks a hard bound (an ingredient minimum, 0.2×–1.5× of
  // a batch, or the 3× component ratio). The tier is still judged on the deviation; the day page warns.
  boundsViolated: boolean;
}

export type SolveDayResult = { kind: "solution"; solution: DaySolution } | ({ kind: "unsolvable" } & UnsolvableReason);

// A whole solve group: one solution per day of the group, in day order.
export type SolveGroupResult =
  | { kind: "solution"; days: { dayIndex: PlanDayIndex; solution: DaySolution }[] }
  | ({ kind: "unsolvable" } & UnsolvableReason);

// One row of public.plan_day_solutions, as the app reads it.
export interface StoredDaySolution {
  status: DaySolveStatus;
  acceptedTolerancePct: SolveTier;
  inputFingerprint: string;
  solution: DaySolution;
  solvedAt: string;
}

// The day page's model: the current inputs of the day's solve group (or why they cannot be solved),
// the stored result, and whether that result is out of date. `fingerprint` is the GROUP's (S-08), so
// an edit to any day of the group makes every day of it stale. `stale` is true when the stored
// fingerprint differs from the current one, or when a stored result exists but the current inputs
// are unsolvable. `stored` is the viewed day's row; `groupStored` holds every group day's row.
export interface DayView {
  plan: MealPlan;
  input: SolveDayInput;
  unsolvable: UnsolvableReason | null;
  fingerprint: string;
  stored: StoredDaySolution | null;
  stale: boolean;
  groupDayIndexes: PlanDayIndex[];
  groupStored: Partial<Record<PlanDayIndex, StoredDaySolution>>;
}

// One day's standing on the /plan grid. `requiredTier` is set for a current stored solution only.
// Every day of a solve group carries the group's status (S-08); only the group's lowest day
// (`isGroupLead`) prompts, and `groupMaxMealCount` is the most meals any one day of the group holds.
export interface PlanDaySolveStatus {
  kind: "empty" | "unsolved" | "stale" | "unsolvable" | DaySolveStatus;
  mealCount: number;
  requiredTier?: SolveTier | null;
  groupDayIndexes: PlanDayIndex[];
  isGroupLead: boolean;
  groupMaxMealCount: number;
}
// --- end S-04 -------------------------------------------------------------------------------

// --- S-09: shopping list from the plan ------------------------------------------------------
// A library recipe ingredient's product, keyed by the ingredient id (recipe_ingredients.id, which is
// also DaySolutionIngredient.id), so stored and base ingredients map to products the same way.
export interface IngredientProduct {
  ingredientId: string;
  productId: string;
  productName: string;
  aisle: StoreAisle;
  gramsPerPiece: number | null;
}

// One product of the list: the plan's combined amount for both people.
export interface ShoppingItem {
  productId: string;
  productName: string;
  aisle: StoreAisle;
  amountG: number;
  gramsPerPiece: number | null;
  checked: boolean;
}

export interface ShoppingAisle {
  aisle: StoreAisle;
  items: ShoppingItem[];
}

// Where a day's amounts come from: a current stored solve, recipe base amounts, or no meals.
export type ShoppingDaySource = "exact" | "estimate" | "empty";

// Derived on every read, never stored; only the checks persist (shopping_list_checks).
export interface ShoppingList {
  planId: string;
  startDate: string;
  aisles: ShoppingAisle[];
  daySources: Record<PlanDayIndex, ShoppingDaySource>;
  itemCount: number;
  checkedCount: number;
  // Inconsistent inputs the builder skipped or worked around; the I/O layer logs them.
  diagnostics: { missingRecipeIds: string[]; unmatchedIngredientIds: string[]; dishesFellBack: string[] };
}
// --- end S-09 -------------------------------------------------------------------------------

// --- S-10: cooking-session schedule ---------------------------------------------------------
// Input: one recipe's ordered steps, as read for the plan's recipes.
export interface RecipeSteps {
  recipeId: string;
  recipeName: string;
  steps: RecipeDetailStep[];
}

export type SessionPart = "morning" | "evening";
// now: fresh steps for meals of the session's own day; ahead: make-ahead for the next day.
export type SessionSectionKind = "now" | "ahead";

export interface SessionMealRef {
  mealId: string;
  dishId: string;
  dayIndex: PlanDayIndex;
  mealType: MealType;
}

// A library step as scheduled; `id` is the recipe_steps id. S-11 depends on these field names.
export interface ScheduledStep extends RecipeDetailStep {
  recipeId: string;
  recipeName: string;
  entryKey: string;
}

// One recipe cooked in one section: one dish, or several dishes of the same recipe merged.
export interface CookingSessionEntry {
  // Stable within the schedule: the section key plus the smallest dishId.
  key: string;
  recipeId: string;
  // Null when the recipe was missing from the read.
  recipeName: string | null;
  // Sorted; more than one means merged same-recipe batches.
  dishIds: string[];
  // Every meal those dishes feed, in (day, meal type) order.
  meals: SessionMealRef[];
  hasSteps: boolean;
}

// A later meal of a shared batch: nothing to cook, it eats from the batch of `leadMeal`.
export interface SessionBatchNote {
  meal: SessionMealRef;
  recipeName: string | null;
  leadMeal: SessionMealRef;
}

export interface CookingSessionSection {
  kind: SessionSectionKind;
  entries: CookingSessionEntry[];
  // The section's merged step order.
  steps: ScheduledStep[];
  batchNotes: SessionBatchNote[];
}

export interface CookingSession {
  // `<YYYY-MM-DD>-<part>`, URL-safe.
  key: string;
  date: string;
  part: SessionPart;
  // "now" before "ahead".
  sections: CookingSessionSection[];
  stepCount: number;
  knownMinutes: number;
  untimedCount: number;
}

// Derived on every read, never stored.
export interface CookingSchedule {
  planId: string;
  startDate: string;
  // Chronological.
  sessions: CookingSession[];
  // Inconsistent inputs the builder worked around; the I/O layer logs them. makeAheadDemoted holds step ids.
  diagnostics: { missingRecipeIds: string[]; recipesWithoutSteps: string[]; makeAheadDemoted: string[] };
}
// --- end S-10 -------------------------------------------------------------------------------

// --- S-11: step-by-step cook mode -----------------------------------------------------------
// A display-ready view model of one session: every string is already viewer-relative, so the island
// only renders it. Derived on every read, never stored.

// Where a section's amounts come from: a current stored solve, or the recipe base amounts.
export type CookAmountSource = "exact" | "estimate";

// `amount` is formatted ("2 pcs (100 g)").
export interface CookIngredientLine {
  ingredientId: string;
  productName: string;
  amount: string;
}

// `componentName` is set only for per_component recipes.
export interface CookPortionLine {
  componentName: string | null;
  line: string;
}

// One batch's amounts for one component (a step) or for the whole dish (the overview).
export interface CookBatchAmounts {
  dishId: string;
  // "For Monday Lunch" — set only when the entry has more than one batch.
  heading: string | null;
  // True for a batch of an exact section that fell back to the recipe base amounts (its stored row is
  // missing), so the page can mark it; false otherwise, the estimate section note covering the rest.
  estimate: boolean;
  ingredients: CookIngredientLine[];
}

export interface CookBatchPortions {
  dishId: string;
  heading: string | null;
  lines: CookPortionLine[];
}

export interface CookStep {
  // 1-based across the session.
  number: number;
  // The recipe_steps id.
  id: string;
  sectionKind: SessionSectionKind;
  entryKey: string;
  recipeId: string;
  recipeName: string;
  componentName: string | null;
  instruction: string;
  timing: StepTiming;
  durationMinutes: number | null;
  // Empty for a step with no component.
  amounts: CookBatchAmounts[];
  // Set on the entry's last step in its section; null on an estimate section. Batches that fell back
  // to the estimate are left out.
  portions: CookBatchPortions[] | null;
}

export interface CookEntryOverview {
  key: string;
  recipeId: string;
  recipeName: string | null;
  // formatEntryMeals()
  mealsLine: string;
  hasSteps: boolean;
  batches: {
    dishId: string;
    heading: string | null;
    // As CookBatchAmounts.estimate.
    estimate: boolean;
    // One block per component, as on /plan/day; componentName set only for per_component recipes.
    components: { componentName: string | null; ingredients: CookIngredientLine[]; portion: string | null }[];
  }[];
}

// A later meal of a shared batch: nothing to cook, only that meal's own portions to serve.
export interface CookServingNote {
  mealId: string;
  dayIndex: PlanDayIndex;
  mealType: MealType;
  text: string;
  portions: CookPortionLine[];
}

export interface CookModeSection {
  kind: SessionSectionKind;
  source: CookAmountSource;
  // The lead day its amounts come from (and the solve link's day).
  sourceDayIndex: PlanDayIndex;
  // Exact only: the source day's stored solve breaks a hard bound.
  boundsWarning: boolean;
  entries: CookEntryOverview[];
  servingNotes: CookServingNote[];
}

export interface CookModeView {
  planId: string;
  startDate: string;
  sessionKey: string;
  date: string;
  part: SessionPart;
  sections: CookModeSection[];
  steps: CookStep[];
  // Inconsistent inputs the builder worked around; the I/O layer logs them.
  diagnostics: { dishesFellBack: string[]; missingRecipeIds: string[] };
}

// The part of the view the island reads; the overview is plain Astro, so it is not serialised twice.
export type CookModeIslandView = Pick<CookModeView, "planId" | "startDate" | "sessionKey" | "part" | "steps">;
// --- end S-11 -------------------------------------------------------------------------------
