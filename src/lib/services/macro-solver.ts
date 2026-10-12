import { solve, type Constraint } from "yalps";
import type {
  DaySolution,
  DaySolutionBatch,
  DaySolutionComponent,
  DaySolutionMeal,
  DaySolutionPerson,
  DaySolveExplanation,
  DaySolveStatus,
  DaySplit,
  MacroKey,
  MacroTargetsInput,
  MacroTotals,
  PlanDayIndex,
  PlanMealRecord,
  SolveDayInput,
  SolveDayResult,
  SolveGroupResult,
  SolverComponent,
  SolverIngredient,
  SolverRecipe,
  SolveTier,
  UnsolvableReason,
} from "@/types";
import { ingredientMacros, roundHalfUp, sumMacros } from "@/lib/services/recipe-macros";
import { macroKcalMismatch } from "@/lib/services/macro-targets";
import { MEAL_TYPES } from "@/lib/services/meal-plans";

// The S-04 macro solver, generalised by S-08 from one day to one solve group (the days a shared
// dish joins; a day that shares nothing is a group of one and solves exactly as before). Pure and
// synchronous apart from solveFingerprint() (crypto.subtle): no Supabase, no I/O, no display text —
// callers map the codes it returns to labels.
//
// Pipeline: a minimax LP over per-serving component scale factors (yalps) → cookable rounding (P7)
// → a bounded deterministic repair of the rounding damage (P8) → the tolerance tier judged on the
// ROUNDED result (P9) → for a group with no fit, the most obstructive dish by leave-one-out (P10).
// Every input is sorted on stable keys first, so the same inputs always give deep-equal output.

// Part of the fingerprint: bump it whenever the algorithm or its constants change, so stored
// results computed by an older version show as out of date.
export const SOLVER_VERSION = 3;

// Each eater eats 0.2×–1.5× of a component's base batch (a base batch serves two).
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 1.5;
// No component of a person's portion may exceed 3× another component of the same recipe.
export const MAX_COMPONENT_RATIO = 3;
// Deviation denominator for a 0 g target (so ±10% means at most 5 g).
export const ZERO_TARGET_REFERENCE_G = 50;
// Weight of the L1 tie-break term next to the minimax term t.
export const TIE_BREAK_WEIGHT = 0.001;
// Accepted repair moves per day of the solve group.
export const MAX_REPAIR_MOVES = 50;

const MACROS: readonly MacroKey[] = ["kcal", "proteinG", "fatG", "carbsG"];
const TIERS: readonly SolveTier[] = [10, 15, 20];
const EPSILON = 1e-9;
const ZERO_TOTALS: MacroTotals = { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 };

// --- input normalisation ---------------------------------------------------------------------

// Code-point order, never locale order: the result must not depend on the runtime's ICU data.
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function slotRank(meal: PlanMealRecord): number {
  return meal.dayIndex * MEAL_TYPES.length + MEAL_TYPES.indexOf(meal.mealType);
}

function sortMeals(meals: readonly PlanMealRecord[]): PlanMealRecord[] {
  return [...meals].sort((a, b) => slotRank(a) - slotRank(b) || compareIds(a.mealId, b.mealId));
}

function byPositionThenId<T extends { position: number; id: string }>(a: T, b: T): number {
  return a.position - b.position || compareIds(a.id, b.id);
}

function sortRecipe(recipe: SolverRecipe): SolverRecipe {
  return {
    ...recipe,
    components: [...recipe.components]
      .sort(byPositionThenId)
      .map((component) => ({ ...component, ingredients: [...component.ingredients].sort(byPositionThenId) })),
  };
}

function eatersOf(meal: PlanMealRecord, memberIds: readonly string[]): string[] {
  return meal.eaterUserId === null ? [...memberIds] : [meal.eaterUserId];
}

// --- solve groups (S-08) ---------------------------------------------------------------------

// The days that must be solved together: meals sharing a dish are joined, and so are meals on the
// same day, transitively. Groups are ordered by their lowest slot, meals within one by slot then id.
export function solveGroups(meals: readonly PlanMealRecord[]): PlanMealRecord[][] {
  const sorted = sortMeals(meals);
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    // The lower root wins, so every root is its group's first meal in sorted order.
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const firstByKey = new Map<string, number>();
  for (const [i, meal] of sorted.entries()) {
    for (const key of [`dish:${meal.dishId}`, `day:${meal.dayIndex}`]) {
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, i);
      else union(first, i);
    }
  }
  const groups = new Map<number, PlanMealRecord[]>();
  for (const [i, meal] of sorted.entries()) {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(meal);
    groups.set(root, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, group]) => group);
}

// The days a group covers, ascending.
export function groupDayIndexes(group: readonly PlanMealRecord[]): PlanDayIndex[] {
  return [...new Set(group.map((meal) => meal.dayIndex))].sort((a, b) => a - b);
}

// The day a dish is cooked on: the lowest day any of its meals is on.
export function cookDayIndex(dishMeals: readonly PlanMealRecord[]): PlanDayIndex {
  return dishMeals.reduce<PlanDayIndex>((lowest, meal) => (meal.dayIndex < lowest ? meal.dayIndex : lowest), 2);
}

interface DayMeal {
  meal: PlanMealRecord;
  recipe: SolverRecipe;
  eaters: string[];
}

// One person eating at one meal: the unit a batch is divided into. `slot` is the (day, person) pair
// whose daily totals the serving counts towards.
interface Serving {
  mealIndex: number;
  dayIndex: PlanDayIndex;
  userId: string;
  slot: string;
}

