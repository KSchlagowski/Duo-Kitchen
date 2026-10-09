import { solve, type Constraint } from "yalps";
import type {
  DaySolution,
  DaySolutionComponent,
  DaySolutionMeal,
  DaySolutionPerson,
  DaySolveExplanation,
  DaySolveStatus,
  DaySplit,
  MacroKey,
  MacroTargetsInput,
  MacroTotals,
  PlanMealRecord,
  SolveDayInput,
  SolveDayResult,
  SolverComponent,
  SolverIngredient,
  SolverRecipe,
  SolveTier,
  UnsolvableReason,
} from "@/types";
import { ingredientMacros, roundHalfUp, sumMacros } from "@/lib/services/recipe-macros";
import { macroKcalMismatch } from "@/lib/services/macro-targets";
import { MEAL_TYPES } from "@/lib/services/meal-plans";

// The S-04 macro solver. Pure and synchronous apart from dayFingerprint() (crypto.subtle): no
// Supabase, no I/O, no display text — callers map the codes it returns to labels.
//
// Pipeline: a minimax LP over per-eater component scale factors (yalps) → cookable rounding (P7) →
// a bounded deterministic repair of the rounding damage (P8) → the tolerance tier judged on the
// ROUNDED result (P9) → for a day with no fit, the most obstructive recipe by leave-one-out (P10).
// Every input is sorted on stable keys first, so the same inputs always give deep-equal output.

// Part of the fingerprint: bump it whenever the algorithm or its constants change, so stored
// results computed by an older version show as out of date.
export const SOLVER_VERSION = 1;

// Each eater eats 0.2×–1.5× of a component's base batch (a base batch serves two).
export const MIN_SCALE = 0.2;
export const MAX_SCALE = 1.5;
// No component of a person's portion may exceed 3× another component of the same recipe.
export const MAX_COMPONENT_RATIO = 3;
// Deviation denominator for a 0 g target (so ±10% means at most 5 g).
export const ZERO_TARGET_REFERENCE_G = 50;
// Weight of the L1 tie-break term next to the minimax term t.
export const TIE_BREAK_WEIGHT = 0.001;
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

