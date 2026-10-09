import type { MacroTotals } from "@/types";

// Pure FR-010 arithmetic and display strings for recipe nutrition. No I/O: the library page uses it
// today, and the solver (S-04) needs the same per-100 g arithmetic.

export interface Per100g {
  kcalPer100g: number;
  proteinPer100g: number;
  fatPer100g: number;
  carbsPer100g: number;
}

const ZERO: MacroTotals = { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 };

// Unrounded: rounding happens once, at display time, so subtotals never accumulate rounding error.
export function ingredientMacros(amountG: number, product: Per100g): MacroTotals {
  return {
    kcal: (amountG * product.kcalPer100g) / 100,
    proteinG: (amountG * product.proteinPer100g) / 100,
    fatG: (amountG * product.fatPer100g) / 100,
    carbsG: (amountG * product.carbsPer100g) / 100,
  };
}

export function sumMacros(list: MacroTotals[]): MacroTotals {
  return list.reduce(
    (acc, m) => ({
      kcal: acc.kcal + m.kcal,
      proteinG: acc.proteinG + m.proteinG,
      fatG: acc.fatG + m.fatG,
      carbsG: acc.carbsG + m.carbsG,
    }),
    ZERO,
  );
}

export function cookedWeight(rawG: number, ratio: number | null): number | null {
  return ratio === null ? null : rawG * ratio;
}

// Half-up rounding that agrees with Postgres round(numeric) at exact .5 values: the toFixed pass
// strips float noise such as 402.49999999 before Math.round sees it. The solver (S-04) rounds with it too.
export function roundHalfUp(value: number): number {
  return Math.round(Number(value.toFixed(6)));
}

// Grams as stored (numeric(7,1)): integers print bare, anything else keeps its one decimal.
function formatGrams(g: number): string {
  return Number.isInteger(g) ? String(g) : g.toFixed(1);
}

// The smoke test matches this exact string (same shape as formatMacroTargets()).
export function formatMacroTotals(t: MacroTotals): string {
  return `${roundHalfUp(t.kcal)} kcal · P ${roundHalfUp(t.proteinG)} g · F ${roundHalfUp(t.fatG)} g · C ${roundHalfUp(t.carbsG)} g`;
}

// The smoke test matches this exact string.
export function formatCookedLine(rawG: number, cookedG: number, ratio: number): string {
  return `Raw ${roundHalfUp(rawG)} g → cooked ≈ ${roundHalfUp(cookedG)} g (×${ratio.toFixed(2)})`;
}

export function formatIngredientAmount(
  amountG: number,
  gramsPerPiece: number | null,
  allowHalfPieces: boolean,
): string {
  const grams = `${formatGrams(amountG)} g`;
  if (gramsPerPiece === null) {
    return grams;
  }
  const count = Number((amountG / gramsPerPiece).toFixed(6));
  if (Number.isInteger(count)) {
    return `${count} ${count === 1 ? "pc" : "pcs"} (${grams})`;
  }
  if (allowHalfPieces && Number.isInteger(count * 2)) {
    const whole = Math.floor(count);
    return whole === 0 ? `½ pc (${grams})` : `${whole}½ pcs (${grams})`;
  }
  // Not a whole or allowed half piece count: only possible for non-seed rows, so fall back to grams.
  return grams;
}

export function formatRoundingStep(g: number): string {
  return `step ${formatGrams(g)} g`;
}
