import { describe, expect, it } from "vitest";
import type { DaySolution, MacroTargetsInput, PlanMealRecord, SolveDayInput, SolverRecipe, SolveTier } from "@/types";
import { ingredientMacros } from "@/lib/services/recipe-macros";
import {
  MAX_COMPONENT_RATIO,
  MAX_SCALE,
  MIN_SCALE,
  checkSolvable,
  dayFingerprint,
  solveDay,
  solveDayWithDiagnostics,
  statusFor,
} from "@/lib/services/macro-solver";
import {
  F1,
  F2,
  F3,
  F4,
  JAJECZNICA,
  LECZO,
  OWSIANKA,
  SEED_RECIPES,
  TARGET_A,
  TARGET_B,
  TWAROZEK,
  USER_A,
  USER_B,
  day,
} from "@/lib/services/macro-solver.fixtures";

function input(meals: PlanMealRecord[], targets: Record<string, MacroTargetsInput> = {}): SolveDayInput {
  return {
    memberIds: [USER_A, USER_B],
    meals,
    recipes: SEED_RECIPES,
    targets: { [USER_A]: TARGET_A, [USER_B]: TARGET_B, ...targets },
  };
}

function solved(meals: PlanMealRecord[], targets: Record<string, MacroTargetsInput> = {}): DaySolution {
  const result = solveDay(input(meals, targets));
  if (result.kind !== "solution") throw new Error(`unexpected ${result.reason}`);
  return result.solution;
}

const MACROS = ["kcal", "proteinG", "fatG", "carbsG"] as const;

// A fixed permutation (reverse, then rotate by one), so "shuffled" is itself deterministic.
function shuffle<T>(list: readonly T[]): T[] {
  const reversed = [...list].reverse();
  return reversed.length > 1 ? [...reversed.slice(1), reversed[0]] : reversed;
}

function shuffledInput(meals: PlanMealRecord[]): SolveDayInput {
  const recipes: Record<string, SolverRecipe> = {};
  for (const recipe of shuffle(Object.values(SEED_RECIPES))) {
    recipes[recipe.id] = {
      ...recipe,
      components: shuffle(recipe.components).map((c) => ({ ...c, ingredients: shuffle(c.ingredients) })),
    };
  }
  return {
    memberIds: [USER_B, USER_A],
    meals: shuffle(meals),
    recipes,
    targets: { [USER_B]: TARGET_B, [USER_A]: TARGET_A },
  };
}

const recipeById = (id: string) => SEED_RECIPES[id];
const baseOf = (recipeId: string, componentId: string, ingredientId: string) =>
  recipeById(recipeId)
    .components.find((c) => c.id === componentId)
    ?.ingredients.find((i) => i.id === ingredientId);

describe("fixture days", () => {
  it("F1 (mixed day) fits within ±10%", () => {
    expect(solved(F1).requiredTier).toBe(10);
  });

  it("F2 (whole-dish only) has no fit and blames the earlier Leczo", () => {
    const solution = solved(F2);
    expect(solution.requiredTier).toBeNull();
    // P10 step 4: the (person, macro) whose LP deviation improves most without the blamed meal is
    // B's carbs (−20.0% → −1.5%), ahead of fat (+21.1% → +11.4%).
    expect(solution.explanation).toEqual({
      kind: "recipe",
      mealId: F2[1].mealId,
      recipeName: "Leczo z kiełbasą",
      macro: "carbsG",
      direction: "under",
    });
  });

  it("F3 (4 whole-dish meals) needs an escalation", () => {
    const solution = solved(F3);
    expect([15, 20]).toContain(solution.requiredTier);
    expect(solution.explanation).toBeNull();
  });

  it("F4 (mixed eaters) fits and gives single-eater meals to that eater", () => {
    const solution = solved(F4);
    expect(solution.requiredTier).toBe(10);
    const owsianka = solution.meals.find((m) => m.recipeId === OWSIANKA);
    const twarozek = solution.meals.find((m) => m.recipeId === TWAROZEK);
    expect(owsianka?.eaterUserIds).toEqual([USER_A]);
    expect(twarozek?.eaterUserIds).toEqual([USER_B]);
    for (const component of [...(owsianka?.components ?? []), ...(twarozek?.components ?? [])]) {
      expect(component.split.kind).toBe("all");
    }
  });
});

