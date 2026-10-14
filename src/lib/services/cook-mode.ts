import type {
  CookBatchAmounts,
  CookBatchPortions,
  CookEntryOverview,
  CookIngredientLine,
  CookingSession,
  CookingSessionEntry,
  CookingSessionSection,
  CookModeSection,
  CookModeView,
  CookPortionLine,
  CookServingNote,
  CookStep,
  DaySolution,
  DaySolutionComponent,
  DaySolutionMeal,
  MealPlan,
  MealType,
  PlanDayIndex,
  SessionMealRef,
  SolverComponent,
  SolverRecipe,
} from "@/types";
import { formatBatchNote, formatEntryMeals, mealLabel } from "@/lib/services/cooking-sessions";
import { addDays, weekdayLabel } from "@/lib/services/meal-plans";
import { formatIngredientAmount } from "@/lib/services/recipe-macros";
import { formatSplitLine, type SplitLineContext } from "@/lib/services/split-lines";
import { joinList } from "@/lib/utils";

// Re-exported so the island takes every display helper from this module.
export { formatStepDuration } from "@/lib/services/cooking-sessions";

// Step-by-step cook mode of one cooking session (S-11), as a pure function of the S-10 session, the
// plan's current stored solves and the library recipes. No I/O and nothing that pulls in the solver,
// zod or Supabase: the island imports this module, so it must never import day-solutions.ts or
// macro-solver.ts. The reads live in cooking.ts.
//
// Rules: a section's amounts are exact when its lead day (the session's day for "now", the next day
// for "ahead") is in `currentSolutions`, else the recipe base amounts as an estimate with no portions.
// Each dish reads exactly one stored row — its lead meal's — so a shared batch is never counted twice.
// A step shows its component's amounts per batch; an entry's last step in its section shows the
// portions. A later meal of a shared batch gets a serving note with its own portions.

export interface CookModeInput {
  plan: MealPlan;
  session: CookingSession;
  currentSolutions: Partial<Record<PlanDayIndex, DaySolution>>;
  recipes: Record<string, SolverRecipe>;
  viewerId: string;
}

// One batch of an entry and where its amounts come from: a stored row, the library recipe, or neither.
interface Batch {
  dishId: string;
  heading: string | null;
  lead: SessionMealRef;
  stored: DaySolutionMeal | null;
  base: SolverRecipe | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayIndexOf(startDate: string, date: string): PlanDayIndex {
  const utc = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(date) - utc(startDate)) / DAY_MS) as PlanDayIndex;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function storedLines(component: DaySolutionComponent): CookIngredientLine[] {
  return component.ingredients.map((ingredient) => ({
    ingredientId: ingredient.id,
    productName: ingredient.productName,
    amount: formatIngredientAmount(ingredient.amountG, ingredient.gramsPerPiece, ingredient.allowHalfPieces),
  }));
}

function baseLines(component: SolverComponent): CookIngredientLine[] {
  return component.ingredients.map((ingredient) => ({
    ingredientId: ingredient.id,
    productName: ingredient.productName,
    amount: formatIngredientAmount(ingredient.baseAmountG, ingredient.gramsPerPiece, ingredient.allowHalfPieces),
  }));
}

// One component's ingredients in one batch, or null when the batch has no such component.
function componentLines(batch: Batch, componentId: string): CookIngredientLine[] | null {
  if (batch.stored) {
    const component = batch.stored.components.find((candidate) => candidate.id === componentId);
    return component ? storedLines(component) : null;
  }
  const component = batch.base?.components.find((candidate) => candidate.id === componentId);
  return component ? baseLines(component) : null;
}

function portionLines(meal: DaySolutionMeal, viewerId: string, context: SplitLineContext): CookPortionLine[] {
  const named = meal.divisionMode === "per_component";
  return meal.components.map((component) => ({
    componentName: named ? component.name : null,
    line: formatSplitLine(component, viewerId, context),
  }));
}

