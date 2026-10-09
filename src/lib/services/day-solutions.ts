import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type {
  DaySolution,
  DaySolutionComponent,
  DaySolutionMeal,
  DaySolutionPerson,
  DaySolveStatus,
  DayView,
  MacroKey,
  MacroTargetsInput,
  MealPlan,
  PlanDayIndex,
  PlanDaySolveStatus,
  SolveDayInput,
  SolveTier,
  StoredDaySolution,
  UnsolvableReason,
} from "@/types";
import { getCurrentHousehold } from "@/lib/services/household";
import { checkSolvable, dayFingerprint } from "@/lib/services/macro-solver";
import { formatMacroTargets, getHouseholdMacroTargets } from "@/lib/services/macro-targets";
import { MEAL_TYPES, PLAN_DAYS, errorCode, getMealPlan, type RpcResult } from "@/lib/services/meal-plans";
import { roundHalfUp } from "@/lib/services/recipe-macros";
import { getSolverRecipes } from "@/lib/services/recipes";
import { EATER_LABELS, MACRO_DIRECTION_LABELS, MACRO_SHORT_LABELS, SPLIT_LABELS } from "@/lib/recipe-labels";

// Solving one planned day (S-04): the reads that feed the pure solver (macro-solver.ts) and the
// sentence templates the day page shows. Enum labels live in recipe-labels.ts (S-14 localises them).

// Everything solveDay() needs for one day, or null when no plan exists for that date. A failed
// read throws: it must never degrade into "no targets" or "no meals".
export async function loadDaySolveInputs(
  supabase: SupabaseClient,
  startDate: string,
  dayIndex: PlanDayIndex,
): Promise<{ plan: MealPlan; input: SolveDayInput } | null> {
  const plan = await getMealPlan(supabase, startDate);
  if (!plan) {
    return null;
  }
  const meals = plan.meals.filter((meal) => meal.dayIndex === dayIndex);
  const shared = await loadSharedInputs(
    supabase,
    meals.map((meal) => meal.recipeId),
  );
  return { plan, input: { ...shared, meals } };
}

// The day-independent part of a solve input: members, targets and the library rows of `recipeIds`.
async function loadSharedInputs(supabase: SupabaseClient, recipeIds: string[]): Promise<Omit<SolveDayInput, "meals">> {
  const [household, targets, recipes] = await Promise.all([
    getCurrentHousehold(supabase),
    getHouseholdMacroTargets(supabase),
    getSolverRecipes(supabase, recipeIds),
  ]);
  if (!household) {
    throw new Error("loadSharedInputs: the caller has no household");
  }

  const targetsByUser: Record<string, MacroTargetsInput> = {};
  for (const t of targets) {
    targetsByUser[t.userId] = { kcal: t.kcal, proteinG: t.proteinG, fatG: t.fatG, carbsG: t.carbsG };
  }
  return {
    memberIds: household.members.map((member) => member.userId),
    recipes,
    targets: targetsByUser,
  };
}

// --- persistence (phase 2) -----------------------------------------------------------------------

interface DaySolutionRow {
  status: DaySolveStatus;
  accepted_tolerance_pct: SolveTier;
  input_fingerprint: string;
  result: unknown;
  solved_at: string;
}

// The stored result is client-assertable: save_day_solution only checks that it is a jsonb object,
// and any household member can call it directly. Every reader goes through this schema, so a
// malformed row reads as "not solved" (and can be solved again) instead of breaking the page.
const macroTotalsSchema = z.object({
  kcal: z.number(),
  proteinG: z.number(),
  fatG: z.number(),
  carbsG: z.number(),
});

const solveTierSchema = z.union([z.literal(10), z.literal(15), z.literal(20)]);

