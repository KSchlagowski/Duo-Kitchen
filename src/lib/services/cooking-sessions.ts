import type {
  CookingSchedule,
  CookingSession,
  CookingSessionEntry,
  CookingSessionSection,
  MealPlan,
  PlanMealRecord,
  RecipeDetailStep,
  RecipeSteps,
  ScheduledStep,
  SessionBatchNote,
  SessionMealRef,
  SessionPart,
  SessionSectionKind,
} from "@/types";
import { MEAL_TYPE_LABELS, SESSION_PART_LABELS } from "@/lib/recipe-labels";
import { addDays, MEAL_TYPES, weekdayLabel } from "@/lib/services/meal-plans";
import { joinList } from "@/lib/utils";

// The cooking-session schedule of one plan (S-10), as a pure function of the plan and the library's
// step metadata. No I/O, no solve and nothing that pulls in the solver, zod or Supabase: it shows
// steps, not amounts, so it never reads a stored solution. The reads live in cooking.ts.
//
// Rules: a dish's make-ahead prefix is cooked the evening before its cook day (its earliest meal's
// day); its fresh steps once, in the session of its earliest meal (that morning, or that evening's
// "Tonight" for a dinner). A shared batch's later meals get a note instead of steps. Same-recipe
// dishes in one section merge into one entry, and each section's steps are merged longest remaining
// chain first, each recipe's own order kept.

export interface CookingSessionsInput {
  plan: MealPlan;
  recipeSteps: Record<string, RecipeSteps>;
}

interface Slot {
  date: string;
  part: SessionPart;
  kind: SessionSectionKind;
}

interface Placement {
  recipeId: string;
  recipeName: string | null;
  dishId: string;
  meals: SessionMealRef[];
  steps: RecipeDetailStep[];
  hasSteps: boolean;
}

interface SectionDraft {
  slot: Slot;
  placements: Placement[];
  batchNotes: SessionBatchNote[];
}

const PART_ORDER: Record<SessionPart, number> = { morning: 0, evening: 1 };
const KIND_ORDER: Record<SessionSectionKind, number> = { now: 0, ahead: 1 };

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// (day, meal type) only: the slot a meal sits in.
function compareSlots(a: SessionMealRef, b: SessionMealRef): number {
  return a.dayIndex - b.dayIndex || MEAL_TYPES.indexOf(a.mealType) - MEAL_TYPES.indexOf(b.mealType);
}

function compareMeals(a: SessionMealRef, b: SessionMealRef): number {
  return compareSlots(a, b) || compareIds(a.mealId, b.mealId);
}

function mealRef(meal: PlanMealRecord): SessionMealRef {
  return { mealId: meal.mealId, dishId: meal.dishId, dayIndex: meal.dayIndex, mealType: meal.mealType };
}

export function sessionKey(date: string, part: SessionPart): string {
  return `${date}-${part}`;
}

function slotKey(slot: Slot): string {
  return `${sessionKey(slot.date, slot.part)}-${slot.kind}`;
}

// Where a meal's fresh steps are cooked: a dinner tonight, every other meal that morning.
function freshSlot(startDate: string, meal: SessionMealRef): Slot {
  const date = addDays(startDate, meal.dayIndex);
  return { date, part: meal.mealType === "dinner" ? "evening" : "morning", kind: "now" };
}

// A make-ahead step goes ahead only while every earlier step of the recipe is make-ahead too: a
// make-ahead step after a fresh one may depend on it, so it is cooked fresh.
function splitSteps(steps: readonly RecipeDetailStep[]): {
  ahead: RecipeDetailStep[];
  fresh: RecipeDetailStep[];
  demoted: string[];
} {
  const sorted = [...steps].sort((a, b) => a.position - b.position || compareIds(a.id, b.id));
  const firstFresh = sorted.findIndex((step) => step.timing !== "make_ahead");
  const cut = firstFresh === -1 ? sorted.length : firstFresh;
  const fresh = sorted.slice(cut);
  return {
    ahead: sorted.slice(0, cut),
    fresh,
    demoted: fresh.filter((step) => step.timing === "make_ahead").map((step) => step.id),
  };
}