describe("determinism", () => {
  for (const [name, meals] of Object.entries({ F1, F2, F3, F4 })) {
    it(`${name}: shuffled input gives deep-equal output and the same fingerprint`, async () => {
      expect(solveDay(shuffledInput(meals))).toStrictEqual(solveDay(input(meals)));
      expect(await dayFingerprint(shuffledInput(meals))).toBe(await dayFingerprint(input(meals)));
    });
  }

  it("the fingerprint is lowercase hex SHA-256 and changes on an eater-only edit", async () => {
    const fingerprint = await dayFingerprint(input(F1));
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const edited = F1.map((m) => (m.recipeId === OWSIANKA ? { ...m, eaterUserId: USER_A } : m));
    expect(await dayFingerprint(input(edited))).not.toBe(fingerprint);
  });

  it("the fingerprint changes when a target changes", async () => {
    expect(await dayFingerprint(input(F1, { [USER_B]: { ...TARGET_B, proteinG: 121 } }))).not.toBe(
      await dayFingerprint(input(F1)),
    );
  });
});

describe("rounding", () => {
  const days = { F1: solved(F1), F2: solved(F2), F3: solved(F3), F4: solved(F4) };

  it("eggs in jajecznica are whole pieces", () => {
    const eggs = days.F1.meals
      .find((m) => m.recipeId === JAJECZNICA)
      ?.components[0].ingredients.find((i) => i.productName.startsWith("Jajko"));
    expect(eggs).toBeDefined();
    expect((eggs?.amountG ?? 0) % 50).toBe(0);
  });

  it("bread is split per person in whole or half slices", () => {
    const bread = days.F1.meals.find((m) => m.recipeId === JAJECZNICA)?.components[1];
    expect(bread?.split.kind).toBe("pieces");
    const ingredient = bread?.ingredients[0];
    const perPerson = Object.values(ingredient?.perPerson ?? {});
    expect(perPerson).toHaveLength(2);
    for (const grams of perPerson) expect(Number.isInteger(grams / 17.5)).toBe(true);
    expect(perPerson.reduce((a, b) => a + b, 0)).toBeCloseTo(ingredient?.amountG ?? -1, 6);
  });

  it("Owsianka's fruit is split per ingredient: banana in halves, blueberries in grams", () => {
    const fruit = days.F1.meals.find((m) => m.recipeId === OWSIANKA)?.components[1];
    expect(fruit?.split.kind).toBe("per_ingredient");
    const [banana, blueberries] = fruit?.ingredients ?? [];
    for (const grams of Object.values(banana.perPerson ?? {})) expect(Number.isInteger(grams / 60)).toBe(true);
    for (const grams of Object.values(blueberries.perPerson ?? {})) {
      expect(grams >= 10 ? grams % 10 === 0 : Number.isInteger(grams) && grams >= 1).toBe(true);
    }
    for (const ingredient of [banana, blueberries]) {
      const sum = Object.values(ingredient.perPerson ?? {}).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(ingredient.amountG, 6);
    }
  });

  it("1 g-step ingredients stay whole grams of at least 1 g and salt never jumps to 10 g", () => {
    for (const solution of Object.values(days)) {
      for (const meal of solution.meals) {
        for (const component of meal.components) {
          for (const ingredient of component.ingredients) {
            const source = baseOf(meal.recipeId, component.id, ingredient.id);
            if (source?.effectiveRoundingStepG !== 1) continue;
            expect(Number.isInteger(ingredient.amountG)).toBe(true);
            expect(ingredient.amountG).toBeGreaterThanOrEqual(1);
            if (source.baseAmountG <= 3) expect(ingredient.amountG).toBeLessThan(10);
          }
        }
      }
    }
  });

  it("no cook amount is 0 and every bound holds on the effective scales", () => {
    for (const solution of Object.values(days)) {
      for (const meal of solution.meals) {
        const recipe = recipeById(meal.recipeId);
        const eff = new Map<string, number>();
        for (const component of meal.components) {
          const source = recipe.components.find((c) => c.id === component.id);
          const baseMass = source?.ingredients.reduce((s, i) => s + i.baseAmountG, 0) ?? 1;
          for (const share of component.split.shares) {
            let eaten = 0;
            for (const ingredient of component.ingredients) {
              expect(ingredient.amountG).toBeGreaterThan(0);
              const grams = ingredient.perPerson?.[share.userId] ?? share.fraction * ingredient.amountG;
              eaten += grams;
              const min = baseOf(meal.recipeId, component.id, ingredient.id)?.minAmountG ?? null;
              if (min !== null) expect(grams).toBeGreaterThanOrEqual(min - 1e-9);
            }
            const scale = eaten / baseMass;
            expect(scale).toBeGreaterThanOrEqual(MIN_SCALE - 1e-9);
            expect(scale).toBeLessThanOrEqual(MAX_SCALE + 1e-9);
            eff.set(`${component.id}|${share.userId}`, scale);
          }
        }
        if (recipe.divisionMode !== "per_component") continue;
        for (const a of meal.components) {
          for (const b of meal.components) {
            if (a === b) continue;
            for (const eater of meal.eaterUserIds) {
              const ea = eff.get(`${a.id}|${eater}`) ?? 0;
              const eb = eff.get(`${b.id}|${eater}`) ?? 0;
              expect(ea).toBeLessThanOrEqual(MAX_COMPONENT_RATIO * eb + 1e-9);
            }
          }
        }
      }
    }
  });

  it("two-eater splits sum exactly: percent to 100, cooked grams to the cooked total", () => {
    for (const solution of Object.values(days)) {
      for (const meal of solution.meals) {
        for (const component of meal.components) {
          const { kind, shares } = component.split;
          const sum = shares.reduce((s, share) => s + (share.value ?? 0), 0);
          if (kind === "percent") expect(sum).toBe(100);
          if (kind === "grams_cooked") {
            const raw = component.ingredients.reduce((s, i) => s + i.amountG, 0);
            expect(sum).toBe(Math.round(raw * (component.cookedYieldRatio ?? 1)));
          }
          expect(shares.reduce((s, share) => s + share.fraction, 0)).toBeCloseTo(1, 9);
        }
      }
    }
  });
});

