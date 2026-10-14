import { describe, expect, it } from "vitest";
import type {
  CookModeView,
  CookPortionLine,
  CookStep,
  DaySolution,
  PlanDayIndex,
  PlanMealRecord,
  SolveDayInput,
} from "@/types";
import {
  buildCookMode,
  cookPath,
  formatBatchHeading,
  formatCookEstimateNote,
  formatCookExactNote,
  formatStepCounter,
} from "@/lib/services/cook-mode";
import { buildCookingSessions } from "@/lib/services/cooking-sessions";
import { planOf, SEED_RECIPE_STEPS } from "@/lib/services/cooking-sessions.fixtures";
import { solveGroup, solveGroups } from "@/lib/services/macro-solver";
import {
  CURRY,
  day,
  F5,
  JAJECZNICA,
  LECZO,
  OWSIANKA,
  SEED_RECIPES,
  shareDish,
  TARGET_A,
  TARGET_B,
  USER_A,
  USER_B,
} from "@/lib/services/macro-solver.fixtures";
import { formatIngredientAmount } from "@/lib/services/recipe-macros";
import { formatSplitLine } from "@/lib/services/split-lines";

// Real solver output over the seed fixtures, on plans starting Monday 2031-01-20. Step ids are compared
// by their last three digits: recipe number, then position ("404" is curry step 4).

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday"];

// Every solve group of the plan solved, as currentSolutions.
function solveAll(meals: PlanMealRecord[]): Partial<Record<PlanDayIndex, DaySolution>> {
  const solutions: Partial<Record<PlanDayIndex, DaySolution>> = {};
  for (const group of solveGroups(meals)) {
    const input: SolveDayInput = {
      memberIds: [USER_A, USER_B],
      meals: group,
      recipes: SEED_RECIPES,
      targets: { [USER_A]: TARGET_A, [USER_B]: TARGET_B },
    };
    const result = solveGroup(input);
    if (result.kind !== "solution") throw new Error(`unsolvable: ${result.reason}`);
    for (const { dayIndex, solution } of result.days) solutions[dayIndex] = solution;
  }
  return solutions;
}

function cook(
  meals: PlanMealRecord[],
  sessionKey: string,
  currentSolutions: Partial<Record<PlanDayIndex, DaySolution>>,
  viewerId: string = USER_A,
): CookModeView {
  const plan = planOf(meals);
  const session = buildCookingSessions({ plan, recipeSteps: SEED_RECIPE_STEPS }).sessions.find(
    (candidate) => candidate.key === sessionKey,
  );
  if (!session) throw new Error(`no session ${sessionKey}`);
  return buildCookMode({ plan, session, currentSolutions, recipes: SEED_RECIPES, viewerId });
}

function stepById(view: CookModeView, suffix: string): CookStep {
  const found = view.steps.find((step) => step.id.endsWith(suffix));
  if (!found) throw new Error(`no step ${suffix}`);
  return found;
}

function mealAt(meals: PlanMealRecord[], dayIndex: PlanDayIndex, mealType: PlanMealRecord["mealType"]) {
  const found = meals.find((meal) => meal.dayIndex === dayIndex && meal.mealType === mealType);
  if (!found) throw new Error("empty slot");
  return found;
}

function storedMeal(solutions: Partial<Record<PlanDayIndex, DaySolution>>, meal: PlanMealRecord) {
  const found = solutions[meal.dayIndex]?.meals.find((candidate) => candidate.mealId === meal.mealId);
  if (!found) throw new Error("no stored meal");
  return found;
}

function context(meals: PlanMealRecord[], meal: PlanMealRecord) {
  const types = new Map(meals.map((m) => [m.mealId, m.mealType]));
  return {
    mealId: meal.mealId,
    viewedDay: meal.dayIndex,
    weekdayOf: (d: PlanDayIndex) => WEEKDAYS[d],
    mealTypeOf: (id: string) => types.get(id),
  };
}

