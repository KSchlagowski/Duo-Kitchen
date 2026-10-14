import { describe, expect, it } from "vitest";
import type {
  CookingSchedule,
  CookingSessionSection,
  MealType,
  PlanMealRecord,
  RecipeDetailStep,
  RecipeSteps,
  SessionSectionKind,
  StepTiming,
} from "@/types";
import {
  buildCookingSessions,
  formatBatchNote,
  formatEntryMeals,
  formatSessionMinutes,
  formatSessionTitle,
  formatStepDuration,
} from "@/lib/services/cooking-sessions";
import { planOf, SEED_RECIPE_STEPS } from "@/lib/services/cooking-sessions.fixtures";
import { cookDayIndex } from "@/lib/services/macro-solver";
import {
  CIASTKA,
  CURRY,
  day,
  F1,
  F2,
  F3,
  F5,
  F5_UNSHARED,
  F6,
  JAJECZNICA,
  KREWETKI,
  LECZO,
  shareDish,
} from "@/lib/services/macro-solver.fixtures";
import { addDays } from "@/lib/services/meal-plans";

// Seed steps (cooking-sessions.fixtures.ts) on plans starting Monday 2031-01-20. Step ids are compared
// by their last three digits: recipe number, then position ("601" is Leczo step 1).

function build(meals: PlanMealRecord[], recipeSteps: Record<string, RecipeSteps> = SEED_RECIPE_STEPS) {
  return buildCookingSessions({ plan: planOf(meals), recipeSteps });
}

function section(schedule: CookingSchedule, key: string, kind: SessionSectionKind): CookingSessionSection {
  const found = schedule.sessions.find((session) => session.key === key)?.sections.find((s) => s.kind === kind);
  if (!found) throw new Error(`no ${kind} section in ${key}`);
  return found;
}

function order(s: CookingSessionSection): string[] {
  return s.steps.map((step) => step.id.slice(-3));
}

function allStepIds(schedule: CookingSchedule): string[] {
  return schedule.sessions.flatMap((session) => session.sections.flatMap(order));
}

function synthetic(id: string, name: string, timings: [StepTiming, number | null][]): RecipeSteps {
  const steps: RecipeDetailStep[] = timings.map(([timing, durationMinutes], i) => ({
    id: `${id}-${i + 1}`,
    position: i + 1,
    instruction: `${name} ${i + 1}`,
    timing,
    componentId: null,
    componentName: null,
    durationMinutes,
  }));
  return { recipeId: id, recipeName: name, steps };
}

function meal(dishId: string, mealType: MealType, recipeId: string): PlanMealRecord {
  return { mealId: `m-${dishId}`, dishId, dayIndex: 0, mealType, recipeId, eaterUserId: null };
}

