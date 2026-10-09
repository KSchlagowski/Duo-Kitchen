import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DaySolution,
  DaySolutionComponent,
  DaySolutionMeal,
  DaySolutionPerson,
  DaySolveStatus,
  MacroKey,
  MacroTargetsInput,
  MealPlan,
  PlanDayIndex,
  SolveDayInput,
  UnsolvableReason,
} from "@/types";
import { getCurrentHousehold } from "@/lib/services/household";
import { formatMacroTargets, getHouseholdMacroTargets } from "@/lib/services/macro-targets";
import { getMealPlan } from "@/lib/services/meal-plans";
import { roundHalfUp } from "@/lib/services/recipe-macros";
import { getSolverRecipes } from "@/lib/services/recipes";
import { EATER_LABELS, MACRO_DIRECTION_LABELS, MACRO_SHORT_LABELS, SPLIT_LABELS } from "@/lib/recipe-labels";

// Solving one planned day (S-04): the reads that feed the pure solver (macro-solver.ts) and the
// sentence templates the day page shows. Enum labels live in recipe-labels.ts (S-14 localises them).

// Everything solveDay() needs for one day, or null when no plan exists for that date. A failed
// read throws: it must never degrade into "no targets" or "no meals".
export async function loadDaySolveInputs(
  supabase: SupabaseClient,
  startDate: string,
  dayIndex: PlanDayIndex,
): Promise<{ plan: MealPlan; input: SolveDayInput } | null> {
  const plan = await getMealPlan(supabase, startDate);
  if (!plan) {
    return null;
  }
  const meals = plan.meals.filter((meal) => meal.dayIndex === dayIndex);
  const [household, targets, recipes] = await Promise.all([
    getCurrentHousehold(supabase),
    getHouseholdMacroTargets(supabase),
    getSolverRecipes(
      supabase,
      meals.map((meal) => meal.recipeId),
    ),
  ]);
  if (!household) {
    throw new Error("loadDaySolveInputs: the caller has no household");
  }

  const targetsByUser: Record<string, MacroTargetsInput> = {};
  for (const t of targets) {
    targetsByUser[t.userId] = { kcal: t.kcal, proteinG: t.proteinG, fatG: t.fatG, carbsG: t.carbsG };
  }
  return {
    plan,
    input: {
      memberIds: household.members.map((member) => member.userId),
      meals,
      recipes,
      targets: targetsByUser,
    },
  };
}

// --- display text --------------------------------------------------------------------------------

export const DAY_NOT_FOUND = "Day not found";
export const DAY_UNAVAILABLE = "This day is unavailable right now.";
export const FULL_TARGETS_NOTE = "Portions are scaled to each person's full daily targets.";

// P11 reasons, with "You" / "Your partner" resolved against the viewer.
export const UNSOLVABLE_MESSAGES = {
  no_meals: "This day has no meals yet — add some on the plan first.",
  missing_targets_you: "Set your daily targets first — the solver needs them.",
  missing_targets_partner: "Your partner hasn't set their daily targets yet.",
  empty_recipe: (recipeName: string) => `${recipeName} has no ingredients, so this day can't be solved.`,
  eater_not_member: "A meal is marked for someone who isn't in your household.",
} as const;

export function unsolvableMessage(reason: UnsolvableReason, viewerId: string): string {
  switch (reason.reason) {
    case "no_meals":
      return UNSOLVABLE_MESSAGES.no_meals;
    case "missing_targets":
      return reason.userIds?.includes(viewerId)
        ? UNSOLVABLE_MESSAGES.missing_targets_you
        : UNSOLVABLE_MESSAGES.missing_targets_partner;
    case "empty_recipe":
      return UNSOLVABLE_MESSAGES.empty_recipe(reason.recipeName ?? "A recipe");
    case "eater_not_member":
      return UNSOLVABLE_MESSAGES.eater_not_member;
  }
}