export function buildCookMode(input: CookModeInput): CookModeView {
  const { plan, session, currentSolutions, recipes, viewerId } = input;
  const startDate = plan.startDate;
  const mealTypes = new Map<string, MealType>(plan.meals.map((meal) => [meal.mealId, meal.mealType]));
  const weekdayOf = (dayIndex: PlanDayIndex) => weekdayLabel(addDays(startDate, dayIndex));
  const mealTypeOf = (mealId: string) => mealTypes.get(mealId);
  const sessionDay = dayIndexOf(startDate, session.date);

  const dishesFellBack = new Set<string>();
  const missingRecipeIds = new Set<string>();

  // The entry's batches in lead-meal order; each reads its lead meal's stored row (exact) or the
  // library recipe (estimate).
  const batchesOf = (entry: CookingSessionEntry, exact: boolean): Batch[] => {
    const leads = new Map<string, SessionMealRef>();
    for (const meal of entry.meals) {
      if (!leads.has(meal.dishId)) leads.set(meal.dishId, meal);
    }
    return [...leads.entries()].map(([dishId, lead]) => {
      const heading =
        entry.dishIds.length > 1
          ? formatBatchHeading(
              entry.meals.filter((meal) => meal.dishId === dishId),
              startDate,
            )
          : null;
      let stored: DaySolutionMeal | null = null;
      if (exact) {
        stored = currentSolutions[lead.dayIndex]?.meals.find((meal) => meal.mealId === lead.mealId) ?? null;
        if (stored === null) dishesFellBack.add(dishId);
      }
      let base: SolverRecipe | null = null;
      if (stored === null) {
        const recipe = recipes[entry.recipeId] as SolverRecipe | undefined;
        if (recipe) base = recipe;
        else missingRecipeIds.add(entry.recipeId);
      }
      return { dishId, heading, lead, stored, base };
    });
  };

  const batchPortions = (batch: Batch): CookBatchPortions | null =>
    batch.stored === null
      ? null
      : {
          dishId: batch.dishId,
          heading: batch.heading,
          lines: portionLines(batch.stored, viewerId, {
            mealId: batch.lead.mealId,
            viewedDay: batch.lead.dayIndex,
            weekdayOf,
            mealTypeOf,
          }),
        };

  const overview = (entry: CookingSessionEntry, batches: Batch[]): CookEntryOverview => ({
    key: entry.key,
    recipeId: entry.recipeId,
    recipeName: entry.recipeName,
    mealsLine: formatEntryMeals(entry, startDate),
    hasSteps: entry.hasSteps,
    batches: batches.map((batch) => {
      const portions = batchPortions(batch);
      let components: CookEntryOverview["batches"][number]["components"] = [];
      if (batch.stored) {
        const named = batch.stored.divisionMode === "per_component";
        components = batch.stored.components.map((component, i) => ({
          componentName: named ? component.name : null,
          ingredients: storedLines(component),
          portion: portions?.lines[i].line ?? null,
        }));
      } else if (batch.base) {
        const named = batch.base.divisionMode === "per_component";
        components = batch.base.components.map((component) => ({
          componentName: named ? component.name : null,
          ingredients: baseLines(component),
          portion: null,
        }));
      }
      return { dishId: batch.dishId, heading: batch.heading, components };
    }),
  });

  // A later meal of a shared batch: the S-10 note plus that meal's own portions, from its own row.
  const servingNotes = (section: CookingSessionSection, exact: boolean): CookServingNote[] =>
    section.batchNotes.map((note) => {
      const { meal } = note;
      let portions: CookPortionLine[] = [];
      if (exact) {
        const row = currentSolutions[meal.dayIndex]?.meals.find((candidate) => candidate.mealId === meal.mealId);
        if (row) {
          portions = portionLines(row, viewerId, {
            mealId: meal.mealId,
            viewedDay: meal.dayIndex,
            weekdayOf,
            mealTypeOf,
            ownOnly: true,
          });
        } else {
          dishesFellBack.add(meal.dishId);
        }
      }
      return {
        mealId: meal.mealId,
        dayIndex: meal.dayIndex,
        mealType: meal.mealType,
        text: formatBatchNote(note, startDate),
        portions,
      };
    });

  const sections: CookModeSection[] = [];
  const steps: CookStep[] = [];
  for (const section of session.sections) {
    const sourceDayIndex = (sessionDay + (section.kind === "ahead" ? 1 : 0)) as PlanDayIndex;
    const solution = currentSolutions[sourceDayIndex];
    const exact = solution !== undefined;
    const batchesByEntry = new Map(section.entries.map((entry) => [entry.key, batchesOf(entry, exact)]));

    sections.push({
      kind: section.kind,
      source: exact ? "exact" : "estimate",
      sourceDayIndex,
      boundsWarning: exact && solution.boundsViolated,
      entries: section.entries.map((entry) => overview(entry, batchesByEntry.get(entry.key) ?? [])),
      servingNotes: servingNotes(section, exact),
    });

    const lastStepOf = new Map<string, string>();
    for (const step of section.steps) lastStepOf.set(step.entryKey, step.id);
    for (const step of section.steps) {
      const batches = batchesByEntry.get(step.entryKey) ?? [];
      const amounts: CookBatchAmounts[] = [];
      if (step.componentId !== null) {
        for (const batch of batches) {
          const ingredients = componentLines(batch, step.componentId);
          if (ingredients) amounts.push({ dishId: batch.dishId, heading: batch.heading, ingredients });
        }
      }
      let portions: CookBatchPortions[] | null = null;
      if (exact && lastStepOf.get(step.entryKey) === step.id) {
        const list = batches.map(batchPortions).filter((entry): entry is CookBatchPortions => entry !== null);
        portions = list.length > 0 ? list : null;
      }
      steps.push({
        number: steps.length + 1,
        id: step.id,
        sectionKind: section.kind,
        entryKey: step.entryKey,
        recipeId: step.recipeId,
        recipeName: step.recipeName,
        componentName: step.componentName,
        instruction: step.instruction,
        timing: step.timing,
        durationMinutes: step.durationMinutes,
        amounts,
        portions,
      });
    }
  }

  return {
    planId: plan.id,
    startDate,
    sessionKey: session.key,
    date: session.date,
    part: session.part,
    sections,
    steps,
    diagnostics: {
      dishesFellBack: [...dishesFellBack].sort(compareIds),
      missingRecipeIds: [...missingRecipeIds].sort(compareIds),
    },
  };
}

