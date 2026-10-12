import { describe, expect, it } from "vitest";
import type { DaySolution, MacroTargetsInput, PlanMealRecord, SolveDayInput, SolverRecipe, SolveTier } from "@/types";
import { ingredientMacros } from "@/lib/services/recipe-macros";
import {
  MAX_COMPONENT_RATIO,
  MAX_SCALE,
  MIN_SCALE,
  checkSolvable,
  cookDayIndex,
  groupDayIndexes,
  solveDay,
  solveDayWithDiagnostics,
  solveFingerprint,
  solveGroup,
  solveGroupWithDiagnostics,
  solveGroups,
  statusFor,
} from "@/lib/services/macro-solver";
import {
  CURRY,
  F1,
  F2,
  F3,
  F4,
  F5,
  F5_UNSHARED,
  F6,
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
  shareDish,
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

// Every day's solution of a solve group, in day order.
function solvedGroup(meals: PlanMealRecord[], targets: Record<string, MacroTargetsInput> = {}): DaySolution[] {
  const result = solveGroup(input(meals, targets));
  if (result.kind !== "solution") throw new Error(`unexpected ${result.reason}`);
  return result.days.map((d) => d.solution);
}

// Single-day fixtures and the cross-day group the generic invariants run over.
const FIXTURES = { F1, F2, F3, F4, F5 };

const MACROS = ["kcal", "proteinG", "fatG", "carbsG"] as const;

// The F6 performance guard's measured solve time (see "performance" below), on the S-08 dev
// machine: first 157–165 ms (F2 4.1–4.6 ms in isolation but ~2.5 ms warm in the full suite, ~63× —
// over budget), then ~41 ms (F2 ~1.1 ms) after the cached per-state contributions in evaluate().
// Re-measured at 32–42 ms after the per-dish ratio index (statesByDish), so the pin stays.
const F6_MEASURED_MS = 41;
// Shared CI runners are often several times slower than the dev machine that set the pin, and this
// guard has no CI record yet; the relative ≤ 60× budget is the robust gate.
const CI_RUNNER_SLOWDOWN = 4;

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
      sharedAcrossDays: false,
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
    const owsianka = solution.meals.find((m) => m.mealId === F4.find((f) => f.recipeId === OWSIANKA)?.mealId);
    const twarozek = solution.meals.find((m) => m.mealId === F4.find((f) => f.recipeId === TWAROZEK)?.mealId);
    expect(owsianka?.eaterUserIds).toEqual([USER_A]);
    expect(twarozek?.eaterUserIds).toEqual([USER_B]);
    for (const component of [...(owsianka?.components ?? []), ...(twarozek?.components ?? [])]) {
      expect(component.split.kind).toBe("all");
    }
  });
});