const daySolutionSchema: z.ZodType<DaySolution> = z.object({
  version: z.literal(1),
  people: z.array(
    z.object({
      userId: z.string(),
      targets: macroTotalsSchema,
      totals: macroTotalsSchema,
      deviations: macroTotalsSchema,
    }),
  ),
  meals: z.array(
    z.object({
      mealId: z.string(),
      mealType: z.enum(["breakfast", "second_breakfast", "lunch", "afternoon_snack", "dinner"]),
      recipeId: z.string(),
      recipeName: z.string(),
      divisionMode: z.enum(["per_component", "whole_dish"]),
      eaterUserIds: z.array(z.string()).min(1),
      components: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          cookedYieldRatio: z.number().nullable(),
          ingredients: z.array(
            z.object({
              id: z.string(),
              productName: z.string(),
              amountG: z.number(),
              gramsPerPiece: z.number().nullable(),
              allowHalfPieces: z.boolean(),
              perPerson: z.record(z.string(), z.number()).nullable(),
            }),
          ),
          split: z.object({
            kind: z.enum(["grams_cooked", "percent", "pieces", "per_ingredient", "all"]),
            evenSplit: z.boolean(),
            shares: z
              .array(z.object({ userId: z.string(), value: z.number().nullable(), fraction: z.number() }))
              .min(1),
          }),
        }),
      ),
    }),
  ),
  maxDeviationPct: z.number(),
  requiredTier: solveTierSchema.nullable(),
  explanation: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("recipe"),
        mealId: z.string(),
        recipeName: z.string(),
        macro: z.enum(["kcal", "proteinG", "fatG", "carbsG"]),
        direction: z.enum(["over", "under"]),
      }),
      z.object({ kind: z.literal("targets"), userId: z.string() }),
    ])
    .nullable(),
  // Absent in rows stored before SOLVER_VERSION 2; those rows read as out of date anyway.
  boundsViolated: z.boolean().default(false),
});

// The stored result, or null (logged) when it does not match the version-1 shape.
function parseStoredSolution(result: unknown): DaySolution | null {
  const parsed = daySolutionSchema.safeParse(result);
  if (!parsed.success) {
    // eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs
    console.error("plan_day_solutions.result failed validation", parsed.error.issues);
    return null;
  }
  return parsed.data;
}

// The stored solution for one plan day, or null when the day has never been solved.
export async function getDaySolution(
  supabase: SupabaseClient,
  planId: string,
  dayIndex: PlanDayIndex,
): Promise<StoredDaySolution | null> {
  const { data, error } = await supabase
    .from("plan_day_solutions")
    .select("status, accepted_tolerance_pct, input_fingerprint, result, solved_at")
    .eq("plan_id", planId)
    .eq("day_index", dayIndex)
    .maybeSingle();
  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }
  // Without a generated Database type the row is untyped; the table's checks guarantee its scalar
  // columns, and parseStoredSolution() the jsonb result.
  const row: DaySolutionRow = data;
  const solution = parseStoredSolution(row.result);
  if (!solution) {
    return null;
  }
  return {
    status: row.status,
    acceptedTolerancePct: row.accepted_tolerance_pct,
    inputFingerprint: row.input_fingerprint,
    solution,
    solvedAt: row.solved_at,
  };
}

// Stores a solve through public.save_day_solution and returns the row id.
export async function saveDaySolution(
  supabase: SupabaseClient,
  startDate: string,
  dayIndex: PlanDayIndex,
  status: DaySolveStatus,
  acceptedTolerance: SolveTier,
  fingerprint: string,
  solution: DaySolution,
): Promise<string> {
  const { data, error } = (await supabase.rpc("save_day_solution", {
    p_start_date: startDate,
    p_day_index: dayIndex,
    p_status: status,
    p_accepted_tolerance_pct: acceptedTolerance,
    p_input_fingerprint: fingerprint,
    p_result: solution,
  })) as RpcResult<string>;

  if (error) {
    throw error;
  }
  if (data === null) {
    throw new Error("save_day_solution returned no id");
  }
  return data;
}