// --- display text --------------------------------------------------------------------------------
// The smoke test matches these exact strings; none may contain an apostrophe (Astro escapes it).

export const COOK_UNAVAILABLE = "Cook mode is unavailable right now.";
export const COOK_NO_PLAN_FOR_DATE = "No plan for that date.";
export const COOK_NO_STEPS = "No steps recorded for this session — the amounts are below.";
export const COOK_BOUNDS_WARNING = "Some amounts break the solver limits — check them on the day page before cooking.";

export function formatStepCounter(n: number, total: number): string {
  return `Step ${n} of ${total}`;
}

// The island's per-device progress line: "3 of 12 done".
export function formatDoneCount(done: number, total: number): string {
  return `${done} of ${total} done`;
}

export function formatCookExactNote(weekday: string): string {
  return `Amounts and portions from the day solve of ${weekday}.`;
}

export function formatCookEstimateNote(weekday: string): string {
  return `Estimate for ${weekday}: recipe base amounts and no portions yet — solve ${weekday} to get them.`;
}

// "For Monday Lunch": the meals one batch of a merged entry feeds.
export function formatBatchHeading(
  meals: readonly Pick<SessionMealRef, "dayIndex" | "mealType">[],
  startDate: string,
): string {
  return `For ${joinList(meals.map((meal) => mealLabel(startDate, meal)))}`;
}

// The cook page of one session, shared by the page, the island and the sessions link.
export function cookPath(startDate: string, sessionKey: string, step?: number): string {
  const path = `/plan/sessions/cook?start=${startDate}&session=${sessionKey}`;
  return step === undefined ? path : `${path}&step=${step}`;
}