describe("determinism", () => {
  for (const [name, meals] of Object.entries(FIXTURES)) {
    it(`${name}: shuffled input gives deep-equal output and the same fingerprint`, async () => {
      expect(solveGroup(shuffledInput(meals))).toStrictEqual(solveGroup(input(meals)));
      expect(await solveFingerprint(shuffledInput(meals))).toBe(await solveFingerprint(input(meals)));
    });
  }

  it("the fingerprint is lowercase hex SHA-256 and changes on an eater-only edit", async () => {
    const fingerprint = await solveFingerprint(input(F1));
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const edited = F1.map((m) => (m.recipeId === OWSIANKA ? { ...m, eaterUserId: USER_A } : m));
    expect(await solveFingerprint(input(edited))).not.toBe(fingerprint);
  });

  it("the fingerprint changes when a target changes", async () => {
    expect(await solveFingerprint(input(F1, { [USER_B]: { ...TARGET_B, proteinG: 121 } }))).not.toBe(
      await solveFingerprint(input(F1)),
    );
  });

  it("the fingerprint changes when only the grouping changes, and not on a new dish id", async () => {
    const shared = await solveFingerprint(input(F5));
    expect(shared).toMatch(/^[0-9a-f]{64}$/);
    expect(await solveFingerprint(input(F5_UNSHARED))).not.toBe(shared);
    const renamedDish = F5.map((m) => (m.mealType === "lunch" ? { ...m, dishId: "dish-recreated-by-save" } : m));
    expect(await solveFingerprint(input(renamedDish))).toBe(shared);
  });

  it("the fingerprint is equal for both days of a group", async () => {
    const groupOf = (dayIndex: number) => {
      const group = solveGroups(shuffle(F5)).find((g) => g.some((m) => m.dayIndex === dayIndex));
      if (!group) throw new Error(`no group for day ${dayIndex}`);
      return group;
    };
    const day0 = await solveFingerprint(shuffledInput(groupOf(0)));
    expect(day0).toMatch(/^[0-9a-f]{64}$/);
    expect(await solveFingerprint(shuffledInput(groupOf(1)))).toBe(day0);
  });

  it("the fingerprint changes when a recipe, component or product is renamed", async () => {
    const base = await solveFingerprint(input(F1));
    const curry = SEED_RECIPES[CURRY];
    const renamed = (recipe: SolverRecipe) =>
      solveFingerprint({ ...input(F1), recipes: { ...SEED_RECIPES, [CURRY]: recipe } });
    expect(await renamed({ ...curry, name: "Curry" })).not.toBe(base);
    expect(
      await renamed({ ...curry, components: curry.components.map((c, i) => (i === 0 ? { ...c, name: "Rice" } : c)) }),
    ).not.toBe(base);
    expect(
      await renamed({
        ...curry,
        components: curry.components.map((c, i) =>
          i === 0
            ? { ...c, ingredients: c.ingredients.map((g, j) => (j === 0 ? { ...g, productName: "Rice" } : g)) }
            : c,
        ),
      }),
    ).not.toBe(base);
  });
});

describe("solve groups", () => {
  it("unshared days are one group per day", () => {
    const groups = solveGroups(F5_UNSHARED);
    expect(groups.map(groupDayIndexes)).toEqual([[0], [1]]);
    expect(solveGroups(F1).map(groupDayIndexes)).toEqual([[0]]);
  });

  it("a shared dish joins its days into one group", () => {
    const groups = solveGroups(F5);
    expect(groups).toHaveLength(1);
    expect(groupDayIndexes(groups[0])).toEqual([0, 1]);
    expect(groups[0]).toHaveLength(10);
  });

  it("joins transitively: dish A on days 0–1 and dish B on days 1–2 make one group of three", () => {
    expect(solveGroups(F6).map(groupDayIndexes)).toEqual([[0, 1, 2]]);
  });

  it("a dish is cooked on its lowest day", () => {
    const lunches = F5.filter((m) => m.mealType === "lunch");
    expect(cookDayIndex([...lunches].reverse())).toBe(0);
  });

  it("solveDay refuses a multi-day group", () => {
    expect(() => solveDay(input(F5))).toThrow(/use solveGroup/);
  });

  it("meals that are not one group are refused", () => {
    expect(() => solveGroup(input(F5_UNSHARED))).toThrow(/2 solve groups/);
  });
});