// Everything the day page and the solve route need, or null when no plan exists for that date. It
// never solves: a stored result is compared to the current inputs by fingerprint only.
export async function getDayView(
  supabase: SupabaseClient,
  startDate: string,
  dayIndex: PlanDayIndex,
): Promise<DayView | null> {
  const loaded = await loadDaySolveInputs(supabase, startDate, dayIndex);
  if (!loaded) {
    return null;
  }
  const [stored, fingerprint] = await Promise.all([
    getDaySolution(supabase, loaded.plan.id, dayIndex),
    dayFingerprint(loaded.input),
  ]);
  const unsolvable = checkSolvable(loaded.input);
  return {
    plan: loaded.plan,
    input: loaded.input,
    unsolvable,
    fingerprint,
    stored,
    stale: stored !== null && (unsolvable !== null || stored.inputFingerprint !== fingerprint),
  };
}

// Where each of the plan's three days stands, for the /plan grid. One read of the plan's stored
// solutions plus one shared input load; it fingerprints every day but never solves one.
export async function getPlanSolveStatuses(
  supabase: SupabaseClient,
  plan: MealPlan,
): Promise<Record<PlanDayIndex, PlanDaySolveStatus>> {
  const [rows, shared] = await Promise.all([
    supabase
      .from("plan_day_solutions")
      .select("day_index, status, accepted_tolerance_pct, input_fingerprint, result, solved_at")
      .eq("plan_id", plan.id),
    loadSharedInputs(
      supabase,
      plan.meals.map((meal) => meal.recipeId),
    ),
  ]);
  if (rows.error) {
    throw rows.error;
  }
  // Without a generated Database type the rows are untyped; the table's checks guarantee this shape.
  const storedRows: (DaySolutionRow & { day_index: PlanDayIndex })[] = rows.data;

  const entries = await Promise.all(
    PLAN_DAYS.map(async (day): Promise<[PlanDayIndex, PlanDaySolveStatus]> => {
      const input: SolveDayInput = { ...shared, meals: plan.meals.filter((meal) => meal.dayIndex === day) };
      if (input.meals.length === 0) {
        return [day, { kind: "empty", mealCount: 0 }];
      }
      const mealCount = input.meals.length;
      if (checkSolvable(input) !== null) {
        return [day, { kind: "unsolvable", mealCount }];
      }
      const stored = storedRows.find((row) => row.day_index === day);
      const solution = stored ? parseStoredSolution(stored.result) : null;
      if (!stored || !solution) {
        return [day, { kind: "unsolved", mealCount }];
      }
      if (stored.input_fingerprint !== (await dayFingerprint(input))) {
        return [day, { kind: "stale", mealCount }];
      }
      return [day, { kind: stored.status, mealCount, requiredTier: solution.requiredTier }];
    }),
  );
  return Object.fromEntries(entries) as Record<PlanDayIndex, PlanDaySolveStatus>;
}

// A full day (all 5 meals) with no current solution gets the solve prompt (FR-018). An unsolvable
// day gets "Can't solve yet" instead, since solving it would only bounce back.
export function needsSolvePrompt(status: PlanDaySolveStatus): boolean {
  return status.mealCount === MEAL_TYPES.length && (status.kind === "unsolved" || status.kind === "stale");
}

// --- display text --------------------------------------------------------------------------------

export const SOLVE_STATUS_UNAVAILABLE = "Solve status is unavailable right now.";
export const SOLVE_SAVED_PLAN_HINT = "Solves the saved plan — save your changes first.";

// The smoke test matches these exact strings (/plan `day-status-<n>`).
export function formatPlanDayStatus(status: PlanDaySolveStatus): string {
  switch (status.kind) {
    case "empty":
      return "No meals";
    case "unsolved":
      return "Not solved";
    case "stale":
      return "Out of date";
    case "unsolvable":
      return "Can't solve yet — see day";
    case "solved":
      return `Solved within ±${status.requiredTier ?? 10}%`;
    case "needs_confirmation":
      return `Needs ±${status.requiredTier ?? 20}% — open to accept`;
    case "no_fit":
      return "No fit within ±20%";
  }
}