// One cooked batch of one recipe, eaten by every serving of every meal that shares it.
interface Dish {
  recipe: SolverRecipe;
  mealIndexes: number[];
  servings: Serving[];
}

// A (day, person) pair with its own daily totals.
interface DaySlot {
  key: string;
  dayIndex: PlanDayIndex;
  userId: string;
}

function slotKey(dayIndex: PlanDayIndex, userId: string): string {
  return `${dayIndex}|${userId}`;
}

// Every (day, person) a set of dishes feeds, by day then person.
function slotsOf(dishes: readonly Dish[]): DaySlot[] {
  const slots = new Map<string, DaySlot>();
  for (const dish of dishes) {
    for (const { slot, dayIndex, userId } of dish.servings) {
      if (!slots.has(slot)) slots.set(slot, { key: slot, dayIndex, userId });
    }
  }
  return [...slots.values()].sort((a, b) => a.dayIndex - b.dayIndex || compareIds(a.userId, b.userId));
}

function peopleOf(meals: readonly DayMeal[]): string[] {
  return [...new Set(meals.flatMap((m) => m.eaters))].sort(compareIds);
}

interface Problem {
  meals: DayMeal[];
  dishes: Dish[];
  people: string[];
  slots: DaySlot[];
  days: PlanDayIndex[];
}

// Assumes checkSolvable() passed. Dishes are ordered by their first meal, servings by (slot, user).
function normalise(input: SolveDayInput): Problem {
  const memberIds = [...input.memberIds].sort(compareIds);
  const meals = sortMeals(input.meals).map((meal) => ({
    meal,
    recipe: sortRecipe(input.recipes[meal.recipeId]),
    eaters: eatersOf(meal, memberIds).sort(compareIds),
  }));
  const dishes: Dish[] = [];
  const dishIndex = new Map<string, number>();
  for (const [k, { meal, recipe, eaters }] of meals.entries()) {
    let d = dishIndex.get(meal.dishId);
    if (d === undefined) {
      d = dishes.length;
      dishIndex.set(meal.dishId, d);
      dishes.push({ recipe, mealIndexes: [], servings: [] });
    }
    const dish = dishes[d];
    if (dish.recipe.id !== recipe.id) {
      throw new Error(`macro solver: dish ${meal.dishId} holds more than one recipe`);
    }
    dish.mealIndexes.push(k);
    for (const userId of eaters) {
      dish.servings.push({ mealIndex: k, dayIndex: meal.dayIndex, userId, slot: slotKey(meal.dayIndex, userId) });
    }
  }
  return {
    meals,
    dishes,
    people: peopleOf(meals),
    slots: slotsOf(dishes),
    days: groupDayIndexes(input.meals),
  };
}

// P11: inputs the solver cannot work with, classified without running any LP.
export function checkSolvable(input: SolveDayInput): UnsolvableReason | null {
  if (input.meals.length === 0) {
    return { reason: "no_meals" };
  }
  const memberIds = [...input.memberIds].sort(compareIds);
  const meals = sortMeals(input.meals);
  for (const meal of meals) {
    const eaters = eatersOf(meal, memberIds);
    if (eaters.length === 0 || eaters.some((id) => !memberIds.includes(id))) {
      return { reason: "eater_not_member" };
    }
  }
  const people = [...new Set(meals.flatMap((meal) => eatersOf(meal, memberIds)))].sort(compareIds);
  const missing = people.filter((id) => !(id in input.targets));
  if (missing.length > 0) {
    return { reason: "missing_targets", userIds: missing };
  }
  for (const meal of meals) {
    const recipe = input.recipes[meal.recipeId] as SolverRecipe | undefined;
    if (
      recipe === undefined ||
      recipe.components.length === 0 ||
      recipe.components.some((c) => c.ingredients.length === 0 || c.ingredients.every((i) => i.baseAmountG <= 0))
    ) {
      return { reason: "empty_recipe", recipeName: recipe?.name };
    }
    // The model gives a whole dish one scale per eater only because it has one component; a
    // multi-component whole dish would be scaled per component with no coupling (no ratio bound).
    if (recipe.divisionMode === "whole_dish" && recipe.components.length > 1) {
      return { reason: "invalid_recipe", recipeName: recipe.name };
    }
  }
  return null;
}

// --- shared arithmetic -----------------------------------------------------------------------

function denominator(target: number): number {
  return target === 0 ? ZERO_TARGET_REFERENCE_G : target;
}

function targetOf(t: MacroTargetsInput, macro: MacroKey): number {
  return t[macro];
}

// Memoised per component object: the repair search asks for these thousands of times per solve.
const batchMacrosCache = new WeakMap<SolverComponent, MacroTotals>();
const baseMassCache = new WeakMap<SolverComponent, number>();

function componentBatchMacros(component: SolverComponent): MacroTotals {
  let macros = batchMacrosCache.get(component);
  if (macros === undefined) {
    macros = sumMacros(component.ingredients.map((i) => ingredientMacros(i.baseAmountG, i)));
    batchMacrosCache.set(component, macros);
  }
  return macros;
}

function baseMass(component: SolverComponent): number {
  let mass = baseMassCache.get(component);
  if (mass === undefined) {
    mass = component.ingredients.reduce((sum, i) => sum + i.baseAmountG, 0);
    baseMassCache.set(component, mass);
  }
  return mass;
}