// A portion line as a map of "<label><suffix>" → value, plus the tail segments ("split in half") that
// carry no label. With `swap`, You and Partner trade places (and "All for you" with "All for your
// partner"). formatSplitLine sorts the viewer first, so two viewers' strings differ in order; their
// parsed maps must not.
function parseShares(line: string, swap: boolean): { shares: Record<string, string>; tail: string[] } {
  const labels: Record<string, string> = swap ? { You: "Partner", Partner: "You" } : { You: "You", Partner: "Partner" };
  const all: Record<string, string> = swap
    ? { "All for you": "All for your partner", "All for your partner": "All for you" }
    : { "All for you": "All for you", "All for your partner": "All for your partner" };
  if (line in all) return { shares: { all: all[line] }, tail: [] };
  const shares: Record<string, string> = {};
  const tail: string[] = [];
  // A percent split labels its whole list once, after whichever share comes last.
  const ofTheDish = /% of the dish(?= · |$)/;
  if (ofTheDish.test(line)) tail.push("of the dish");
  for (const segment of line.replace(ofTheDish, "%").split(" · ")) {
    const match = /^(You|Partner)((?: \([^)]+\))?): (.*)$/.exec(segment);
    if (match) shares[`${labels[match[1]]}${match[2]}`] = match[3];
    else tail.push(segment);
  }
  return { shares, tail };
}

const F5_SOLVED = solveAll(F5);
const MON_LUNCH = mealAt(F5, 0, "lunch");
const TUE_LUNCH = mealAt(F5, 1, "lunch");