// The smoke test matches these exact strings.
export function formatDaySolveSummary(solution: DaySolution, status: DaySolveStatus, viewerId?: string): string {
  const tier = solution.requiredTier;
  if (status === "solved" && tier !== null) {
    return `Solved within ±${tier}%`;
  }
  if (status === "needs_confirmation" && tier !== null) {
    return `Best fit needs ±${tier}% — accept to use it`;
  }
  const explanation = solution.explanation;
  if (explanation?.kind === "targets") {
    const whose = viewerId === undefined || explanation.userId === viewerId ? "Your" : "Your partner's";
    return `${whose} daily targets don't add up (protein/fat/carbs vs kcal) — adjust them first.`;
  }
  if (explanation?.kind === "recipe") {
    const reason = MACRO_DIRECTION_LABELS[explanation.macro][explanation.direction];
    return `No fit within ±20% · Most obstructive recipe: ${explanation.recipeName} (${reason})`;
  }
  return "No fit within ±20%";
}

function personLabel(userId: string, viewerId: string): string {
  return userId === viewerId ? EATER_LABELS.you : EATER_LABELS.partner;
}

// The viewer first, then the partner.
export function viewerFirst<T extends { userId: string }>(list: readonly T[], viewerId: string): T[] {
  return [...list].sort((a, b) => Number(b.userId === viewerId) - Number(a.userId === viewerId));
}

function formatSignedPct(fraction: number): string {
  const pct = Math.round(Number((Math.abs(fraction) * 1000).toFixed(6))) / 10;
  const sign = pct === 0 ? "±" : fraction > 0 ? "+" : "−";
  return `${sign}${pct.toFixed(1)}%`;
}

const LINE_MACROS: readonly MacroKey[] = ["kcal", "proteinG", "fatG", "carbsG"];

// "You · 2190 kcal (−0.5%) · P 158 g (−1.3%) · F 72 g (+2.9%) · C 228 g (−0.9%)"
export function formatPersonLine(person: DaySolutionPerson, viewerId: string): string {
  const parts = LINE_MACROS.map((m) => {
    const value = roundHalfUp(person.totals[m]);
    const amount = m === "kcal" ? `${value} kcal` : `${MACRO_SHORT_LABELS[m]} ${value} g`;
    return `${amount} (${formatSignedPct(person.deviations[m])})`;
  });
  return [personLabel(person.userId, viewerId), ...parts].join(" · ");
}

export function formatTargetLine(person: DaySolutionPerson): string {
  return `Target: ${formatMacroTargets(person.targets)}`;
}

export function formatEaters(meal: DaySolutionMeal, viewerId: string): string {
  if (meal.eaterUserIds.length > 1) return EATER_LABELS.both;
  return personLabel(meal.eaterUserIds[0], viewerId);
}

function formatPieces(count: number): string {
  if (Number.isInteger(count)) return `${count} ${count === 1 ? "pc" : "pcs"}`;
  const whole = Math.floor(count);
  return whole === 0 ? "½ pc" : `${whole}½ pcs`;
}

function formatGramsShort(grams: number): string {
  return `${Number.isInteger(grams) ? grams : grams.toFixed(1)} g`;
}

// One component's split between its eaters, e.g. "You: 320 g cooked · Partner: 260 g cooked".
export function formatSplitLine(component: DaySolutionComponent, viewerId: string): string {
  const { kind, evenSplit } = component.split;
  const shares = viewerFirst(component.split.shares, viewerId);
  if (kind === "all") {
    return shares[0].userId === viewerId ? SPLIT_LABELS.allForYou : SPLIT_LABELS.allForPartner;
  }
  const parts = shares.map((share) => {
    const label = personLabel(share.userId, viewerId);
    switch (kind) {
      case "grams_cooked":
        return `${label}: ${share.value ?? 0} g ${SPLIT_LABELS.cooked}`;
      case "percent":
        return `${label}: ${share.value ?? 0}%`;
      case "pieces":
        return `${label}: ${formatPieces(share.value ?? 0)}`;
      case "per_ingredient":
        return `${label}: ${component.ingredients
          .map((ingredient) => {
            const grams = ingredient.perPerson?.[share.userId] ?? 0;
            return ingredient.gramsPerPiece !== null
              ? `${formatPieces(Number((grams / ingredient.gramsPerPiece).toFixed(6)))} ${ingredient.productName}`
              : `${formatGramsShort(grams)} ${ingredient.productName}`;
          })
          .join(" + ")}`;
    }
  });
  let line = parts.join(" · ");
  if (kind === "percent") line += ` ${SPLIT_LABELS.ofTheDish}`;
  if (evenSplit) line += ` · ${SPLIT_LABELS.splitInHalf}`;
  return line;
}