describe("buildCookingSessions", () => {
  it("schedules the shared F1 plan (worked example)", () => {
    const schedule = build(F5);
    expect(schedule.sessions.map((session) => session.key)).toEqual([
      "2031-01-19-evening",
      "2031-01-20-morning",
      "2031-01-20-evening",
      "2031-01-21-morning",
      "2031-01-21-evening",
    ]);
    expect(schedule.sessions.map((session) => session.sections.map((s) => s.kind))).toEqual([
      ["ahead"],
      ["now"],
      ["now", "ahead"],
      ["now"],
      ["now"],
    ]);

    // Leczo's 60 min chain leads; the curry ties it at 45 and wins on its earlier meal (lunch).
    expect(order(section(schedule, "2031-01-19-evening", "ahead"))).toEqual([
      "601",
      "401",
      "602",
      "603",
      "402",
      "403",
      "404",
      "701",
      "201",
      "702",
      "604",
      "202",
    ]);
    expect(order(section(schedule, "2031-01-20-morning", "now"))).toEqual([
      "101",
      "102",
      "405",
      "103",
      "203",
      "104",
      "703",
    ]);
    expect(order(section(schedule, "2031-01-20-evening", "now"))).toEqual(["605"]);
    expect(order(section(schedule, "2031-01-20-evening", "ahead"))).toEqual([
      "601",
      "602",
      "603",
      "701",
      "201",
      "702",
      "604",
      "202",
    ]);
    expect(order(section(schedule, "2031-01-21-morning", "now"))).toEqual(["101", "102", "103", "203", "104", "703"]);
    expect(order(section(schedule, "2031-01-21-evening", "now"))).toEqual(["605"]);

    const sunday = schedule.sessions[0];
    expect(sunday.knownMinutes).toBe(118);
    expect(sunday.untimedCount).toBe(1);
    expect(sunday.stepCount).toBe(12);
    expect(formatSessionTitle(sunday.date, sunday.part)).toBe("Sunday evening");
    expect(formatSessionMinutes(sunday)).toBe("About 118 min of steps · 1 untimed step");

    const tuesdayMorning = section(schedule, "2031-01-21-morning", "now");
    expect(tuesdayMorning.batchNotes).toHaveLength(1);
    const [note] = tuesdayMorning.batchNotes;
    expect([note.meal.dayIndex, note.meal.mealType]).toEqual([1, "lunch"]);
    expect([note.leadMeal.dayIndex, note.leadMeal.mealType]).toEqual([0, "lunch"]);
    expect(formatBatchNote(note, schedule.startDate)).toBe(
      "Lunch: from the same batch as Monday Lunch — nothing new to cook.",
    );
    expect(schedule.diagnostics).toEqual({ missingRecipeIds: [], recipesWithoutSteps: [], makeAheadDemoted: [] });
  });

  it("cooks a shared batch once, and an unshared one per dish", () => {
    const shared = build(F5);
    const curry = (ids: string[]) => ids.filter((id) => id.startsWith("4"));
    expect(curry(allStepIds(shared)).sort()).toEqual(["401", "402", "403", "404", "405"]);
    const entry = section(shared, "2031-01-19-evening", "ahead").entries.find((e) => e.recipeId === CURRY);
    expect(entry?.meals.map((m) => [m.dayIndex, m.mealType])).toEqual([
      [0, "lunch"],
      [1, "lunch"],
    ]);
    expect(entry && formatEntryMeals(entry, shared.startDate)).toBe("For Monday Lunch and Tuesday Lunch");

    const unshared = build(F5_UNSHARED);
    expect(curry(allStepIds(unshared)).sort()).toEqual([
      "401",
      "401",
      "402",
      "402",
      "403",
      "403",
      "404",
      "404",
      "405",
      "405",
    ]);
    expect(curry(order(section(unshared, "2031-01-20-evening", "ahead")))).toEqual(["401", "402", "403", "404"]);
    expect(unshared.sessions.flatMap((s) => s.sections.flatMap((sec) => sec.batchNotes))).toEqual([]);
  });

  it("cooks a fresh dinner tonight, and its make-ahead part the evening before", () => {
    const monday = build(day([null, null, null, null, KREWETKI]));
    expect(monday.sessions.map((s) => s.key)).toEqual(["2031-01-19-evening", "2031-01-20-evening"]);
    expect(order(section(monday, "2031-01-19-evening", "ahead"))).toEqual(["501"]);
    expect(order(section(monday, "2031-01-20-evening", "now"))).toEqual(["502", "503", "504"]);
    expect(formatSessionMinutes(monday.sessions[0])).toBe("No timed steps · 1 untimed step");

    const wednesday = build(day([null, null, null, null, KREWETKI], [], 2));
    expect(wednesday.sessions.map((s) => s.key)).toEqual(["2031-01-21-evening", "2031-01-22-evening"]);
    expect(wednesday.sessions[1].sections.map((s) => s.kind)).toEqual(["now"]);
  });

  it("places a make-ahead-only recipe the evening before and a fresh-only one in its morning", () => {
    const ciastka = build(day([CIASTKA]));
    expect(ciastka.sessions.map((s) => s.key)).toEqual(["2031-01-19-evening"]);
    expect(order(ciastka.sessions[0].sections[0])).toEqual(["301", "302", "303", "304", "305"]);

    const jajecznica = build(day([JAJECZNICA]));
    expect(jajecznica.sessions.map((s) => s.key)).toEqual(["2031-01-20-morning"]);
  });

  it("merges two dishes of one recipe in one section, never across sections", () => {
    const schedule = build(day([null, null, LECZO, null, LECZO]));
    const ahead = section(schedule, "2031-01-19-evening", "ahead");
    expect(ahead.entries).toHaveLength(1);
    expect(ahead.entries[0].dishIds).toHaveLength(2);
    expect(order(ahead)).toEqual(["601", "602", "603", "604"]);
    expect(formatEntryMeals(ahead.entries[0], schedule.startDate)).toBe(
      "For Monday Lunch and Monday Dinner · 2 batches",
    );

    const morning = section(schedule, "2031-01-20-morning", "now");
    const tonight = section(schedule, "2031-01-20-evening", "now");
    expect(morning.entries.map((e) => e.dishIds.length)).toEqual([1]);
    expect(tonight.entries.map((e) => e.dishIds.length)).toEqual([1]);
    expect(order(morning)).toEqual(["605"]);
    expect(order(tonight)).toEqual(["605"]);
  });

  it("notes a later meal of a batch only outside the section that already names it", () => {
    const sameMorning = build(shareDish(day([null, null, CURRY, CURRY, null]), [0, "lunch"], [0, "afternoon_snack"]));
    const morning = section(sameMorning, "2031-01-20-morning", "now");
    expect(morning.entries).toHaveLength(1);
    expect(formatEntryMeals(morning.entries[0], sameMorning.startDate)).toBe(
      "For Monday Lunch and Monday Afternoon snack",
    );
    expect(sameMorning.sessions.flatMap((s) => s.sections.flatMap((sec) => sec.batchNotes))).toEqual([]);

    const lunchAndDinner = build(shareDish(day([null, null, CURRY, null, CURRY]), [0, "lunch"], [0, "dinner"]));
    const tonight = section(lunchAndDinner, "2031-01-20-evening", "now");
    expect(tonight.entries).toEqual([]);
    expect(tonight.steps).toEqual([]);
    expect(tonight.batchNotes.map((note) => formatBatchNote(note, lunchAndDinner.startDate))).toEqual([
      "Dinner: from the same batch as Monday Lunch — nothing new to cook.",
    ]);
  });

  it("cooks a make-ahead step after a fresh one fresh", () => {
    const recipe = synthetic("syn", "Synthetic", [
      ["make_ahead", 5],
      ["fresh", 5],
      ["make_ahead", 5],
    ]);
    const schedule = build([meal("d1", "lunch", "syn")], { syn: recipe });
    expect(section(schedule, "2031-01-19-evening", "ahead").steps.map((s) => s.id)).toEqual(["syn-1"]);
    expect(section(schedule, "2031-01-20-morning", "now").steps.map((s) => s.id)).toEqual(["syn-2", "syn-3"]);
    expect(schedule.diagnostics.makeAheadDemoted).toEqual(["syn-3"]);
  });

  it("keeps a recipe without steps, or missing from the read, as an entry", () => {
    const steps = { ...SEED_RECIPE_STEPS, empty: synthetic("empty", "Empty", []) };
    const schedule = build([meal("d1", "breakfast", "empty"), meal("d2", "lunch", "gone")], steps);
    const morning = section(schedule, "2031-01-20-morning", "now");
    expect(morning.entries.map((e) => [e.recipeId, e.recipeName, e.hasSteps])).toEqual([
      ["empty", "Empty", false],
      ["gone", null, false],
    ]);
    expect(schedule.diagnostics).toEqual({
      missingRecipeIds: ["gone"],
      recipesWithoutSteps: ["empty"],
      makeAheadDemoted: [],
    });

    const only = build([meal("d1", "dinner", "empty")], steps);
    expect(only.sessions.map((s) => s.key)).toEqual(["2031-01-20-evening"]);
    expect(only.sessions[0].sections[0].entries.map((e) => e.hasSteps)).toEqual([false]);
    expect(only.sessions[0].stepCount).toBe(0);
    expect(formatSessionMinutes(only.sessions[0])).toBe("No timed steps");
    expect(only.diagnostics.recipesWithoutSteps).toEqual(["empty"]);
  });

  it("keeps every batch note of a dish without fresh steps", () => {
    const sameDay = build(shareDish(day([CIASTKA, CIASTKA]), [0, "breakfast"], [0, "second_breakfast"]));
    expect(order(section(sameDay, "2031-01-19-evening", "ahead"))).toEqual(["301", "302", "303", "304", "305"]);
    expect(
      section(sameDay, "2031-01-20-morning", "now").batchNotes.map((note) => formatBatchNote(note, sameDay.startDate)),
    ).toEqual(["Second breakfast: from the same batch as Monday Breakfast — nothing new to cook."]);
  });

  it("breaks equal chains by earliest meal, then Polish name, then dish id", () => {
    const fresh = (id: string, name: string) => synthetic(id, name, [["fresh", 5]]);
    const steps = {
      early: fresh("early", "Zupa"),
      late: fresh("late", "Ananas"),
      mata: fresh("mata", "Mata"),
      lata: fresh("lata", "Łata"),
      twinA: fresh("twinA", "Twin"),
      twinB: fresh("twinB", "Twin"),
    };
    const ids = (meals: PlanMealRecord[]) =>
      build(meals, steps).sessions[0].sections[0].steps.map((step) => step.recipeId);

    // Breakfast before second breakfast, whatever the names.
    expect(ids([meal("d1", "second_breakfast", "late"), meal("d2", "breakfast", "early")])).toEqual(["early", "late"]);
    // Same slot (only a synthetic plan can do that): "Ł" sorts after "L" and before "M" in Polish.
    expect(ids([meal("d1", "breakfast", "mata"), meal("d2", "breakfast", "lata")])).toEqual(["lata", "mata"]);
    // Same slot and name: the smaller dish id.
    expect(ids([meal("d2", "breakfast", "twinA"), meal("d1", "breakfast", "twinB")])).toEqual(["twinB", "twinA"]);
  });

  it("does not depend on input order", () => {
    const reversed = Object.fromEntries(
      Object.entries(SEED_RECIPE_STEPS).map(([id, recipe]) => [id, { ...recipe, steps: [...recipe.steps].reverse() }]),
    );
    for (const meals of [F5, F6]) {
      expect(build([...meals].reverse(), reversed)).toEqual(build(meals));
    }
  });

  it("schedules every make-ahead part the evening before the solver's cook day", () => {
    for (const meals of [F1, F2, F3, F5, F5_UNSHARED, F6]) {
      const schedule = build(meals);
      const dishIds = [...new Set(meals.map((m) => m.dishId))];
      for (const dishId of dishIds) {
        const dishMeals = meals.filter((m) => m.dishId === dishId);
        const hasAhead = SEED_RECIPE_STEPS[dishMeals[0].recipeId].steps.some((s) => s.timing === "make_ahead");
        const dates = schedule.sessions
          .filter((session) =>
            session.sections.some((s) => s.kind === "ahead" && s.entries.some((e) => e.dishIds.includes(dishId))),
          )
          .map((session) => session.date);
        expect(dates).toEqual(hasAhead ? [addDays(schedule.startDate, cookDayIndex(dishMeals) - 1)] : []);
      }
    }
  });

  it("has no sessions for an empty plan", () => {
    expect(build([]).sessions).toEqual([]);
  });
});