describe("buildCookMode", () => {
  it("cooks a shared batch once, with its portions on the last step of the evening", () => {
    const view = cook(F5, "2031-01-19-evening", F5_SOLVED);
    expect(view.sections.map((s) => [s.kind, s.source, s.sourceDayIndex])).toEqual([["ahead", "exact", 0]]);

    const curry = view.sections[0].entries.find((entry) => entry.recipeId === CURRY);
    expect(curry?.batches).toHaveLength(1);
    const stored = storedMeal(F5_SOLVED, MON_LUNCH);
    expect(curry?.batches[0].heading).toBeNull();
    expect(curry?.batches[0].components.flatMap((c) => c.ingredients.map((i) => i.ingredientId))).toEqual(
      stored.components.flatMap((c) => c.ingredients.map((i) => i.id)),
    );
    expect(curry?.batches[0].components.flatMap((c) => c.ingredients.map((i) => i.amount))).toEqual(
      stored.components.flatMap((c) =>
        c.ingredients.map((i) => formatIngredientAmount(i.amountG, i.gramsPerPiece, i.allowHalfPieces)),
      ),
    );

    const currySteps = view.steps.filter((step) => step.recipeId === CURRY);
    expect(currySteps.map((step) => step.id.slice(-3))).toEqual(["401", "402", "403", "404"]);
    expect(currySteps.map((step) => step.portions !== null)).toEqual([false, false, false, true]);

    const rice = stored.components[0];
    const chicken = stored.components[1];
    expect(stepById(view, "401").amounts.map((a) => a.ingredients.map((i) => i.ingredientId))).toEqual([
      rice.ingredients.map((i) => i.id),
    ]);
    for (const id of ["402", "403"]) {
      expect(stepById(view, id).amounts.map((a) => a.ingredients.map((i) => i.ingredientId))).toEqual([
        chicken.ingredients.map((i) => i.id),
      ]);
    }

    const portions = stepById(view, "404").portions ?? [];
    expect(portions).toHaveLength(1);
    expect(portions[0].lines.map((l) => l.componentName)).toEqual(["Ryż", "Kurczak", "Sos curry"]);
    expect(portions[0].lines.map((l) => l.line)).toEqual(
      stored.components.map((c) => formatSplitLine(c, USER_A, context(F5, MON_LUNCH))),
    );
    expect(portions[0].lines.every((l) => l.line.includes("(Tuesday)"))).toBe(true);
    expect(view.diagnostics).toEqual({ dishesFellBack: [], missingRecipeIds: [] });
  });

  it("serves a later meal of a shared batch its own portions, with no curry step", () => {
    const view = cook(F5, "2031-01-21-morning", F5_SOLVED);
    expect(view.steps.filter((step) => step.recipeId === CURRY)).toEqual([]);
    const notes = view.sections.flatMap((s) => s.servingNotes);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("Lunch: from the same batch as Monday Lunch — nothing new to cook.");
    const own = storedMeal(F5_SOLVED, TUE_LUNCH);
    expect(notes[0].portions.map((p) => p.line)).toEqual(
      own.components.map((c) => formatSplitLine(c, USER_A, { ...context(F5, TUE_LUNCH), ownOnly: true })),
    );
    expect(notes[0].portions.some((p) => p.line.includes("(Monday)"))).toBe(false);
  });

  it("never counts a dish twice within a session", () => {
    const plan = planOf(F5);
    for (const session of buildCookingSessions({ plan, recipeSteps: SEED_RECIPE_STEPS }).sessions) {
      const view = cook(F5, session.key, F5_SOLVED);
      const dishIds = view.sections.flatMap((s) => s.entries.flatMap((e) => e.batches.map((b) => b.dishId)));
      expect(new Set(dishIds).size).toBe(dishIds.length);
    }
    const tuesday = cook(F5, "2031-01-21-morning", F5_SOLVED);
    const tuesdayDishes = tuesday.sections.flatMap((s) => s.entries.flatMap((e) => e.batches.map((b) => b.dishId)));
    expect(tuesdayDishes).not.toContain(MON_LUNCH.dishId);
  });

  it("reads a same-day shared batch from its lunch row, naming the dinner servings", () => {
    const meals = shareDish(day([null, null, CURRY, null, CURRY]), [0, "lunch"], [0, "dinner"]);
    const solved = solveAll(meals);
    const lunch = mealAt(meals, 0, "lunch");
    const view = cook(meals, "2031-01-19-evening", solved);
    const portions = stepById(view, "404").portions ?? [];
    expect(portions).toHaveLength(1);
    expect(portions[0].lines.map((l) => l.line)).toEqual(
      storedMeal(solved, lunch).components.map((c) => formatSplitLine(c, USER_A, context(meals, lunch))),
    );
    expect(portions[0].lines.every((l) => l.line.includes("(Dinner)"))).toBe(true);
  });

  it("keeps each batch of a merged entry apart", () => {
    const meals = day([null, null, LECZO, null, LECZO]);
    const solved = solveAll(meals);
    const view = cook(meals, "2031-01-19-evening", solved);
    expect(view.sections[0].entries).toHaveLength(1);
    const [entry] = view.sections[0].entries;
    expect(entry.batches.map((b) => b.heading)).toEqual(["For Monday Lunch", "For Monday Dinner"]);
    for (const [i, mealType] of (["lunch", "dinner"] as const).entries()) {
      const stored = storedMeal(solved, mealAt(meals, 0, mealType));
      expect(entry.batches[i].dishId).toBe(mealAt(meals, 0, mealType).dishId);
      expect(entry.batches[i].components[0].ingredients.map((l) => l.ingredientId)).toEqual(
        stored.components[0].ingredients.map((ingredient) => ingredient.id),
      );
      expect(entry.batches[i].components[0].portion).toBe(
        formatSplitLine(stored.components[0], USER_A, context(meals, mealAt(meals, 0, mealType))),
      );
    }
    expect(view.steps.map((step) => step.id.slice(-3))).toEqual(["601", "602", "603", "604"]);
    expect(stepById(view, "601").amounts.map((a) => a.heading)).toEqual(["For Monday Lunch", "For Monday Dinner"]);
    expect(stepById(view, "604").portions?.map((p) => p.heading)).toEqual(["For Monday Lunch", "For Monday Dinner"]);
  });

  it("shows no amounts on a step with no component, but the portions on the last one", () => {
    const view = cook(F5, "2031-01-20-morning", F5_SOLVED);
    const serve = stepById(view, "405");
    expect(serve.componentName).toBeNull();
    expect(serve.amounts).toEqual([]);
    expect(serve.portions?.[0].lines.map((l) => l.line)).toEqual(
      storedMeal(F5_SOLVED, MON_LUNCH).components.map((c) => formatSplitLine(c, USER_A, context(F5, MON_LUNCH))),
    );
  });

  it("renders per-person components from their stored split", () => {
    const view = cook(F5, "2031-01-20-morning", F5_SOLVED);
    const line = (recipeId: string, component: string): CookPortionLine | undefined =>
      view.steps
        .filter((step) => step.recipeId === recipeId && step.portions !== null)
        .flatMap((step) => step.portions?.[0].lines ?? [])
        .find((l) => l.componentName === component);

    const breakfast = storedMeal(F5_SOLVED, mealAt(F5, 0, "breakfast"));
    const bread = breakfast.components.find((c) => c.name === "Pieczywo");
    expect(bread?.split.kind).toBe("pieces");
    expect(line(JAJECZNICA, "Pieczywo")?.line).toMatch(/^You: .*pc.* · Partner: .*pc/);

    const oats = storedMeal(F5_SOLVED, mealAt(F5, 0, "second_breakfast"));
    const fruit = oats.components.find((c) => c.name === "Owoce");
    expect(fruit?.split.kind).toBe("per_ingredient");
    expect(line(OWSIANKA, "Owoce")?.line).toContain("Borówki amerykańskie mrożone");
  });

  it("warns about a broken bound on an exact section only", () => {
    const solution = F5_SOLVED[0];
    if (!solution) throw new Error("no day 0");
    const bounded = { ...F5_SOLVED, 0: { ...solution, boundsViolated: true } };
    expect(cook(F5, "2031-01-19-evening", bounded).sections[0].boundsWarning).toBe(true);
    expect(cook(F5, "2031-01-19-evening", F5_SOLVED).sections[0].boundsWarning).toBe(F5_SOLVED[0]?.boundsViolated);
    expect(cook(F5, "2031-01-19-evening", {}).sections[0].boundsWarning).toBe(false);
  });

  it("falls back to base amounts, with no portions, when nothing is current", () => {
    const plan = planOf(F5);
    for (const session of buildCookingSessions({ plan, recipeSteps: SEED_RECIPE_STEPS }).sessions) {
      const view = cook(F5, session.key, {});
      expect(view.sections.every((s) => s.source === "estimate")).toBe(true);
      expect(view.steps.every((step) => step.portions === null)).toBe(true);
      expect(view.sections.flatMap((s) => s.servingNotes.flatMap((n) => n.portions))).toEqual([]);
      expect(
        view.sections
          .flatMap((s) => s.entries.flatMap((e) => e.batches.flatMap((b) => b.components)))
          .every((c) => c.portion === null),
      ).toBe(true);
      expect(view.diagnostics).toEqual({ dishesFellBack: [], missingRecipeIds: [] });
    }

    const view = cook(F5, "2031-01-19-evening", {});
    const curry = view.sections[0].entries.find((entry) => entry.recipeId === CURRY);
    expect(curry?.batches[0].components.map((c) => c.ingredients.map((i) => i.amount))).toEqual([
      ["160 g", "1 g"],
      ["400 g", "4 g", "2 g", "10 g"],
      ["200 g", "100 g", "2 pcs (10 g)", "200 g", "6 g", "1 g"],
    ]);
    expect(stepById(view, "401").amounts[0].ingredients.map((i) => i.amount)).toEqual(["160 g", "1 g"]);
    expect(stepById(view, "404").portions).toBeNull();
  });

  it("falls back for one dish whose current row is missing", () => {
    const solution = F5_SOLVED[0];
    if (!solution) throw new Error("no day 0");
    const missing = {
      ...F5_SOLVED,
      0: { ...solution, meals: solution.meals.filter((meal) => meal.mealId !== MON_LUNCH.mealId) },
    };
    const view = cook(F5, "2031-01-19-evening", missing);
    expect(view.sections[0].source).toBe("exact");
    expect(view.diagnostics.dishesFellBack).toEqual([MON_LUNCH.dishId]);
    expect(stepById(view, "404").portions).toBeNull();
    expect(stepById(view, "401").amounts[0].ingredients.map((i) => i.amount)).toEqual(["160 g", "1 g"]);
    expect(stepById(view, "604").portions).not.toBeNull();
  });

  it("decides exact or estimate per section", () => {
    const view = cook(F5, "2031-01-20-evening", { 1: F5_SOLVED[1] });
    expect(view.sections.map((s) => [s.kind, s.source, s.sourceDayIndex])).toEqual([
      ["now", "estimate", 0],
      ["ahead", "exact", 1],
    ]);
  });

  it("gives the partner the same numbers with You and Partner swapped", () => {
    const a = cook(F5, "2031-01-19-evening", F5_SOLVED, USER_A);
    const b = cook(F5, "2031-01-19-evening", F5_SOLVED, USER_B);
    const lines = (view: CookModeView) =>
      view.steps.flatMap((step) => (step.portions ?? []).flatMap((p) => p.lines.map((l) => l.line)));
    const aLines = lines(a);
    const bLines = lines(b);
    expect(aLines.length).toBeGreaterThan(0);
    expect(bLines).toHaveLength(aLines.length);
    for (const [i, line] of aLines.entries()) {
      expect(parseShares(bLines[i], false)).toEqual(parseShares(line, true));
    }
    expect(b.steps.map((s) => s.amounts)).toEqual(a.steps.map((s) => s.amounts));
  });

  it("numbers steps across Tonight then For tomorrow in merged order", () => {
    const meals = F5;
    const plan = planOf(meals);
    const session = buildCookingSessions({ plan, recipeSteps: SEED_RECIPE_STEPS }).sessions.find(
      (s) => s.key === "2031-01-20-evening",
    );
    const view = cook(meals, "2031-01-20-evening", F5_SOLVED);
    expect(view.steps.map((s) => s.number)).toEqual(view.steps.map((_, i) => i + 1));
    expect(view.steps.map((s) => s.id)).toEqual(session?.sections.flatMap((s) => s.steps.map((step) => step.id)));
    expect(view.steps.map((s) => s.sectionKind)).toEqual([
      "now",
      ...Array<string>(view.steps.length - 1).fill("ahead"),
    ]);
  });
});

describe("cook mode display text", () => {
  it("formats counters, notes, headings and paths", () => {
    expect(formatStepCounter(2, 12)).toBe("Step 2 of 12");
    expect(formatCookExactNote("Monday")).toBe("Amounts and portions from the day solve of Monday.");
    expect(formatCookEstimateNote("Monday")).toBe(
      "Estimate for Monday: recipe base amounts and no portions yet — solve Monday to get them.",
    );
    expect(formatBatchHeading([{ dayIndex: 0, mealType: "lunch" }], "2031-01-20")).toBe("For Monday Lunch");
    expect(cookPath("2031-01-20", "2031-01-19-evening")).toBe(
      "/plan/sessions/cook?start=2031-01-20&session=2031-01-19-evening",
    );
    expect(cookPath("2031-01-20", "2031-01-19-evening", 3)).toBe(
      "/plan/sessions/cook?start=2031-01-20&session=2031-01-19-evening&step=3",
    );
  });
});