// The per-serving lower bound: the generic minimum scale, raised by every ingredient minimum.
function lowerScale(component: SolverComponent): number {
  return component.ingredients.reduce(
    (lo, i) => (i.minAmountG !== null && i.baseAmountG > 0 ? Math.max(lo, i.minAmountG / i.baseAmountG) : lo),
    MIN_SCALE,
  );
}

function deviationsFor(totals: MacroTotals, targets: MacroTargetsInput): MacroTotals {
  const dev = { ...ZERO_TOTALS };
  for (const m of MACROS) {
    dev[m] = (totals[m] - targetOf(targets, m)) / denominator(targetOf(targets, m));
  }
  return dev;
}

// --- the LP ----------------------------------------------------------------------------------

interface LpResult {
  t: number;
  // Keyed by DaySlot.key: each (day, person)'s own daily deviation.
  deviations: Record<string, MacroTotals>;
  // scale[dishIndex][componentIndex][servingIndex within that dish]
  scale: number[][][];
}

// One scale variable per (dish, component, serving), one totals constraint per (day, person) and
// one minimax t for the whole group: each day aims at its own targets out of a shared supply.
function solveLp(dishes: readonly Dish[], targets: SolveDayInput["targets"]): LpResult {
  const slots = slotsOf(dishes);
  if (slots.length === 0) {
    return { t: 0, deviations: {}, scale: [] };
  }
  const slotIndex = new Map(slots.map((s, i) => [s.key, i]));
  const constraints: [string, Constraint][] = [];
  const variables: [string, [string, number][]][] = [];

  for (const [si, slot] of slots.entries()) {
    for (const m of MACROS) {
      constraints.push([`tot_${si}_${m}`, { equal: targetOf(targets[slot.userId], m) }]);
      constraints.push([`tu_${si}_${m}`, { max: 0 }]);
      constraints.push([`tv_${si}_${m}`, { max: 0 }]);
    }
  }

  for (const [d, { recipe, servings }] of dishes.entries()) {
    const ratioBound = recipe.divisionMode === "per_component" && recipe.components.length > 1;
    for (const [c, component] of recipe.components.entries()) {
      const batch = componentBatchMacros(component);
      const lower = lowerScale(component);
      for (const [s, serving] of servings.entries()) {
        const si = slotIndex.get(serving.slot) ?? -1;
        const key = `b_${d}_${c}_${s}`;
        constraints.push([key, { min: lower, max: MAX_SCALE }]);
        const coefficients: [string, number][] = MACROS.map((m) => [`tot_${si}_${m}`, batch[m]]);
        coefficients.push([key, 1]);
        if (ratioBound) {
          for (const c2 of recipe.components.keys()) {
            if (c2 === c) continue;
            coefficients.push([`r_${d}_${c}_${c2}_${s}`, 1]);
            coefficients.push([`r_${d}_${c2}_${c}_${s}`, -MAX_COMPONENT_RATIO]);
            constraints.push([`r_${d}_${c}_${c2}_${s}`, { max: 0 }]);
          }
        }
        variables.push([`x_${d}_${c}_${s}`, coefficients]);
      }
    }
  }

  const tCoefficients: [string, number][] = [["obj", 1]];
  for (const [si, slot] of slots.entries()) {
    for (const m of MACROS) {
      const d = denominator(targetOf(targets[slot.userId], m));
      tCoefficients.push([`tu_${si}_${m}`, -d], [`tv_${si}_${m}`, -d]);
      variables.push([
        `u_${si}_${m}`,
        [
          [`tot_${si}_${m}`, -1],
          [`tu_${si}_${m}`, 1],
          ["obj", TIE_BREAK_WEIGHT / d],
        ],
      ]);
      variables.push([
        `v_${si}_${m}`,
        [
          [`tot_${si}_${m}`, 1],
          [`tv_${si}_${m}`, 1],
          ["obj", TIE_BREAK_WEIGHT / d],
        ],
      ]);
    }
  }
  variables.push(["t", tCoefficients]);

  const solution = solve(
    { direction: "minimize", objective: "obj", constraints, variables },
    { includeZeroVariables: true },
  );
  if (solution.status !== "optimal") {
    throw new Error(`macro solver LP ended with status ${solution.status}`);
  }
  const values = new Map(solution.variables);
  const value = (key: string) => values.get(key) ?? 0;

  const scale = dishes.map(({ recipe, servings }, d) =>
    recipe.components.map((_, c) => servings.map((_, s) => value(`x_${d}_${c}_${s}`))),
  );
  const totals = new Map(slots.map((slot) => [slot.key, { ...ZERO_TOTALS }]));
  for (const [d, { recipe, servings }] of dishes.entries()) {
    for (const [c, component] of recipe.components.entries()) {
      const batch = componentBatchMacros(component);
      for (const [s, serving] of servings.entries()) {
        const total = totals.get(serving.slot) ?? { ...ZERO_TOTALS };
        for (const m of MACROS) total[m] += scale[d][c][s] * batch[m];
      }
    }
  }
  const deviations: Record<string, MacroTotals> = {};
  for (const slot of slots) {
    deviations[slot.key] = deviationsFor(totals.get(slot.key) ?? ZERO_TOTALS, targets[slot.userId]);
  }
  return { t: value("t"), deviations, scale };
}

// --- rounding (P7) ---------------------------------------------------------------------------

function isPiece(i: SolverIngredient): i is SolverIngredient & { gramsPerPiece: number } {
  return i.gramsPerPiece !== null && i.gramsPerPiece > 0;
}

