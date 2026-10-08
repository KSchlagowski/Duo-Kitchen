import type { SupabaseClient } from "@supabase/supabase-js";
import type { MacroTargets, MacroTargetsInput } from "@/types";

// RLS scopes `macro_targets` reads to the caller's household (their own row and their partner's),
// so no explicit filter is needed. Writes additionally require user_id = auth.uid(): a partner's row
// is readable here but never writable (20261008120000_macro_targets.sql).

interface MacroTargetsRow {
  user_id: string;
  kcal: number;
  protein_g: number;
  fat_g: number;
  carbs_g: number;
  updated_at: string;
}

export async function getHouseholdMacroTargets(supabase: SupabaseClient): Promise<MacroTargets[]> {
  const { data, error } = await supabase
    .from("macro_targets")
    .select("user_id, kcal, protein_g, fat_g, carbs_g, updated_at");

  if (error) {
    throw error;
  }

  return (data as MacroTargetsRow[]).map((row) => ({
    userId: row.user_id,
    kcal: row.kcal,
    proteinG: row.protein_g,
    fatG: row.fat_g,
    carbsG: row.carbs_g,
    updatedAt: row.updated_at,
  }));
}

// The caller's household_id is resolved from their own membership row, so the upsert names the
// household the composite membership FK expects. A redemption committing between the two calls
// surfaces as 42501 (RLS WITH CHECK, the usual outcome) or 23503; both are thrown to the caller.
export async function saveMyMacroTargets(
  supabase: SupabaseClient,
  userId: string,
  input: MacroTargetsInput,
): Promise<void> {
  const { data: membership, error: membershipError } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("user_id", userId)
    .single();

  if (membershipError) {
    throw membershipError;
  }

  const { error } = await supabase.from("macro_targets").upsert(
    {
      user_id: userId,
      household_id: membership.household_id,
      kcal: input.kcal,
      protein_g: input.proteinG,
      fat_g: input.fatG,
      carbs_g: input.carbsG,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    throw error;
  }
}

// The smoke test matches this exact string.
export function formatMacroTargets(t: MacroTargetsInput): string {
  return `${t.kcal} kcal · P ${t.proteinG} g · F ${t.fatG} g · C ${t.carbsG} g`;
}

const MISMATCH_THRESHOLD = 0.1;

// Returns the macro-derived calories (4 kcal/g protein and carbs, 9 kcal/g fat) when they differ
// from the calorie target by more than 10%, otherwise null. A soft hint only: saving never blocks.
export function macroKcalMismatch(t: MacroTargetsInput): number | null {
  const derived = 4 * t.proteinG + 4 * t.carbsG + 9 * t.fatG;
  return Math.abs(derived - t.kcal) / t.kcal > MISMATCH_THRESHOLD ? derived : null;
}