describe("invariants", () => {
  // Rounding never improves on the LP by more than its own granularity. The strict "rounded ≥ t*"
  // does not hold: choosing between an ingredient's two roundings shifts a component's internal
  // proportions slightly, which the LP (fixed proportions) cannot do. F3 lands 0.4 points under t*.
  const ROUNDING_ALLOWANCE = 0.01;

  for (const [name, meals] of Object.entries({ F1, F2, F3, F4 })) {
    it(`${name}: the rounded worst deviation is not meaningfully below the LP optimum`, () => {
      const { lpOptimum, worstDeviation } = solveDayWithDiagnostics(input(meals));
      expect(worstDeviation).toBeGreaterThanOrEqual(lpOptimum - ROUNDING_ALLOWANCE);
    });

    it(`${name}: totals recomputed from the displayed amounts and shares match`, () => {
      const solution = solved(meals);
      for (const person of solution.people) {
        const totals = { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 };
        for (const meal of solution.meals) {
          for (const component of meal.components) {
            const share = component.split.shares.find((s) => s.userId === person.userId);
            if (!share) continue;
            for (const ingredient of component.ingredients) {
              const source = baseOf(meal.recipeId, component.id, ingredient.id);
              if (!source) throw new Error("unknown ingredient");
              const grams = ingredient.perPerson?.[person.userId] ?? share.fraction * ingredient.amountG;
              const macros = ingredientMacros(grams, source);
              for (const m of MACROS) totals[m] += macros[m];
            }
          }
        }
        for (const m of MACROS) expect(totals[m]).toBeCloseTo(person.totals[m], 6);
      }
    });
  }

  it("maxDeviationPct is the worst |deviation| as a percentage, half-up to 0.1", () => {
    for (const meals of [F1, F2, F3, F4]) {
      const solution = solved(meals);
      const worst = Math.max(...solution.people.flatMap((p) => MACROS.map((m) => Math.abs(p.deviations[m]))));
      expect(solution.maxDeviationPct).toBeCloseTo(Math.round(worst * 1000) / 10, 9);
    }
  });
});