function pieceUnit(i: SolverIngredient & { gramsPerPiece: number }): number {
  return i.allowHalfPieces ? i.gramsPerPiece / 2 : i.gramsPerPiece;
}

// Whole (or half) pieces never below one unit; grams half-up to the step, except that an amount
// below one step is never rounded up to it — it rounds to the nearest 1 g, at least 1 g.
function roundAmount(raw: number, i: SolverIngredient): number {
  if (isPiece(i)) {
    const unit = pieceUnit(i);
    return round6(Math.max(1, roundHalfUp(raw / unit)) * unit);
  }
  const step = i.effectiveRoundingStepG;
  return raw < step ? Math.max(1, roundHalfUp(raw)) : round6(roundHalfUp(raw / step) * step);
}

// The cookable amounts on either side of an exact amount: the two roundings repair may choose
// between. Repair can never move an amount outside this window, so it fixes rounding damage by
// choosing roundings and shares — it never rewrites a recipe's proportions to beat the LP.
function roundingWindow(exact: number, i: SolverIngredient): [number, number] {
  if (isPiece(i)) {
    const unit = pieceUnit(i);
    const lo = Math.max(1, Math.floor(round6(exact / unit)));
    const hi = Math.max(1, Math.ceil(round6(exact / unit)));
    return [round6(lo * unit), round6(hi * unit)];
  }
  const step = i.effectiveRoundingStepG;
  const e = round6(exact);
  const lo = e < step ? Math.max(1, Math.floor(e)) : round6(Math.floor(e / step) * step);
  const hi = e < step ? Math.max(1, Math.ceil(e)) : round6(Math.ceil(e / step) * step);
  return [lo, hi];
}

// The next legal amount up or down on the same lattice, or null below the one-unit floor.
function stepAmount(amount: number, i: SolverIngredient, direction: 1 | -1): number | null {
  if (isPiece(i)) {
    const unit = pieceUnit(i);
    const next = round6(amount + direction * unit);
    return next >= unit - EPSILON ? next : null;
  }
  const step = i.effectiveRoundingStepG;
  if (direction === 1) {
    return amount < step ? amount + 1 : round6(amount + step);
  }
  if (amount > step) return round6(amount - step);
  const next = amount - 1;
  return next >= 1 ? next : null;
}

// Components holding a served-as-pieces ingredient (bread slices, rolls, banana on porridge) are
// rounded per serving; every other component is rounded as one batch and shared.
function isPerPersonComponent(component: SolverComponent): boolean {
  return component.ingredients.some((i) => i.allowHalfPieces && isPiece(i));
}

type SplitMode = "all" | "grams" | "percent" | "per_person";

interface CompState {
  dishIndex: number;
  component: SolverComponent;
  ratioGroup: boolean;
  servings: Serving[];
  mode: SplitMode;
  // Batch-rounded cook amounts (unused for per_person).
  amounts: number[];
  // per_person: people[servingIndex][ingredientIndex].
  people: number[][];
  // The displayed share of every serving but the last, in cooked grams or whole percentages; the
  // last serving takes the exact remainder.
  splitUnits: number[];
  // The rounding window of each amount, shaped like `amounts` / `people`.
  amountWindows: [number, number][];
  peopleWindows: [number, number][][];
}

function inWindow(amount: number, [lo, hi]: [number, number]): boolean {
  return amount >= lo - EPSILON && amount <= hi + EPSILON;
}

function cookAmounts(cs: CompState): number[] {
  if (cs.mode !== "per_person") return cs.amounts;
  return cs.component.ingredients.map((_, i) => round6(cs.people.reduce((sum, row) => sum + row[i], 0)));
}

function cookedTotal(cs: CompState): number {
  const raw = cs.amounts.reduce((sum, a) => sum + a, 0);
  return roundHalfUp(raw * (cs.component.cookedYieldRatio ?? 1));
}

function splitUnit(cs: CompState): number {
  return cs.mode === "grams" ? 10 : 1;
}

function splitTotal(cs: CompState): number {
  return cs.mode === "grams" ? cookedTotal(cs) : 100;
}

// Share fractions per serving; null when the displayed split is out of range.
function fractions(cs: CompState): number[] | null {
  if (cs.mode === "all" || cs.mode === "per_person") return cs.servings.map(() => 1);
  const total = splitTotal(cs);
  if (total <= 0 || cs.splitUnits.some((u) => u < 0)) return null;
  if (cs.splitUnits.reduce((s, u) => s + u, 0) > total) return null;
  const firsts = cs.splitUnits.map((u) => u / total);
  return [...firsts, firsts.reduce((rest, f) => rest - f, 1)];
}

// Grams of each ingredient eaten at each serving.
function portions(cs: CompState): number[][] | null {
  if (cs.mode === "per_person") return cs.people;
  const f = fractions(cs);
  return f === null ? null : f.map((share) => cs.amounts.map((a) => share * a));
}

