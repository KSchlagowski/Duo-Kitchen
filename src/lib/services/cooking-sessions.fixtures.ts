import type { MealPlan, PlanMealRecord, RecipeDetailStep, RecipeSteps, StepTiming } from "@/types";
import { recipeId, SEED_RECIPES } from "@/lib/services/macro-solver.fixtures";

// The 33 seed steps as schedule input, transcribed from
// supabase/migrations/20261007120100_seed_products_and_recipes.sql (moved unchanged into the public
// library by 20261008150000_shared_recipe_library.sql). Ids, positions, timings, durations and
// components are the seed's; instructions are shortened. A later seed migration re-transcribes from:
//   select id, recipe_id, position, timing, duration_minutes from public.recipe_steps
//   where id::text like '5eed0005-%' order by id;
// Component names come from macro-solver.fixtures.ts, so they match recipe_components.name.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Step id 5eed0005-…-000000000RPP; component c of recipe r is 5eed0003-…-00000000RRCC.
function step(
  r: number,
  position: number,
  timing: StepTiming,
  componentPosition: number | null,
  durationMinutes: number | null,
  instruction: string,
): RecipeDetailStep {
  const componentName =
    componentPosition === null
      ? null
      : (SEED_RECIPES[recipeId(r)].components.find((component) => component.position === componentPosition)?.name ??
        null);
  return {
    id: `5eed0005-0000-4000-8000-000000000${r}${pad(position)}`,
    position,
    instruction,
    timing,
    componentName,
    durationMinutes,
  };
}

const STEPS: Record<number, RecipeDetailStep[]> = {
  1: [
    step(1, 1, "fresh", 1, 2, "Roztop masło."),
    step(1, 2, "fresh", 1, 5, "Wbij jajka i smaż."),
    step(1, 3, "fresh", 1, 1, "Posyp szczypiorkiem."),
    step(1, 4, "fresh", 2, 2, "Pokrój chleb i podaj."),
  ],
  2: [
    step(2, 1, "make_ahead", 1, 5, "Wymieszaj bazę, rozłóż do słoików."),
    step(2, 2, "make_ahead", 1, null, "Wstaw na noc do lodówki."),
    step(2, 3, "fresh", 2, 3, "Wyłóż owoce."),
  ],
  3: [
    step(3, 1, "make_ahead", null, 10, "Rozgrzej piekarnik."),
    step(3, 2, "make_ahead", 1, 5, "Rozgnieć banany, wymieszaj."),
    step(3, 3, "make_ahead", 1, 5, "Dodaj suche składniki."),
    step(3, 4, "make_ahead", 1, 15, "Uformuj i piecz."),
    step(3, 5, "make_ahead", 1, 10, "Wystudź i przełóż."),
  ],
  4: [
    step(4, 1, "make_ahead", 1, 15, "Ugotuj ryż."),
    step(4, 2, "make_ahead", 2, 5, "Pokrój kurczaka."),
    step(4, 3, "make_ahead", 2, 10, "Obsmaż kurczaka."),
    step(4, 4, "make_ahead", 3, 15, "Ugotuj sos."),
    step(4, 5, "fresh", null, 5, "Odważ porcje, odgrzej i podaj."),
  ],
  5: [
    step(5, 1, "make_ahead", 2, null, "Rozmróź krewetki."),
    step(5, 2, "fresh", 1, 10, "Ugotuj makaron."),
    step(5, 3, "fresh", 2, 6, "Podsmaż krewetki."),
    step(5, 4, "fresh", 2, 2, "Dopraw i podaj."),
  ],
  6: [
    step(6, 1, "make_ahead", 1, 15, "Pokrój warzywa i kiełbasę."),
    step(6, 2, "make_ahead", 1, 10, "Podsmaż kiełbasę."),
    step(6, 3, "make_ahead", 1, 30, "Duś 30 minut."),
    step(6, 4, "make_ahead", 1, 5, "Dopraw, wystudź, przełóż."),
    step(6, 5, "fresh", 1, 5, "Odgrzej porcje."),
  ],
  7: [
    step(7, 1, "make_ahead", 1, 3, "Rozgnieć twaróg."),
    step(7, 2, "make_ahead", 1, 5, "Wmieszaj szczypiorek i rzodkiewkę."),
    step(7, 3, "fresh", 2, 1, "Przekrój bułki i podaj."),
  ],
  8: [
    step(8, 1, "make_ahead", 1, 10, "Ugotuj makaron."),
    step(8, 2, "make_ahead", 1, 10, "Podsmaż kurczaka."),
    step(8, 3, "make_ahead", 1, 10, "Wymieszaj i przełóż do naczynia."),
    step(8, 4, "fresh", 1, 25, "Zapiekaj 25 minut."),
  ],
};

export const SEED_RECIPE_STEPS: Record<string, RecipeSteps> = Object.fromEntries(
  Object.entries(STEPS).map(([r, steps]) => {
    const id = recipeId(Number(r));
    return [id, { recipeId: id, recipeName: SEED_RECIPES[id].name, steps }];
  }),
);

// A plan starting on Monday 2031-01-20, the smoke test's shared-batch plan.
export function planOf(meals: PlanMealRecord[]): MealPlan {
  return { id: "plan", startDate: "2031-01-20", updatedAt: "2031-01-20T00:00:00Z", meals };
}