// Longest remaining chain first: at each pick, the head step of the entry whose remaining steps add
// up to the most minutes (untimed counts 0). Entries arrive in tie-break order, so the strict `>`
// gives a tie to the earlier one.
function mergeSteps(entries: { entry: CookingSessionEntry; steps: RecipeDetailStep[] }[]): ScheduledStep[] {
  const queues = entries.map(({ entry, steps }) => ({
    entry,
    steps: [...steps],
    remaining: steps.reduce((sum, step) => sum + (step.durationMinutes ?? 0), 0),
  }));
  const ordered: ScheduledStep[] = [];
  for (;;) {
    let best: (typeof queues)[number] | null = null;
    for (const queue of queues) {
      if (queue.steps.length > 0 && (best === null || queue.remaining > best.remaining)) {
        best = queue;
      }
    }
    if (best === null) {
      return ordered;
    }
    const [step] = best.steps.splice(0, 1);
    best.remaining -= step.durationMinutes ?? 0;
    ordered.push({
      ...step,
      recipeId: best.entry.recipeId,
      recipeName: best.entry.recipeName ?? "",
      entryKey: best.entry.key,
    });
  }
}

function buildSection(draft: SectionDraft): CookingSessionSection {
  const key = slotKey(draft.slot);

  // Same-recipe dishes in one section are cooked together: their steps are listed once.
  const byRecipe = new Map<string, Placement[]>();
  for (const placement of draft.placements) {
    byRecipe.set(placement.recipeId, [...(byRecipe.get(placement.recipeId) ?? []), placement]);
  }
  const merged = [...byRecipe.values()].map((placements) => {
    const dishIds = placements.map((placement) => placement.dishId).sort(compareIds);
    const entry: CookingSessionEntry = {
      key: `${key}-${dishIds[0]}`,
      recipeId: placements[0].recipeId,
      recipeName: placements[0].recipeName,
      dishIds,
      meals: placements.flatMap((placement) => placement.meals).sort(compareMeals),
      hasSteps: placements[0].hasSteps,
    };
    return { entry, steps: placements[0].steps };
  });
  merged.sort(
    (a, b) =>
      compareSlots(a.entry.meals[0], b.entry.meals[0]) ||
      (a.entry.recipeName ?? "").localeCompare(b.entry.recipeName ?? "", "pl") ||
      compareIds(a.entry.key, b.entry.key),
  );

  return {
    kind: draft.slot.kind,
    entries: merged.map(({ entry }) => entry),
    steps: mergeSteps(merged),
    batchNotes: [...draft.batchNotes].sort((a, b) => compareMeals(a.meal, b.meal)),
  };
}