function initialState(dishes: readonly Dish[], lp: LpResult): CompState[] {
  const states: CompState[] = [];
  for (const [d, { recipe, servings }] of dishes.entries()) {
    const ratioGroup = recipe.divisionMode === "per_component" && recipe.components.length > 1;
    for (const [c, component] of recipe.components.entries()) {
      const x = lp.scale[d][c];
      const perPerson = isPerPersonComponent(component);
      const batchScale = x.reduce((s, v) => s + v, 0);
      const mode: SplitMode = perPerson
        ? "per_person"
        : servings.length === 1
          ? "all"
          : component.cookedYieldRatio !== null
            ? "grams"
            : "percent";
      const ingredients = component.ingredients;
      const state: CompState = {
        dishIndex: d,
        component,
        ratioGroup,
        servings,
        mode,
        amounts: perPerson ? [] : ingredients.map((i) => roundAmount(batchScale * i.baseAmountG, i)),
        people: perPerson ? x.map((s) => ingredients.map((i) => roundAmount(s * i.baseAmountG, i))) : [],
        splitUnits: [],
        amountWindows: perPerson ? [] : ingredients.map((i) => roundingWindow(batchScale * i.baseAmountG, i)),
        peopleWindows: perPerson ? x.map((s) => ingredients.map((i) => roundingWindow(s * i.baseAmountG, i))) : [],
      };
      if (mode === "grams" || mode === "percent") {
        const unit = splitUnit(state);
        const total = splitTotal(state);
        const units = x
          .slice(0, -1)
          .map((v) => round6(roundHalfUp(((batchScale > 0 ? v / batchScale : 1 / x.length) * total) / unit) * unit));
        // Rounding n−1 shares up can overshoot the total (never with two servings): take the excess
        // off the largest share, one unit at a time.
        while (units.length > 0 && units.reduce((s, u) => s + u, 0) > total + EPSILON) {
          const largest = units.indexOf(Math.max(...units));
          units[largest] = round6(units[largest] - unit);
        }
        state.splitUnits = units;
      }
      states.push(state);
    }
  }
  return states;
}

// --- evaluation and repair (P8) --------------------------------------------------------------

interface Evaluation {
  violation: number;
  max: number;
  sum: number;
  // Keyed by DaySlot.key: each (day, person)'s daily totals.
  totals: Map<string, MacroTotals>;
}

// One state's share of an evaluation: per serving, each ingredient's macros (4 per ingredient, in
// MACROS order), the ingredient-minimum violation terms in ingredient order, and the eaten scale.
// Cached per CompState object: a candidate move replaces one state, so evaluating it recomputes
// only that state's contribution, and evaluate() replays the rest in the original order — the
// floating-point sums are bit-identical to recomputing everything.
interface Contribution {
  servings: { macros: Float64Array; minTerms: number[]; scale: number }[];
}

const contributionCache = new WeakMap<CompState, Contribution | null>();

function contributionOf(cs: CompState): Contribution | null {
  const cached = contributionCache.get(cs);
  if (cached !== undefined) return cached;
  const eaten = portions(cs);
  let result: Contribution | null = null;
  if (eaten !== null) {
    const ingredients = cs.component.ingredients;
    const mass = baseMass(cs.component);
    result = {
      servings: cs.servings.map((_, s) => {
        const macros = new Float64Array(ingredients.length * MACROS.length);
        const minTerms: number[] = [];
        let eatenMass = 0;
        for (const [i, ingredient] of ingredients.entries()) {
          const grams = eaten[s][i];
          eatenMass += grams;
          const values = ingredientMacros(grams, ingredient);
          for (const [j, m] of MACROS.entries()) macros[i * MACROS.length + j] = values[m];
          if (ingredient.minAmountG !== null && grams < ingredient.minAmountG) {
            minTerms.push((ingredient.minAmountG - grams) / mass);
          }
        }
        return { macros, minTerms, scale: eatenMass / mass };
      }),
    };
  }
  contributionCache.set(cs, result);
  return result;
}

function evaluate(
  states: readonly CompState[],
  slots: readonly DaySlot[],
  targets: SolveDayInput["targets"],
): Evaluation | null {
  const totals = new Map(slots.map((slot) => [slot.key, { ...ZERO_TOTALS }]));
  let violation = 0;
  // effScale per (state index, serving) for the ratio bound.
  const eff: number[][] = [];

  for (const cs of states) {
    const contribution = contributionOf(cs);
    if (contribution === null) return null;
    const row: number[] = [];
    for (const [s, serving] of cs.servings.entries()) {
      const total = totals.get(serving.slot) ?? { ...ZERO_TOTALS };
      const { macros, minTerms, scale } = contribution.servings[s];
      for (let k = 0; k < macros.length; k += MACROS.length) {
        total.kcal += macros[k];
        total.proteinG += macros[k + 1];
        total.fatG += macros[k + 2];
        total.carbsG += macros[k + 3];
      }
      for (const term of minTerms) violation += term;
      row.push(scale);
      violation += Math.max(0, MIN_SCALE - scale) + Math.max(0, scale - MAX_SCALE);
    }
    eff.push(row);
  }

  // Every component of a dish has the same serving list, so serving indices line up.
  for (const [a, csA] of states.entries()) {
    if (!csA.ratioGroup) continue;
    for (const [b, csB] of states.entries()) {
      if (a === b || csB.dishIndex !== csA.dishIndex) continue;
      for (const s of csA.servings.keys()) {
        violation += Math.max(0, eff[a][s] - MAX_COMPONENT_RATIO * eff[b][s]);
      }
    }
  }

  let max = 0;
  let sum = 0;
  for (const slot of slots) {
    const dev = deviationsFor(totals.get(slot.key) ?? ZERO_TOTALS, targets[slot.userId]);
    for (const m of MACROS) {
      const abs = Math.abs(dev[m]);
      max = Math.max(max, abs);
      sum += abs;
    }
  }
  return { violation, max, sum, totals };
}