export function formatSolvePrompt(weekday: string): string {
  return `${weekday} has all 5 meals. Solve its macros?`;
}

export const DAY_NOT_FOUND = "Day not found";
export const DAY_UNAVAILABLE = "This day is unavailable right now.";
export const FULL_TARGETS_NOTE = "Portions are scaled to each person's full daily targets.";
export const NOT_SOLVED_YET = "Not solved yet";
export const DAY_SOLVE_STALE = "Out of date — the plan, targets or recipes changed since this was solved.";
export const DAY_BOUNDS_WARNING =
  "Some portions break the solver's limits (an ingredient minimum, 0.2–1.5× of a batch, or one part over 3× another) — check them before cooking.";

// Rejection SQLSTATEs raised by save_day_solution. KD007 is shared with S-01 but gets solve wording.
export const DAY_SOLVE_ERRORS = {
  KD007: "You need to be signed in to solve a day.",
  KD013: "That solve result could not be saved. Please try again.",
  KD014: "Save the plan before solving it.",
} as const;

export const DAY_CHANGED_BEFORE_ACCEPT = "The day changed since you looked — review the new result before accepting.";
export const DAY_SOLVE_FAILED = "Macros could not be solved right now. Please try again.";

export function daySolveErrorMessage(error: unknown): string {
  const code = errorCode(error);
  return code !== null && code in DAY_SOLVE_ERRORS
    ? DAY_SOLVE_ERRORS[code as keyof typeof DAY_SOLVE_ERRORS]
    : DAY_SOLVE_FAILED;
}