describe("edge inputs", () => {
  it("a zero fat target never produces Infinity or NaN", () => {
    const solution = solved(F1, { [USER_A]: { ...TARGET_A, fatG: 0 } });
    for (const person of solution.people) {
      for (const m of MACROS) expect(Number.isFinite(person.deviations[m])).toBe(true);
    }
    expect(Number.isFinite(solution.maxDeviationPct)).toBe(true);
  });

  it("kcal-mismatched targets on a no-fit day blame the targets, not a recipe", () => {
    const mismatched = { kcal: 3000, proteinG: 150, fatG: 60, carbsG: 200 }; // 4/4/9 → 1940 kcal
    const solution = solved(F2, { [USER_B]: mismatched });
    expect(solution.requiredTier).toBeNull();
    expect(solution.explanation).toEqual({ kind: "targets", userId: USER_B });
  });

  it("an empty day is unsolvable: no_meals", () => {
    expect(solveDay(input([]))).toEqual({ kind: "unsolvable", reason: "no_meals" });
  });

  it("an eater without targets is unsolvable: missing_targets", () => {
    const result = solveDay({ ...input(F1), targets: { [USER_A]: TARGET_A } });
    expect(result).toEqual({ kind: "unsolvable", reason: "missing_targets", userIds: [USER_B] });
  });

  it("a meal for only one person needs only that person's targets", () => {
    const meals = day([JAJECZNICA], [USER_A]);
    const result = solveDay({ ...input(meals), targets: { [USER_A]: TARGET_A } });
    expect(result.kind).toBe("solution");
  });

  it("a recipe with no ingredients is unsolvable: empty_recipe", () => {
    const recipes = {
      ...SEED_RECIPES,
      [LECZO]: { ...SEED_RECIPES[LECZO], components: [{ ...SEED_RECIPES[LECZO].components[0], ingredients: [] }] },
    };
    expect(solveDay({ ...input(F1), recipes })).toEqual({
      kind: "unsolvable",
      reason: "empty_recipe",
      recipeName: "Leczo z kiełbasą",
    });
  });

  it("a meal for a non-member is unsolvable: eater_not_member", () => {
    const meals = day([JAJECZNICA], ["00000000-0000-4000-8000-0000000000ff"]);
    expect(checkSolvable(input(meals))).toEqual({ reason: "eater_not_member" });
  });
});

describe("statusFor", () => {
  const accepted: SolveTier[] = [10, 15, 20];
  const cases: [SolveTier | null, SolveTier, string][] = [];
  for (const required of [10, 15, 20, null] as const) {
    for (const tolerance of accepted) {
      const expected = required === null ? "no_fit" : required <= tolerance ? "solved" : "needs_confirmation";
      cases.push([required, tolerance, expected]);
    }
  }
  it.each(cases)("required %s, accepted %s → %s", (required, tolerance, expected) => {
    const solution = { ...solved(F1), requiredTier: required };
    expect(statusFor(solution, tolerance)).toBe(expected);
  });
});

describe("performance", () => {
  it("100 solves of the no-fit day, leave-one-out included, take under a second", () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) solveDay(input(F2));
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