describe("cooking session display text", () => {
  it("formats minutes, durations, meals and notes", () => {
    expect(formatSessionMinutes({ knownMinutes: 10, untimedCount: 0 })).toBe("About 10 min of steps");
    expect(formatSessionMinutes({ knownMinutes: 10, untimedCount: 2 })).toBe("About 10 min of steps · 2 untimed steps");
    expect(formatSessionMinutes({ knownMinutes: 0, untimedCount: 2 })).toBe("No timed steps · 2 untimed steps");
    expect(formatStepDuration(15)).toBe("15 min");
    expect(formatStepDuration(null)).toBe("no set time");
    expect(formatSessionTitle("2031-01-20", "morning")).toBe("Monday morning");
    expect(
      formatEntryMeals(
        {
          dishIds: ["d1", "d2"],
          meals: [
            { mealId: "m1", dishId: "d1", dayIndex: 0, mealType: "lunch" },
            { mealId: "m2", dishId: "d2", dayIndex: 1, mealType: "lunch" },
          ],
        },
        "2031-01-20",
      ),
    ).toBe("For Monday Lunch and Tuesday Lunch · 2 batches");
    expect(
      formatBatchNote(
        {
          meal: { mealId: "m2", dishId: "d1", dayIndex: 2, mealType: "dinner" },
          recipeName: "Leczo z kiełbasą",
          leadMeal: { mealId: "m1", dishId: "d1", dayIndex: 1, mealType: "dinner" },
        },
        "2031-01-20",
      ),
    ).toBe("Dinner: from the same batch as Tuesday Dinner — nothing new to cook.");
  });
});