function improves(next: Evaluation, current: Evaluation): boolean {
  if (current.violation > EPSILON) {
    return next.violation < current.violation - EPSILON;
  }
  if (next.violation > EPSILON) return false;
  return (
    next.max < current.max - EPSILON ||
    (Math.abs(next.max - current.max) <= EPSILON && next.sum < current.sum - EPSILON)
  );
}

function replaceAt(states: readonly CompState[], index: number, next: CompState): CompState[] {
  const copy = [...states];
  copy[index] = next;
  return copy;
}

// Candidate moves in the fixed P8 order: ±1 unit per batch ingredient, then one split unit moved
// into serving i out of serving j (ordered pairs, lexicographic; the last serving is the remainder,
// so for two servings this is +1 then −1 on the first share), then ±1 unit per per-serving amount.
function* candidateMoves(states: readonly CompState[]): Generator<CompState[]> {
  for (const [s, cs] of states.entries()) {
    if (cs.mode === "per_person") continue;
    for (const [i, ingredient] of cs.component.ingredients.entries()) {
      for (const direction of [1, -1] as const) {
        const next = stepAmount(cs.amounts[i], ingredient, direction);
        if (next === null || !inWindow(next, cs.amountWindows[i])) continue;
        const amounts = [...cs.amounts];
        amounts[i] = next;
        yield replaceAt(states, s, { ...cs, amounts });
      }
    }
  }
  for (const [s, cs] of states.entries()) {
    if (cs.mode !== "grams" && cs.mode !== "percent") continue;
    const unit = splitUnit(cs);
    const last = cs.servings.length - 1;
    for (const into of cs.servings.keys()) {
      for (const from of cs.servings.keys()) {
        if (into === from) continue;
        const splitUnits = [...cs.splitUnits];
        if (into < last) splitUnits[into] = round6(splitUnits[into] + unit);
        if (from < last) splitUnits[from] = round6(splitUnits[from] - unit);
        yield replaceAt(states, s, { ...cs, splitUnits });
      }
    }
  }
  for (const [s, cs] of states.entries()) {
    if (cs.mode !== "per_person") continue;
    for (const e of cs.servings.keys()) {
      for (const [i, ingredient] of cs.component.ingredients.entries()) {
        for (const direction of [1, -1] as const) {
          const next = stepAmount(cs.people[e][i], ingredient, direction);
          if (next === null || !inWindow(next, cs.peopleWindows[e][i])) continue;
          const people = cs.people.map((row) => [...row]);
          people[e][i] = next;
          yield replaceAt(states, s, { ...cs, people });
        }
      }
    }
  }
}

function repair(
  initial: CompState[],
  slots: readonly DaySlot[],
  targets: SolveDayInput["targets"],
  dayCount: number,
): { states: CompState[]; evaluation: Evaluation } {
  let states = initial;
  let current = evaluate(states, slots, targets);
  if (current === null) {
    throw new Error("macro solver produced an out-of-range split");
  }
  const budget = MAX_REPAIR_MOVES * dayCount;
  let accepted = 0;
  search: while (accepted < budget) {
    for (const candidate of candidateMoves(states)) {
      const next = evaluate(candidate, slots, targets);
      if (next !== null && improves(next, current)) {
        states = candidate;
        current = next;
        accepted++;
        continue search;
      }
    }
    break;
  }
  return { states, evaluation: current };
}

// --- building the result ---------------------------------------------------------------------

function buildSplit(cs: CompState, mealIds: readonly string[]): DaySplit {
  const servingOf = (s: number) => ({
    userId: cs.servings[s].userId,
    mealId: mealIds[cs.servings[s].mealIndex],
    dayIndex: cs.servings[s].dayIndex,
  });
  if (cs.servings.length === 1) {
    return { kind: "all", evenSplit: false, shares: [{ ...servingOf(0), value: null, fraction: 1 }] };
  }
  if (cs.mode === "per_person") {
    const ingredients = cs.component.ingredients;
    const single = ingredients.length === 1 ? ingredients[0] : null;
    const evenSplit = cs.people.every((row) => row.every((a, i) => a === cs.people[0][i]));
    const total = cs.people.reduce((sum, row) => sum + row.reduce((s, a) => s + a, 0), 0);
    if (single !== null && isPiece(single)) {
      return {
        kind: "pieces",
        evenSplit,
        shares: cs.servings.map((_, s) => ({
          ...servingOf(s),
          value: round6(cs.people[s][0] / single.gramsPerPiece),
          fraction: cs.people[s][0] / total,
        })),
      };
    }
    return {
      kind: "per_ingredient",
      evenSplit,
      shares: cs.servings.map((_, s) => ({
        ...servingOf(s),
        value: null,
        fraction: cs.people[s].reduce((sum, a) => sum + a, 0) / total,
      })),
    };
  }
  const total = splitTotal(cs);
  const values = [...cs.splitUnits, round6(total - cs.splitUnits.reduce((s, u) => s + u, 0))];
  return {
    kind: cs.mode === "grams" ? "grams_cooked" : "percent",
    evenSplit: Math.max(...values) - Math.min(...values) < splitUnit(cs),
    shares: cs.servings.map((_, s) => ({ ...servingOf(s), value: values[s], fraction: values[s] / total })),
  };
}