export function buildCookingSessions(input: CookingSessionsInput): CookingSchedule {
  const { plan, recipeSteps } = input;

  // The dish is the cooking unit: each is cooked once, whatever its meals or eaters (S-08).
  // Every meal of a dish carries the dish's one recipe.
  const dishes = new Map<string, { recipeId: string; meals: SessionMealRef[] }>();
  for (const meal of plan.meals) {
    const dish = dishes.get(meal.dishId) ?? { recipeId: meal.recipeId, meals: [] };
    dish.meals.push(mealRef(meal));
    dishes.set(meal.dishId, dish);
  }

  const missingRecipeIds = new Set<string>();
  const recipesWithoutSteps = new Set<string>();
  const makeAheadDemoted = new Set<string>();
  const drafts = new Map<string, SectionDraft>();
  const draftAt = (slot: Slot): SectionDraft => {
    const key = slotKey(slot);
    let draft = drafts.get(key);
    if (!draft) {
      draft = { slot, placements: [], batchNotes: [] };
      drafts.set(key, draft);
    }
    return draft;
  };

  for (const [dishId, dish] of dishes) {
    const { recipeId } = dish;
    const meals = [...dish.meals].sort(compareMeals);
    // The earliest meal's day is the cook day: the lowest day of the dish's meals.
    const lead = meals[0];
    const recipe = recipeSteps[recipeId] as RecipeSteps | undefined;
    const recipeName = recipe?.recipeName ?? null;
    const place = (slot: Slot, steps: RecipeDetailStep[], hasSteps: boolean) => {
      draftAt(slot).placements.push({ recipeId, recipeName, dishId, meals, steps, hasSteps });
    };

    let freshAt: Slot | null = null;
    if (!recipe || recipe.steps.length === 0) {
      (recipe ? recipesWithoutSteps : missingRecipeIds).add(recipeId);
      freshAt = freshSlot(plan.startDate, lead);
      place(freshAt, [], false);
    } else {
      const { ahead, fresh, demoted } = splitSteps(recipe.steps);
      demoted.forEach((id) => makeAheadDemoted.add(id));
      if (ahead.length > 0) {
        place({ date: addDays(plan.startDate, lead.dayIndex - 1), part: "evening", kind: "ahead" }, ahead, true);
      }
      if (fresh.length > 0) {
        freshAt = freshSlot(plan.startDate, lead);
        place(freshAt, fresh, true);
      }
    }

    // A later meal of a shared batch adds no steps, only a note where its fresh steps would have gone
    // — unless that is the section already naming it in the entry's meal list.
    for (const meal of meals.slice(1)) {
      const slot = freshSlot(plan.startDate, meal);
      if (freshAt === null || slotKey(slot) !== slotKey(freshAt)) {
        draftAt(slot).batchNotes.push({ meal, recipeName, leadMeal: lead });
      }
    }
  }

  const bySession = new Map<string, SectionDraft[]>();
  for (const draft of drafts.values()) {
    const key = sessionKey(draft.slot.date, draft.slot.part);
    bySession.set(key, [...(bySession.get(key) ?? []), draft]);
  }

  const sessions: CookingSession[] = [...bySession.entries()].map(([key, sessionDrafts]) => {
    const sections = [...sessionDrafts]
      .sort((a, b) => KIND_ORDER[a.slot.kind] - KIND_ORDER[b.slot.kind])
      .map(buildSection);
    const steps = sections.flatMap((section) => section.steps);
    return {
      key,
      date: sessionDrafts[0].slot.date,
      part: sessionDrafts[0].slot.part,
      sections,
      stepCount: steps.length,
      knownMinutes: steps.reduce((sum, step) => sum + (step.durationMinutes ?? 0), 0),
      untimedCount: steps.filter((step) => step.durationMinutes === null).length,
    };
  });
  sessions.sort((a, b) => compareIds(a.date, b.date) || PART_ORDER[a.part] - PART_ORDER[b.part]);

  return {
    planId: plan.id,
    startDate: plan.startDate,
    sessions,
    diagnostics: {
      missingRecipeIds: [...missingRecipeIds].sort(compareIds),
      recipesWithoutSteps: [...recipesWithoutSteps].sort(compareIds),
      makeAheadDemoted: [...makeAheadDemoted].sort(compareIds),
    },
  };
}

// --- display text --------------------------------------------------------------------------------
// The smoke test matches these exact strings; none may contain an apostrophe (Astro escapes it).

export const SESSIONS_UNAVAILABLE = "Cooking sessions are unavailable right now.";
export const SESSIONS_NO_PLAN = "No plan yet — start one to get cooking sessions.";
export const SESSIONS_NO_PLAN_FOR_DATE = "No plan for that date.";
export const SESSIONS_EMPTY = "Nothing to cook: this plan has no meals yet.";
export const SESSIONS_NO_STEPS = "No steps recorded";

// "Monday Lunch"; S-11's batch headings reuse it.
export function mealLabel(startDate: string, meal: Pick<SessionMealRef, "dayIndex" | "mealType">): string {
  return `${weekdayLabel(addDays(startDate, meal.dayIndex))} ${MEAL_TYPE_LABELS[meal.mealType]}`;
}

export function formatSessionTitle(date: string, part: SessionPart): string {
  return `${weekdayLabel(date)} ${SESSION_PART_LABELS[part]}`;
}

export function formatSessionMinutes(session: Pick<CookingSession, "knownMinutes" | "untimedCount">): string {
  const timed = session.knownMinutes > 0 ? `About ${session.knownMinutes} min of steps` : "No timed steps";
  if (session.untimedCount === 0) {
    return timed;
  }
  return `${timed} · ${session.untimedCount} untimed ${session.untimedCount === 1 ? "step" : "steps"}`;
}

export function formatStepDuration(minutes: number | null): string {
  return minutes === null ? "no set time" : `${minutes} min`;
}

export function formatEntryMeals(entry: Pick<CookingSessionEntry, "meals" | "dishIds">, startDate: string): string {
  const meals = `For ${joinList(entry.meals.map((meal) => mealLabel(startDate, meal)))}`;
  return entry.dishIds.length > 1 ? `${meals} · ${entry.dishIds.length} batches` : meals;
}

export function formatBatchNote(note: SessionBatchNote, startDate: string): string {
  return `${MEAL_TYPE_LABELS[note.meal.mealType]}: from the same batch as ${mealLabel(startDate, note.leadMeal)} — nothing new to cook.`;
}