describe("cross-day batch (F5)", () => {
  const [day0, day1] = solvedGroup(F5);
  const lunchOf = (solution: DaySolution) => solution.meals.find((m) => m.mealType === "lunch");

  it("both days land within tolerance with the same tier and explanation", () => {
    expect([10, 15]).toContain(day0.requiredTier);
    expect(day1.requiredTier).toBe(day0.requiredTier);
    expect(day1.explanation).toEqual(day0.explanation);
    expect(day0.maxDeviationPct).toBeLessThanOrEqual(day0.requiredTier ?? 0);
    expect(day1.maxDeviationPct).toBeLessThanOrEqual(day0.requiredTier ?? 0);
  });

  it("the shared lunch is one batch cooked on day 0 with identical amounts on both days", () => {
    const [lunch0, lunch1] = [lunchOf(day0), lunchOf(day1)];
    const dishId = F5.find((m) => m.dayIndex === 0 && m.mealType === "lunch")?.dishId;
    expect(lunch0?.batch).toEqual({ dishId, cookDayIndex: 0, mealIds: [lunch0?.mealId, lunch1?.mealId] });
    expect(lunch1?.batch).toEqual(lunch0?.batch);
    expect(lunch1?.components.map((c) => c.ingredients.map((i) => i.amountG))).toEqual(
      lunch0?.components.map((c) => c.ingredients.map((i) => i.amountG)),
    );
    for (const component of lunch0?.components ?? []) {
      expect(component.split.shares).toHaveLength(4);
      const pairs = new Set(component.split.shares.map((s) => `${s.mealId}|${s.userId}`));
      expect(pairs.size).toBe(4);
      expect(component.split.shares.map((s) => s.dayIndex)).toEqual([0, 0, 1, 1]);
    }
  });

  it("unshared meals carry no batch", () => {
    for (const solution of [day0, day1]) {
      for (const meal of solution.meals) {
        if (meal.mealType !== "lunch") expect(meal.batch).toBeNull();
      }
    }
  });

  it("each day reports only its own people and meals", () => {
    expect(day0.people.map((p) => p.userId)).toEqual([USER_A, USER_B]);
    expect(day1.people.map((p) => p.userId)).toEqual([USER_A, USER_B]);
    expect(day0.meals).toHaveLength(5);
    expect(day1.meals.every((m) => F5.find((f) => f.mealId === m.mealId)?.dayIndex === 1)).toBe(true);
  });

  it("a shared per-person component lists only that meal's eaters in perPerson", () => {
    const meals = shareDish(F5_UNSHARED, [0, "breakfast"], [1, "breakfast"]);
    const [d0, d1] = solvedGroup(meals);
    for (const solution of [d0, d1]) {
      const bread = solution.meals.find((m) => m.mealType === "breakfast")?.components[1];
      expect(bread?.split.shares).toHaveLength(4);
      expect(Object.keys(bread?.ingredients[0].perPerson ?? {}).sort()).toEqual([USER_A, USER_B]);
    }
  });
});