// One component as stored on the row of meal `mealIndex`: the full batch, every serving's share,
// and the per-person amounts of that meal's own eaters.
function buildComponent(cs: CompState, mealIds: readonly string[], mealIndex: number): DaySolutionComponent {
  const cook = cookAmounts(cs);
  return {
    id: cs.component.id,
    name: cs.component.name,
    cookedYieldRatio: cs.component.cookedYieldRatio,
    ingredients: cs.component.ingredients.map((ingredient, i) => ({
      id: ingredient.id,
      productName: ingredient.productName,
      amountG: cook[i],
      gramsPerPiece: ingredient.gramsPerPiece,
      allowHalfPieces: ingredient.allowHalfPieces,
      perPerson:
        cs.mode === "per_person"
          ? Object.fromEntries(
              cs.servings.flatMap((serving, s) =>
                serving.mealIndex === mealIndex ? [[serving.userId, cs.people[s][i]]] : [],
              ),
            )
          : null,
    })),
    split: buildSplit(cs, mealIds),
  };
}

// Worst |deviation| as a percentage, half-up to 0.1 — the value shown, and the one the tier uses.
function displayedMaxPct(maxFraction: number): number {
  return Math.round(Number((maxFraction * 1000).toFixed(6))) / 10;
}

function tierFor(maxDeviationPct: number): SolveTier | null {
  return TIERS.find((tier) => tier >= maxDeviationPct) ?? null;
}

function dishDays(problem: Problem, dish: Dish): PlanDayIndex[] {
  return groupDayIndexes(dish.mealIndexes.map((k) => problem.meals[k].meal));
}

// P10, per dish (S-08): blame inconsistent targets first; otherwise the dish whose removal (every
// meal of it at once) lowers the LP optimum most, with the (day, person, macro) that improved most
// as the reason.
function explain(problem: Problem, targets: SolveDayInput["targets"], full: LpResult): DaySolveExplanation {
  const { dishes, people, slots } = problem;
  const inconsistent = people.find((person) => macroKcalMismatch(targets[person]) !== null);
  if (inconsistent !== undefined) {
    return { kind: "targets", userId: inconsistent };
  }

  let bestIndex = 0;
  let best: LpResult | null = null;
  for (const d of dishes.keys()) {
    const reduced = solveLp(
      dishes.filter((_, j) => j !== d),
      targets,
    );
    if (best === null || reduced.t < best.t - EPSILON) {
      best = reduced;
      bestIndex = d;
    }
  }
  const blamed = dishes[bestIndex];

  let macro: MacroKey = "kcal";
  let slot = slots[0].key;
  let bestImprovement = -Infinity;
  for (const s of slots) {
    const without = best?.deviations[s.key];
    if (without === undefined) continue;
    for (const m of MACROS) {
      const improvement = Math.abs(full.deviations[s.key][m]) - Math.abs(without[m]);
      if (improvement > bestImprovement + EPSILON) {
        bestImprovement = improvement;
        macro = m;
        slot = s.key;
      }
    }
  }
  if (bestImprovement === -Infinity) {
    // Every (day, person) dropped out of the re-solve: fall back to the worst full deviation.
    let worst = -1;
    for (const s of slots) {
      for (const m of MACROS) {
        const abs = Math.abs(full.deviations[s.key][m]);
        if (abs > worst + EPSILON) {
          worst = abs;
          macro = m;
          slot = s.key;
        }
      }
    }
  }

  return {
    kind: "recipe",
    mealId: problem.meals[blamed.mealIndexes[0]].meal.mealId,
    recipeName: blamed.recipe.name,
    macro,
    direction: full.deviations[slot][macro] > 0 ? "over" : "under",
    sharedAcrossDays: dishDays(problem, blamed).length > 1,
  };
}

export interface SolveGroupDiagnostics {
  days: { dayIndex: PlanDayIndex; solution: DaySolution }[];
  // The LP minimax optimum t* (a fraction) and the unrounded worst deviation of the rounded result,
  // both over every (day, person) of the group.
  lpOptimum: number;
  worstDeviation: number;
  // The total bound violation left after repair (0 when every hard bound holds).
  boundsViolation: number;
}

export interface SolveDiagnostics {
  solution: DaySolution;
  lpOptimum: number;
  worstDeviation: number;
  boundsViolation: number;
}

