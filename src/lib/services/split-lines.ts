import type { DaySolutionComponent, DaySplitShare, MealType, PlanDayIndex } from "@/types";
import { EATER_LABELS, MEAL_TYPE_LABELS, SPLIT_LABELS } from "@/lib/recipe-labels";
import { roundHalfUp } from "@/lib/services/recipe-macros";

// How a stored component is split between its servings, as display text (S-04, S-08). Pure and
// island-safe: it imports only types, labels and recipe-macros.ts — never day-solutions.ts, the
// solver, zod or Supabase — so the cook-mode island (S-11) can use it. day-solutions.ts re-exports it.

export function personLabel(userId: string, viewerId: string): string {
  return userId === viewerId ? EATER_LABELS.you : EATER_LABELS.partner;
}

// The viewer first, then the partner.
export function viewerFirst<T extends { userId: string }>(list: readonly T[], viewerId: string): T[] {
  return [...list].sort((a, b) => Number(b.userId === viewerId) - Number(a.userId === viewerId));
}

function formatPieces(count: number): string {
  if (Number.isInteger(count)) return `${count} ${count === 1 ? "pc" : "pcs"}`;
  const whole = Math.floor(count);
  return whole === 0 ? "½ pc" : `${whole}½ pcs`;
}

function formatGramsShort(grams: number): string {
  return `${Number.isInteger(grams) ? grams : grams.toFixed(1)} g`;
}

// Where the split line is shown (S-08): the meal row it belongs to and the viewed day, so a share
// eaten at another meal of a shared batch can be named. Without it every share reads as this meal's.
export interface SplitLineContext {
  mealId: string;
  viewedDay: PlanDayIndex;
  weekdayOf: (dayIndex: PlanDayIndex) => string;
  mealTypeOf: (mealId: string) => MealType | undefined;
  // The meal eats from a batch cooked on another day, whose amounts this page does not list: show
  // only this meal's own portions, and a percentage share also as grams.
  ownOnly?: boolean;
}

// A percent split's share in grams of the whole batch (a percent split has no cooked yield, so the
// batch weighs what its ingredients do).
function percentShareGrams(component: DaySolutionComponent, share: DaySplitShare): number {
  const batch = component.ingredients.reduce((sum, ingredient) => sum + ingredient.amountG, 0);
  return roundHalfUp(share.fraction * batch);
}

function isOwnShare(share: DaySplitShare, context: SplitLineContext | undefined): boolean {
  return context === undefined || share.mealId === null || share.mealId === context.mealId;
}

// " (Tuesday)" for a share eaten on another day, " (Dinner)" for one eaten at another meal of the
// viewed day, "" otherwise — always "" for a legacy (pre-S-08) share, whose mealId/dayIndex are null.
function shareSuffix(share: DaySplitShare, context: SplitLineContext | undefined): string {
  if (context === undefined || isOwnShare(share, context)) return "";
  if (share.dayIndex !== null && share.dayIndex !== context.viewedDay) return ` (${context.weekdayOf(share.dayIndex)})`;
  const mealType = share.mealId !== null ? context.mealTypeOf(share.mealId) : undefined;
  return mealType ? ` (${MEAL_TYPE_LABELS[mealType]})` : "";
}

// One component's split between its servings, e.g. "You: 320 g cooked · Partner: 260 g cooked".
// This meal's servings come first, the viewer first within each; a shared batch's other servings are
// suffixed with their day (or meal).
export function formatSplitLine(component: DaySolutionComponent, viewerId: string, context?: SplitLineContext): string {
  const { kind, evenSplit } = component.split;
  const own = component.split.shares.filter((share) => isOwnShare(share, context));
  const other = component.split.shares.filter((share) => !isOwnShare(share, context));
  const ownOnly = context?.ownOnly === true;
  const shares = [...viewerFirst(own, viewerId), ...(ownOnly ? [] : viewerFirst(other, viewerId))];
  if (kind === "all") {
    return shares[0].userId === viewerId ? SPLIT_LABELS.allForYou : SPLIT_LABELS.allForPartner;
  }
  const parts = shares.map((share) => {
    const label = `${personLabel(share.userId, viewerId)}${shareSuffix(share, context)}`;
    switch (kind) {
      case "grams_cooked":
        return `${label}: ${share.value ?? 0} g ${SPLIT_LABELS.cooked}`;
      case "percent":
        return ownOnly
          ? `${label}: ${formatGramsShort(percentShareGrams(component, share))} (${share.value ?? 0}% ${SPLIT_LABELS.ofTheDish})`
          : `${label}: ${share.value ?? 0}%`;
      case "pieces":
        return `${label}: ${formatPieces(share.value ?? 0)}`;
      case "per_ingredient":
        // perPerson holds this meal's eaters only; another meal's serving is shown as its share.
        if (!isOwnShare(share, context)) {
          return `${label}: ${roundHalfUp(share.fraction * 100)}% ${SPLIT_LABELS.ofTheBatch}`;
        }
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
  // Own-only: the percentages are already labelled, and an even split describes servings not shown.
  if (ownOnly) return line;
  if (kind === "percent") line += ` ${SPLIT_LABELS.ofTheDish}`;
  if (evenSplit) {
    line += ` · ${shares.length === 2 ? SPLIT_LABELS.splitInHalf : SPLIT_LABELS.splitEvenly(shares.length)}`;
  }
  return line;
}