function sortMeals(meals: PlanMealRecord[]): PlanMealRecord[] {
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

interface DayMeal {
  meal: PlanMealRecord;
  recipe: SolverRecipe;
  eaters: string[];
}

function peopleOf(meals: readonly DayMeal[]): string[] {
  return [...new Set(meals.flatMap((m) => m.eaters))].sort(compareIds);
}

// Assumes checkSolvable() passed.
function normalise(input: SolveDayInput): { meals: DayMeal[]; people: string[] } {
  const memberIds = [...input.memberIds].sort(compareIds);
  const meals = sortMeals(input.meals).map((meal) => ({
    meal,
    recipe: sortRecipe(input.recipes[meal.recipeId]),
    eaters: eatersOf(meal, memberIds).sort(compareIds),
  }));
  return { meals, people: peopleOf(meals) };
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

function componentBatchMacros(component: SolverComponent): MacroTotals {
  return sumMacros(component.ingredients.map((i) => ingredientMacros(i.baseAmountG, i)));
}

function baseMass(component: SolverComponent): number {
  return component.ingredients.reduce((sum, i) => sum + i.baseAmountG, 0);
}

// The per-eater lower bound: the generic minimum scale, raised by every ingredient minimum.
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
  deviations: Record<string, MacroTotals>;
  // scale[mealIndex][componentIndex][eaterIndex within that meal]
  scale: number[][][];
}

function solveLp(meals: readonly DayMeal[], people: readonly string[], targets: SolveDayInput["targets"]): LpResult {
  if (people.length === 0) {
    return { t: 0, deviations: {}, scale: [] };
  }
  const personIndex = new Map(people.map((p, i) => [p, i]));
  const constraints: [string, Constraint][] = [];
  const variables: [string, [string, number][]][] = [];

  for (const [pi, person] of people.entries()) {
    for (const m of MACROS) {
      constraints.push([`tot_${pi}_${m}`, { equal: targetOf(targets[person], m) }]);
      constraints.push([`tu_${pi}_${m}`, { max: 0 }]);
      constraints.push([`tv_${pi}_${m}`, { max: 0 }]);
    }
  }

  for (const [k, { recipe, eaters }] of meals.entries()) {
    const ratioBound = recipe.divisionMode === "per_component" && recipe.components.length > 1;
    for (const [c, component] of recipe.components.entries()) {
      const batch = componentBatchMacros(component);
      const lower = lowerScale(component);
      for (const eater of eaters) {
        const pi = personIndex.get(eater) ?? -1;
        const key = `b_${k}_${c}_${pi}`;
        constraints.push([key, { min: lower, max: MAX_SCALE }]);
        const coefficients: [string, number][] = MACROS.map((m) => [`tot_${pi}_${m}`, batch[m]]);
        coefficients.push([key, 1]);
        if (ratioBound) {
          for (const c2 of recipe.components.keys()) {
            if (c2 === c) continue;
            coefficients.push([`r_${k}_${c}_${c2}_${pi}`, 1]);
            coefficients.push([`r_${k}_${c2}_${c}_${pi}`, -MAX_COMPONENT_RATIO]);
            constraints.push([`r_${k}_${c}_${c2}_${pi}`, { max: 0 }]);
          }
        }
        variables.push([`x_${k}_${c}_${pi}`, coefficients]);
      }
    }
  }

  const tCoefficients: [string, number][] = [["obj", 1]];
  for (const [pi, person] of people.entries()) {
    for (const m of MACROS) {
      const d = denominator(targetOf(targets[person], m));
      tCoefficients.push([`tu_${pi}_${m}`, -d], [`tv_${pi}_${m}`, -d]);
      variables.push([
        `u_${pi}_${m}`,
        [
          [`tot_${pi}_${m}`, -1],
          [`tu_${pi}_${m}`, 1],
          ["obj", TIE_BREAK_WEIGHT / d],
        ],
      ]);
      variables.push([
        `v_${pi}_${m}`,
        [
          [`tot_${pi}_${m}`, 1],
          [`tv_${pi}_${m}`, 1],
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

  const scale = meals.map(({ recipe, eaters }, k) =>
    recipe.components.map((_, c) => eaters.map((eater) => value(`x_${k}_${c}_${personIndex.get(eater) ?? -1}`))),
  );
  const totals = new Map(people.map((p) => [p, { ...ZERO_TOTALS }]));
  for (const [k, { recipe, eaters }] of meals.entries()) {
    for (const [c, component] of recipe.components.entries()) {
      const batch = componentBatchMacros(component);
      for (const [e, eater] of eaters.entries()) {
        const total = totals.get(eater) ?? { ...ZERO_TOTALS };
        for (const m of MACROS) total[m] += scale[k][c][e] * batch[m];
      }
    }
  }
  const deviations: Record<string, MacroTotals> = {};
  for (const person of people) {
    deviations[person] = deviationsFor(totals.get(person) ?? ZERO_TOTALS, targets[person]);
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
// rounded per person; every other component is rounded as one batch and shared.
function isPerPersonComponent(component: SolverComponent): boolean {
  return component.ingredients.some((i) => i.allowHalfPieces && isPiece(i));
}

type SplitMode = "all" | "grams" | "percent" | "per_person";

interface CompState {
  mealIndex: number;
  component: SolverComponent;
  ratioGroup: boolean;
  eaters: string[];
  mode: SplitMode;
  // Batch-rounded cook amounts (unused for per_person).
  amounts: number[];
  // per_person: people[eaterIndex][ingredientIndex].
  people: number[][];
  // The first eater's displayed share: cooked grams or a whole percentage (two-eater batch only).
  split: number;
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

// Share fractions per eater; null when the displayed split is out of range.
function fractions(cs: CompState): number[] | null {
  if (cs.mode === "all" || cs.mode === "per_person") return cs.eaters.map(() => 1);
  const total = splitTotal(cs);
  if (total <= 0 || cs.split < 0 || cs.split > total) return null;
  const first = cs.split / total;
  return [first, 1 - first];
}

// Grams of each ingredient eaten by each eater.
function portions(cs: CompState): number[][] | null {
  if (cs.mode === "per_person") return cs.people;
  const f = fractions(cs);
  return f === null ? null : f.map((share) => cs.amounts.map((a) => share * a));
}

function initialState(meals: readonly DayMeal[], lp: LpResult): CompState[] {
  const states: CompState[] = [];
  for (const [k, { recipe, eaters }] of meals.entries()) {
    const ratioGroup = recipe.divisionMode === "per_component" && recipe.components.length > 1;
    for (const [c, component] of recipe.components.entries()) {
      const x = lp.scale[k][c];
      const perPerson = isPerPersonComponent(component);
      const batchScale = x.reduce((s, v) => s + v, 0);
      const mode: SplitMode = perPerson
        ? "per_person"
        : eaters.length === 1
          ? "all"
          : component.cookedYieldRatio !== null
            ? "grams"
            : "percent";
      const ingredients = component.ingredients;
      const state: CompState = {
        mealIndex: k,
        component,
        ratioGroup,
        eaters,
        mode,
        amounts: perPerson ? [] : ingredients.map((i) => roundAmount(batchScale * i.baseAmountG, i)),
        people: perPerson ? x.map((s) => ingredients.map((i) => roundAmount(s * i.baseAmountG, i))) : [],
        split: 0,
        amountWindows: perPerson ? [] : ingredients.map((i) => roundingWindow(batchScale * i.baseAmountG, i)),
        peopleWindows: perPerson ? x.map((s) => ingredients.map((i) => roundingWindow(s * i.baseAmountG, i))) : [],
      };
      if (mode === "grams" || mode === "percent") {
        const share = batchScale > 0 ? x[0] / batchScale : 0.5;
        const unit = splitUnit(state);
        state.split = round6(roundHalfUp((share * splitTotal(state)) / unit) * unit);
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
  totals: Map<string, MacroTotals>;
}

function evaluate(
  states: readonly CompState[],
  people: readonly string[],
  targets: SolveDayInput["targets"],
): Evaluation | null {
  const totals = new Map(people.map((p) => [p, { ...ZERO_TOTALS }]));
  let violation = 0;
  // effScale per (state index, eater) for the ratio bound.
  const eff: number[][] = [];

  for (const cs of states) {
    const eaten = portions(cs);
    if (eaten === null) return null;
    const ingredients = cs.component.ingredients;
    const mass = baseMass(cs.component);
    const row: number[] = [];
    for (const [e, eater] of cs.eaters.entries()) {
      const total = totals.get(eater) ?? { ...ZERO_TOTALS };
      let eatenMass = 0;
      for (const [i, ingredient] of ingredients.entries()) {
        const grams = eaten[e][i];
        eatenMass += grams;
        const macros = ingredientMacros(grams, ingredient);
        for (const m of MACROS) total[m] += macros[m];
        if (ingredient.minAmountG !== null && grams < ingredient.minAmountG) {
          violation += (ingredient.minAmountG - grams) / mass;
        }
      }
      const scale = eatenMass / mass;
      row.push(scale);
      violation += Math.max(0, MIN_SCALE - scale) + Math.max(0, scale - MAX_SCALE);
    }
    eff.push(row);
  }

  for (const [a, csA] of states.entries()) {
    if (!csA.ratioGroup) continue;
    for (const [b, csB] of states.entries()) {
      if (a === b || csB.mealIndex !== csA.mealIndex) continue;
      for (const e of csA.eaters.keys()) {
        violation += Math.max(0, eff[a][e] - MAX_COMPONENT_RATIO * eff[b][e]);
      }
    }
  }

  let max = 0;
  let sum = 0;
  for (const person of people) {
    const dev = deviationsFor(totals.get(person) ?? ZERO_TOTALS, targets[person]);
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

// Candidate moves in the fixed P8 order: ±1 unit per batch ingredient, then ±1 split unit, then
// ±1 unit per per-person amount.
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
    for (const direction of [1, -1] as const) {
      yield replaceAt(states, s, { ...cs, split: round6(cs.split + direction * splitUnit(cs)) });
    }
  }
  for (const [s, cs] of states.entries()) {
    if (cs.mode !== "per_person") continue;
    for (const e of cs.eaters.keys()) {
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
  people: readonly string[],
  targets: SolveDayInput["targets"],
): { states: CompState[]; evaluation: Evaluation } {
  let states = initial;
  let current = evaluate(states, people, targets);
  if (current === null) {
    throw new Error("macro solver produced an out-of-range split");
  }
  let accepted = 0;
  search: while (accepted < MAX_REPAIR_MOVES) {
    for (const candidate of candidateMoves(states)) {
      const next = evaluate(candidate, people, targets);
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

function buildSplit(cs: CompState): DaySplit {
  if (cs.eaters.length === 1) {
    return { kind: "all", evenSplit: false, shares: [{ userId: cs.eaters[0], value: null, fraction: 1 }] };
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
        shares: cs.eaters.map((userId, e) => ({
          userId,
          value: round6(cs.people[e][0] / single.gramsPerPiece),
          fraction: cs.people[e][0] / total,
        })),
      };
    }
    return {
      kind: "per_ingredient",
      evenSplit,
      shares: cs.eaters.map((userId, e) => ({
        userId,
        value: null,
        fraction: cs.people[e].reduce((s, a) => s + a, 0) / total,
      })),
    };
  }
  const total = splitTotal(cs);
  const values = [cs.split, round6(total - cs.split)];
  return {
    kind: cs.mode === "grams" ? "grams_cooked" : "percent",
    evenSplit: Math.abs(values[0] - values[1]) < splitUnit(cs),
    shares: cs.eaters.map((userId, e) => ({ userId, value: values[e], fraction: values[e] / total })),
  };
}

function buildComponent(cs: CompState): DaySolutionComponent {
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
        cs.mode === "per_person" ? Object.fromEntries(cs.eaters.map((userId, e) => [userId, cs.people[e][i]])) : null,
    })),
    split: buildSplit(cs),
  };
}

// Worst |deviation| as a percentage, half-up to 0.1 — the value shown, and the one the tier uses.
function displayedMaxPct(maxFraction: number): number {
  return Math.round(Number((maxFraction * 1000).toFixed(6))) / 10;
}

function tierFor(maxDeviationPct: number): SolveTier | null {
  return TIERS.find((tier) => tier >= maxDeviationPct) ?? null;
}

// P10: blame inconsistent targets first; otherwise the meal whose removal lowers the LP optimum
// most, with the (person, macro) that improved most as the reason.
function explain(
  meals: readonly DayMeal[],
  people: readonly string[],
  targets: SolveDayInput["targets"],
  full: LpResult,
): DaySolveExplanation {
  const inconsistent = people.find((person) => macroKcalMismatch(targets[person]) !== null);
  if (inconsistent !== undefined) {
    return { kind: "targets", userId: inconsistent };
  }

  let bestIndex = 0;
  let best: LpResult | null = null;
  for (const k of meals.keys()) {
    const rest = meals.filter((_, j) => j !== k);
    const reduced = solveLp(rest, peopleOf(rest), targets);
    if (best === null || reduced.t < best.t - EPSILON) {
      best = reduced;
      bestIndex = k;
    }
  }
  const blamed = meals[bestIndex];

  let macro: MacroKey = "kcal";
  let person = people[0];
  let bestImprovement = -Infinity;
  for (const p of people) {
    const without = best?.deviations[p];
    if (without === undefined) continue;
    for (const m of MACROS) {
      const improvement = Math.abs(full.deviations[p][m]) - Math.abs(without[m]);
      if (improvement > bestImprovement + EPSILON) {
        bestImprovement = improvement;
        macro = m;
        person = p;
      }
    }
  }
  if (bestImprovement === -Infinity) {
    // Every person dropped out of the re-solve: fall back to the worst full-day deviation.
    let worst = -1;
    for (const p of people) {
      for (const m of MACROS) {
        const abs = Math.abs(full.deviations[p][m]);
        if (abs > worst + EPSILON) {
          worst = abs;
          macro = m;
          person = p;
        }
      }
    }
  }

  return {
    kind: "recipe",
    mealId: blamed.meal.mealId,
    recipeName: blamed.recipe.name,
    macro,
    direction: full.deviations[person][macro] > 0 ? "over" : "under",
  };
}

export interface SolveDiagnostics {
  solution: DaySolution;
  // The LP minimax optimum t* (a fraction) and the unrounded worst deviation of the rounded result.
  lpOptimum: number;
  worstDeviation: number;
}

// The full pipeline with the numbers the unit tests compare. Throws on unsolvable input.
export function solveDayWithDiagnostics(input: SolveDayInput): SolveDiagnostics {
  const unsolvable = checkSolvable(input);
  if (unsolvable !== null) {
    throw new Error(`macro solver: unsolvable day (${unsolvable.reason})`);
  }
  const { meals, people } = normalise(input);
  const lp = solveLp(meals, people, input.targets);
  const { states, evaluation } = repair(initialState(meals, lp), people, input.targets);

  const peopleOut: DaySolutionPerson[] = people.map((userId) => {
    const t = input.targets[userId];
    const targets: MacroTargetsInput = { kcal: t.kcal, proteinG: t.proteinG, fatG: t.fatG, carbsG: t.carbsG };
    const totals = evaluation.totals.get(userId) ?? { ...ZERO_TOTALS };
    return { userId, targets, totals, deviations: deviationsFor(totals, targets) };
  });

  const mealsOut: DaySolutionMeal[] = meals.map(({ meal, recipe, eaters }, k) => ({
    mealId: meal.mealId,
    mealType: meal.mealType,
    recipeId: recipe.id,
    recipeName: recipe.name,
    divisionMode: recipe.divisionMode,
    eaterUserIds: eaters,
    components: states.filter((cs) => cs.mealIndex === k).map(buildComponent),
  }));

  const maxDeviationPct = displayedMaxPct(evaluation.max);
  const requiredTier = tierFor(maxDeviationPct);
  return {
    solution: {
      version: 1,
      people: peopleOut,
      meals: mealsOut,
      maxDeviationPct,
      requiredTier,
      explanation: requiredTier === null ? explain(meals, people, input.targets, lp) : null,
    },
    lpOptimum: lp.t,
    worstDeviation: evaluation.max,
  };
}

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

// A SHA-256 hex digest of every solver-relevant input in canonical order. It deliberately leaves
// out the accepted tolerance, so accepting a tier never makes a result look out of date.
export async function dayFingerprint(input: SolveDayInput): Promise<string> {
  const memberIds = [...input.memberIds].sort(compareIds);
  const meals = sortMeals(input.meals);
  const people = [...new Set(meals.flatMap((meal) => eatersOf(meal, memberIds)))].sort(compareIds);
  const recipeIds = [...new Set(meals.map((meal) => meal.recipeId))].sort(compareIds);
  const canonical = {
    v: SOLVER_VERSION,
    members: memberIds,
    meals: meals.map((m) => [m.mealId, m.mealType, m.recipeId, m.eaterUserId]),
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
        recipe.divisionMode,
        recipe.components.map((c) => [
          c.id,
          c.position,
          c.cookedYieldRatio,
          c.ingredients.map((i) => [
            i.id,
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
