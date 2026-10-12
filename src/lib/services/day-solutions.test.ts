import { describe, expect, it } from "vitest";
import type { DaySolutionComponent, DaySplitShare, MealType, PlanDayIndex } from "@/types";
import { formatSplitLine, type SplitLineContext } from "@/lib/services/day-solutions";

const USER_A = "user-a";
const USER_B = "user-b";
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday"];

// One 1000 g percent-split batch (no cooked yield) with the given servings.
function percentBatch(shares: DaySplitShare[], evenSplit = false): DaySolutionComponent {
  return {
    id: "component",
    name: "Leczo",
    cookedYieldRatio: null,
    ingredients: [
      {
        id: "ingredient",
        productName: "Papryka",
        amountG: 1000,
        gramsPerPiece: null,
        allowHalfPieces: false,
        perPerson: null,
      },
    ],
    split: { kind: "percent", evenSplit, shares },
  };
}

function share(userId: string, mealId: string, dayIndex: PlanDayIndex, value: number): DaySplitShare {
  return { userId, mealId, dayIndex, value, fraction: value / 100 };
}

function context(mealId: string, viewedDay: PlanDayIndex, mealTypes: Record<string, MealType>): SplitLineContext {
  return { mealId, viewedDay, weekdayOf: (day) => WEEKDAYS[day], mealTypeOf: (id) => mealTypes[id] };
}

describe("formatSplitLine", () => {
  it("names the other meal of a batch shared within one day", () => {
    const component = percentBatch([
      share(USER_A, "lunch", 0, 30),
      share(USER_B, "lunch", 0, 30),
      share(USER_A, "dinner", 0, 20),
      share(USER_B, "dinner", 0, 20),
    ]);
    expect(formatSplitLine(component, USER_A, context("lunch", 0, { lunch: "lunch", dinner: "dinner" }))).toBe(
      "You: 30% · Partner: 30% · You (Dinner): 20% · Partner (Dinner): 20% of the dish",
    );
  });

  it("shows only this meal's portions, in grams, for a batch cooked on another day", () => {
    const component = percentBatch(
      [
        share(USER_A, "mon", 0, 25),
        share(USER_B, "mon", 0, 25),
        share(USER_A, "tue", 1, 25),
        share(USER_B, "tue", 1, 25),
      ],
      true,
    );
    const types: Record<string, MealType> = { mon: "lunch", tue: "lunch" };
    expect(formatSplitLine(component, USER_A, { ...context("tue", 1, types), ownOnly: true })).toBe(
      "You: 250 g (25% of the dish) · Partner: 250 g (25% of the dish)",
    );
    expect(formatSplitLine(component, USER_A, context("tue", 1, types))).toBe(
      "You: 25% · Partner: 25% · You (Monday): 25% · Partner (Monday): 25% of the dish · split evenly 4 ways",
    );
  });
});