// "Solved at 14:05, 9 Oct 2026" in the household's locale.
export function formatSolvedAt(solvedAt: string): string {
  const date = new Date(solvedAt);
  const time = date.toLocaleTimeString("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString("en-GB", {
    timeZone: "Europe/Warsaw",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `Solved at ${time}, ${day}`;
}

// P11 reasons, with "You" / "Your partner" resolved against the viewer.
export const UNSOLVABLE_MESSAGES = {
  no_meals: "This day has no meals yet — add some on the plan first.",
  missing_targets_you: "Set your daily targets first — the solver needs them.",
  missing_targets_partner: "Your partner hasn't set their daily targets yet.",
  empty_recipe: (recipeName: string) => `${recipeName} has no ingredients, so this day can't be solved.`,
  invalid_recipe: (recipeName: string) =>
    `${recipeName} is a whole dish with more than one part, so this day can't be solved.`,
  eater_not_member: "A meal is marked for someone who isn't in your household.",
} as const;

export function unsolvableMessage(reason: UnsolvableReason, viewerId: string): string {
  switch (reason.reason) {
    case "no_meals":
      return UNSOLVABLE_MESSAGES.no_meals;
    case "missing_targets":
      return reason.userIds?.includes(viewerId)
        ? UNSOLVABLE_MESSAGES.missing_targets_you
        : UNSOLVABLE_MESSAGES.missing_targets_partner;
    case "empty_recipe":
      return UNSOLVABLE_MESSAGES.empty_recipe(reason.recipeName ?? "A recipe");
    case "invalid_recipe":
      return UNSOLVABLE_MESSAGES.invalid_recipe(reason.recipeName ?? "A recipe");
    case "eater_not_member":
      return UNSOLVABLE_MESSAGES.eater_not_member;
  }
}

// The smoke test matches these exact strings.
export function formatDaySolveSummary(solution: DaySolution, status: DaySolveStatus, viewerId?: string): string {
  const tier = solution.requiredTier;
  if (status === "solved" && tier !== null) {
    return `Solved within ±${tier}%`;
  }
  if (status === "needs_confirmation" && tier !== null) {
    return `Best fit needs ±${tier}% — accept to use it`;
  }
  const explanation = solution.explanation;
  if (explanation?.kind === "targets") {
    const whose = viewerId === undefined || explanation.userId === viewerId ? "Your" : "Your partner's";
    return `${whose} daily targets don't add up (protein/fat/carbs vs kcal) — adjust them first.`;
  }
  if (explanation?.kind === "recipe") {
    const reason = MACRO_DIRECTION_LABELS[explanation.macro][explanation.direction];
    return `No fit within ±20% · Most obstructive recipe: ${explanation.recipeName} (${reason})`;
  }
  return "No fit within ±20%";
}

function personLabel(userId: string, viewerId: string): string {
  return userId === viewerId ? EATER_LABELS.you : EATER_LABELS.partner;
}

// The viewer first, then the partner.
export function viewerFirst<T extends { userId: string }>(list: readonly T[], viewerId: string): T[] {
  return [...list].sort((a, b) => Number(b.userId === viewerId) - Number(a.userId === viewerId));
}

function formatSignedPct(fraction: number): string {
  const pct = Math.round(Number((Math.abs(fraction) * 1000).toFixed(6))) / 10;
  const sign = pct === 0 ? "±" : fraction > 0 ? "+" : "−";
  return `${sign}${pct.toFixed(1)}%`;
}

const LINE_MACROS: readonly MacroKey[] = ["kcal", "proteinG", "fatG", "carbsG"];

// "You · 2190 kcal (−0.5%) · P 158 g (−1.3%) · F 72 g (+2.9%) · C 228 g (−0.9%)"
export function formatPersonLine(person: DaySolutionPerson, viewerId: string): string {
  const parts = LINE_MACROS.map((m) => {
    const value = roundHalfUp(person.totals[m]);
    const amount = m === "kcal" ? `${value} kcal` : `${MACRO_SHORT_LABELS[m]} ${value} g`;
    return `${amount} (${formatSignedPct(person.deviations[m])})`;
  });
  return [personLabel(person.userId, viewerId), ...parts].join(" · ");
}

export function formatTargetLine(person: DaySolutionPerson): string {
  return `Target: ${formatMacroTargets(person.targets)}`;
}

export function formatEaters(meal: DaySolutionMeal, viewerId: string): string {
  if (meal.eaterUserIds.length > 1) return EATER_LABELS.both;
  return personLabel(meal.eaterUserIds[0], viewerId);
}

function formatPieces(count: number): string {
  if (Number.isInteger(count)) return `${count} ${count === 1 ? "pc" : "pcs"}`;
  const whole = Math.floor(count);
  return whole === 0 ? "½ pc" : `${whole}½ pcs`;
}

function formatGramsShort(grams: number): string {
  return `${Number.isInteger(grams) ? grams : grams.toFixed(1)} g`;
}

// One component's split between its eaters, e.g. "You: 320 g cooked · Partner: 260 g cooked".
export function formatSplitLine(component: DaySolutionComponent, viewerId: string): string {
  const { kind, evenSplit } = component.split;
  const shares = viewerFirst(component.split.shares, viewerId);
  if (kind === "all") {
    return shares[0].userId === viewerId ? SPLIT_LABELS.allForYou : SPLIT_LABELS.allForPartner;
  }
  const parts = shares.map((share) => {
    const label = personLabel(share.userId, viewerId);
    switch (kind) {
      case "grams_cooked":
        return `${label}: ${share.value ?? 0} g ${SPLIT_LABELS.cooked}`;
      case "percent":
        return `${label}: ${share.value ?? 0}%`;
      case "pieces":
        return `${label}: ${formatPieces(share.value ?? 0)}`;
      case "per_ingredient":
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
  if (kind === "percent") line += ` ${SPLIT_LABELS.ofTheDish}`;
  if (evenSplit) line += ` · ${SPLIT_LABELS.splitInHalf}`;
  return line;
}