// The full pipeline for one solve group, with the numbers the unit tests compare. Throws on
// unsolvable input and on meals that are not one group.
export function solveGroupWithDiagnostics(input: SolveDayInput): SolveGroupDiagnostics {
  const unsolvable = checkSolvable(input);
  if (unsolvable !== null) {
    throw new Error(`macro solver: unsolvable group (${unsolvable.reason})`);
  }
  const groupCount = solveGroups(input.meals).length;
  if (groupCount !== 1) {
    throw new Error(`macro solver: the meals form ${groupCount} solve groups, not one`);
  }
  const problem = normalise(input);
  const { meals, dishes, slots, days } = problem;
  const lp = solveLp(dishes, input.targets);
  const { states, evaluation } = repair(initialState(dishes, lp), slots, input.targets, days.length);

  const requiredTier = tierFor(displayedMaxPct(evaluation.max));
  const explanation = requiredTier === null ? explain(problem, input.targets, lp) : null;
  const mealIds = meals.map(({ meal }) => meal.mealId);
  const batches: (DaySolutionBatch | null)[] = dishes.map((dish) => {
    if (dish.mealIndexes.length === 1) return null;
    const dishMeals = dish.mealIndexes.map((k) => meals[k].meal);
    return {
      dishId: dishMeals[0].dishId,
      cookDayIndex: cookDayIndex(dishMeals),
      mealIds: dishMeals.map((m) => m.mealId),
    };
  });
  const dishOfMeal = new Map(dishes.flatMap((dish, d) => dish.mealIndexes.map((k) => [k, d])));

  const solutions = days.map((dayIndex) => {
    let dayMax = 0;
    const peopleOut: DaySolutionPerson[] = slots
      .filter((slot) => slot.dayIndex === dayIndex)
      .map(({ key, userId }) => {
        const t = input.targets[userId];
        const targets: MacroTargetsInput = { kcal: t.kcal, proteinG: t.proteinG, fatG: t.fatG, carbsG: t.carbsG };
        const totals = evaluation.totals.get(key) ?? { ...ZERO_TOTALS };
        const deviations = deviationsFor(totals, targets);
        for (const m of MACROS) dayMax = Math.max(dayMax, Math.abs(deviations[m]));
        return { userId, targets, totals, deviations };
      });

    const mealsOut: DaySolutionMeal[] = meals.flatMap(({ meal, recipe, eaters }, k) => {
      if (meal.dayIndex !== dayIndex) return [];
      const d = dishOfMeal.get(k) ?? -1;
      return [
        {
          mealId: meal.mealId,
          mealType: meal.mealType,
          recipeId: recipe.id,
          recipeName: recipe.name,
          divisionMode: recipe.divisionMode,
          eaterUserIds: eaters,
          components: states.filter((cs) => cs.dishIndex === d).map((cs) => buildComponent(cs, mealIds, k)),
          batch: batches[d],
        },
      ];
    });

    const solution: DaySolution = {
      version: 1,
      people: peopleOut,
      meals: mealsOut,
      maxDeviationPct: displayedMaxPct(dayMax),
      requiredTier,
      explanation,
      boundsViolated: evaluation.violation > EPSILON,
    };
    return { dayIndex, solution };
  });

  return {
    days: solutions,
    lpOptimum: lp.t,
    worstDeviation: evaluation.max,
    boundsViolation: evaluation.violation,
  };
}

// The single-day view of solveGroupWithDiagnostics(), for a group of one day.
export function solveDayWithDiagnostics(input: SolveDayInput): SolveDiagnostics {
  const { days, ...rest } = solveGroupWithDiagnostics(input);
  if (days.length !== 1) {
    throw new Error(`macro solver: the meals span ${days.length} days; use solveGroup`);
  }
  return { solution: days[0].solution, ...rest };
}

export function solveGroup(input: SolveDayInput): SolveGroupResult {
  const unsolvable = checkSolvable(input);
  if (unsolvable !== null) {
    return { kind: "unsolvable", ...unsolvable };
  }
  return { kind: "solution", days: solveGroupWithDiagnostics(input).days };
}

// A group of one day.
export function solveDay(input: SolveDayInput): SolveDayResult {
  const unsolvable = checkSolvable(input);
  if (unsolvable !== null) {
    return { kind: "unsolvable", ...unsolvable };
  }
  return { kind: "solution", solution: solveDayWithDiagnostics(input).solution };
}

export function statusFor(solution: DaySolution, acceptedTolerance: SolveTier): DaySolveStatus {
  if (solution.requiredTier === null) return "no_fit";
  return solution.requiredTier <= acceptedTolerance ? "solved" : "needs_confirmation";
}

// --- fingerprint (P12) -----------------------------------------------------------------------

// A SHA-256 hex digest of every solver-relevant input of one solve group, in canonical order —
// including the names the stored result copies. It deliberately leaves out the accepted tolerance,
// so accepting a tier never makes a result look out of date, and the plan_dishes ids, which
// save_meal_plan regenerates on a recipe change: a dish is identified by its member slots instead.
export async function solveFingerprint(input: SolveDayInput): Promise<string> {
  const memberIds = [...input.memberIds].sort(compareIds);
  const meals = sortMeals(input.meals);
  const people = [...new Set(meals.flatMap((meal) => eatersOf(meal, memberIds)))].sort(compareIds);
  const recipeIds = [...new Set(meals.map((meal) => meal.recipeId))].sort(compareIds);
  const dishSlots = new Map<string, number[]>();
  for (const meal of meals) {
    dishSlots.set(meal.dishId, [...(dishSlots.get(meal.dishId) ?? []), slotRank(meal)]);
  }
  const groupLabel = (meal: PlanMealRecord) => [...(dishSlots.get(meal.dishId) ?? [])].sort((a, b) => a - b).join(",");
  const canonical = {
    v: SOLVER_VERSION,
    members: memberIds,
    meals: meals.map((m) => [m.mealId, m.dayIndex, m.mealType, m.recipeId, m.eaterUserId, groupLabel(m)]),
    targets: people.map((p) => {
      const t = input.targets[p] as MacroTargetsInput | undefined;
      return t === undefined ? [p, null] : [p, t.kcal, t.proteinG, t.fatG, t.carbsG];
    }),
    recipes: recipeIds.map((id) => {
      const raw = input.recipes[id] as SolverRecipe | undefined;
      if (raw === undefined) return [id, null];
      const recipe = sortRecipe(raw);
      return [
        id,
        recipe.name,
        recipe.divisionMode,
        recipe.components.map((c) => [
          c.id,
          c.name,
          c.position,
          c.cookedYieldRatio,
          c.ingredients.map((i) => [
            i.id,
            i.productName,
            i.position,
            i.baseAmountG,
            i.effectiveRoundingStepG,
            i.minAmountG,
            i.gramsPerPiece,
            i.allowHalfPieces,
            i.kcalPer100g,
            i.proteinPer100g,
            i.fatPer100g,
            i.carbsPer100g,
          ]),
        ]),
      ];
    }),
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