describe("rounding", () => {
  const days = Object.fromEntries(Object.entries(FIXTURES).map(([name, meals]) => [name, solvedGroup(meals)]));
  const all = Object.values(days).flat();
  const f1 = days.F1[0];

  it("eggs in jajecznica are whole pieces", () => {
    const eggs = f1.meals
      .find((m) => m.recipeId === JAJECZNICA)
      ?.components[0].ingredients.find((i) => i.productName.startsWith("Jajko"));
    expect(eggs).toBeDefined();
    expect((eggs?.amountG ?? 0) % 50).toBe(0);
  });

  it("bread is split per person in whole or half slices", () => {
    const bread = f1.meals.find((m) => m.recipeId === JAJECZNICA)?.components[1];
    expect(bread?.split.kind).toBe("pieces");
    const ingredient = bread?.ingredients[0];
    const perPerson = Object.values(ingredient?.perPerson ?? {});
    expect(perPerson).toHaveLength(2);
    for (const grams of perPerson) expect(Number.isInteger(grams / 17.5)).toBe(true);
    expect(perPerson.reduce((a, b) => a + b, 0)).toBeCloseTo(ingredient?.amountG ?? -1, 6);
  });

  it("Owsianka's fruit is split per ingredient: banana in halves, blueberries in grams", () => {
    const fruit = f1.meals.find((m) => m.recipeId === OWSIANKA)?.components[1];
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
    for (const solution of all) {
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
    for (const solution of all) {
      for (const meal of solution.meals) {
        const recipe = recipeById(meal.recipeId);
        const eff = new Map<string, number>();
        for (const component of meal.components) {
          const source = recipe.components.find((c) => c.id === component.id);
          const baseMass = source?.ingredients.reduce((s, i) => s + i.baseAmountG, 0) ?? 1;
          // A shared batch's other servings are checked on their own meal's row.
          for (const share of component.split.shares.filter((s) => s.mealId === meal.mealId)) {
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

  it("splits sum exactly: percent to 100, cooked grams to the cooked total", () => {
    for (const solution of all) {
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

  for (const [name, meals] of Object.entries(FIXTURES)) {
    it(`${name}: the rounded worst deviation is not meaningfully below the LP optimum`, () => {
      const { lpOptimum, worstDeviation } = solveGroupWithDiagnostics(input(meals));
      expect(worstDeviation).toBeGreaterThanOrEqual(lpOptimum - ROUNDING_ALLOWANCE);
    });

    it(`${name}: repair leaves no hard bound violated`, () => {
      const { days, boundsViolation } = solveGroupWithDiagnostics(input(meals));
      expect(boundsViolation).toBe(0);
      for (const { solution } of days) expect(solution.boundsViolated).toBe(false);
    });

    it(`${name}: totals recomputed from the displayed amounts and shares match`, () => {
      for (const solution of solvedGroup(meals)) {
        for (const person of solution.people) {
          const totals = { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 };
          for (const meal of solution.meals) {
            for (const component of meal.components) {
              const share = component.split.shares.find((s) => s.userId === person.userId && s.mealId === meal.mealId);
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
      }
    });
  }

  it("maxDeviationPct is the day's worst |deviation| as a percentage, half-up to 0.1", () => {
    for (const meals of Object.values(FIXTURES)) {
      for (const solution of solvedGroup(meals)) {
        const worst = Math.max(...solution.people.flatMap((p) => MACROS.map((m) => Math.abs(p.deviations[m]))));
        expect(solution.maxDeviationPct).toBeCloseTo(Math.round(worst * 1000) / 10, 9);
      }
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

  it("a bound that rounding cannot honour is flagged, not hidden", () => {
    // One whole 400 g piece is the smallest cookable amount of a 100 g base: 4× the batch, far
    // above MAX_SCALE, and the rounding window [400, 400] leaves repair nothing to try.
    const giant: SolverRecipe = {
      id: "00000000-0000-4000-8000-0000000002ff",
      name: "Giant loaf",
      divisionMode: "per_component",
      components: [
        {
          id: "00000000-0000-4000-8000-0000000003ff",
          position: 1,
          name: "Loaf",
          cookedYieldRatio: null,
          ingredients: [
            {
              id: "00000000-0000-4000-8000-0000000004ff",
              position: 1,
              productName: "Loaf",
              baseAmountG: 100,
              effectiveRoundingStepG: 10,
              minAmountG: null,
              gramsPerPiece: 400,
              allowHalfPieces: false,
              kcalPer100g: 250,
              proteinPer100g: 9,
              fatPer100g: 3,
              carbsPer100g: 48,
            },
          ],
        },
      ],
    };
    const meals = day([giant.id], [USER_A]);
    const { solution, boundsViolation } = solveDayWithDiagnostics({
      ...input(meals),
      recipes: { ...SEED_RECIPES, [giant.id]: giant },
    });
    expect(boundsViolation).toBeGreaterThan(0);
    expect(solution.boundsViolated).toBe(true);
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

  it("a whole dish with more than one component is unsolvable: invalid_recipe", () => {
    const leczo = SEED_RECIPES[LECZO];
    expect(leczo.divisionMode).toBe("whole_dish");
    const second = { ...leczo.components[0], id: "00000000-0000-4000-8000-0000000003fe", position: 2 };
    const recipes = { ...SEED_RECIPES, [LECZO]: { ...leczo, components: [...leczo.components, second] } };
    expect(solveDay({ ...input(F1), recipes })).toEqual({
      kind: "unsolvable",
      reason: "invalid_recipe",
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

  // A regression guard on dev/CI hardware, not the edge CPU gate (that is measured on workerd). The
  // coupled 3-day no-fit group multiplies the LP (~3×), the repair search (~3× states, ~3× moves,
  // 3× budget) and leave-one-dish-out, so its budget is relative to F2 measured in the same run.
  it("the coupled 3-day no-fit group (F6) stays within 60× a single-day F2 solve", () => {
    const RUNS = 10;
    const timeOf = (meals: PlanMealRecord[]) => {
      solveGroup(input(meals)); // warm-up
      const start = performance.now();
      for (let i = 0; i < RUNS; i++) solveGroup(input(meals));
      return (performance.now() - start) / RUNS;
    };
    const days = solvedGroup(F6);
    expect(days).toHaveLength(3);
    expect(days[0].requiredTier).toBeNull();
    const f2 = timeOf(F2);
    const f6 = timeOf(F6);
    expect(f6).toBeLessThanOrEqual(60 * f2);
    // The absolute budget is 3× the pinned value, widened for CI runner speed.
    expect(f6).toBeLessThan(3 * F6_MEASURED_MS * CI_RUNNER_SLOWDOWN);
  });
});
