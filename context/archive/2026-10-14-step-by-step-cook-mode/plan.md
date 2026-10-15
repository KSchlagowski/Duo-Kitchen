# Step-by-Step Cook Mode (S-11) Implementation Plan

## Overview

Roadmap S-11 (US-03, FR-023; prerequisites S-10 and S-04, both done): from `/plan/sessions`, a signed-in household member opens one cooking session (for example "Sunday evening") and **follows it one step at a time**. Every step shows the amounts it uses, and when a dish is ready to be divided the page shows **how much goes to each person** (You / Partner), taken from the stored day solve.

The slice joins two pure, derived-on-read systems that already exist: the S-10 schedule (`buildCookingSessions()`) and the stored S-04/S-08 solve (`plan_day_solutions`, read through `getPlanSolveState()`). Like S-09 and S-10 it stores nothing on the server: no table, migration, RPC or KD code. Per-step "done" ticks live in the viewer's browser only.

This plan was written in a non-interactive session. Every open question from the research is settled below as a **[Decision]** with its alternative named, so a reviewer can overturn any of them before implementation starts.

## Current State Analysis

- **Schedule (S-10).** `buildCookingSessions({ plan, recipeSteps })` (`src/lib/services/cooking-sessions.ts:174`) returns up to 7 sessions keyed `<YYYY-MM-DD>-<part>`. Each session has `now` / `ahead` sections. A section holds entries (one recipe × one or more plan `dishId`s × their meals), one merged step order (`ScheduledStep`) and batch notes for later meals of a shared batch. It carries no amounts. The I/O is `getCookingSchedule()` (`src/lib/services/cooking.ts:12`), and the page is `src/pages/plan/sessions.astro` (server-rendered, no island).
- **Stored solve (S-04/S-08).** `getPlanSolveState(supabase, plan)` (`src/lib/services/day-solutions.ts:321`) is the single currency rule. It returns `currentSolutions` (only days of current solve groups, any stored status, already gated by `parseStoredSolution()`'s zod schema) and `recipes` (the library `SolverRecipe`s it loaded anyway). `getShoppingList()` (`src/lib/services/shopping.ts:15`) is the precedent for combining a plan read with it.
- **Stored meal shape** (`src/types.ts:216-255`). Each stored meal has `mealId`, `batch`, and per-component `ingredients` (`amountG` = the **batch** amount; `perPerson` = this meal's eaters only) and `split` (one share per `(meal, eater)` serving). Every meal row of a shared batch carries the full batch amounts. A dish feeding two meals of one day appears twice in that day's `meals[]`.
- **Rendering helpers.** `formatSplitLine(component, viewerId, context?)` and `viewerFirst()` live in `day-solutions.ts:568-692`. That module imports zod, Supabase and the solver, so an island must not import it. `formatIngredientAmount()` is in the pure `src/lib/services/recipe-macros.ts`. `/plan/day` (`src/pages/plan/day.astro:247-306`) shows how amounts and split lines are rendered, including `ownOnly` for a batch cooked on another day.
- **Steps cannot be tied to amounts yet.** `RecipeDetailStep` (`src/types.ts:78-85`) has `componentName` but no `componentId`. `getRecipeSteps()` (`src/lib/services/recipes.ts:323-369`) and `getRecipeDetail()` (`:167-208`) already select `component_id` but map it to a name only. Component names are not unique within a recipe, and the stored solve keys components by library `id`.
- **Step text carries no quantities** (`supabase/migrations/20261007120100_seed_products_and_recipes.sql:212-243`), so "portions" means showing stored amounts and splits next to the steps.
- **Island precedent.** `src/components/shopping/ShoppingList.tsx` + `src/components/hooks/useShoppingChecks.ts`: server-rendered with working no-JS forms, `client:idle`, imports only the pure `shopping-list.ts`.
- **Routing.** `/plan` is a `startsWith` prefix in `PROTECTED_ROUTES` (`src/middleware.ts`), so `/plan/sessions/cook` is protected for free. `src/pages/plan.astro` + `src/pages/plan/day.astro` show that a page file and a same-named folder coexist.
- **Smoke windows on plan `2031-01-20`** (`scripts/smoke.mjs`): the group is solved and shared between "A plan page shows both days of the group with one identical status" (`:1069`) and "B marks Tuesday's lunch for A only" (`:1113`). It is stale between `:1117` and the un-share at `:1140`.
- `context/foundation/lessons.md` does not exist.

## Desired End State

- `/plan/sessions` shows a **Cook step by step** link on every session. It opens `/plan/sessions/cook?start=<planStart>&session=<sessionKey>`.
- The cook page shows, top to bottom:
  1. the session title and date (`Sunday evening`, `2031-01-19`), and a source note per section: exact (`Amounts and portions from the day solve of Monday.`) or estimate (`Estimate for Monday: recipe base amounts and no portions yet — solve Monday to get them.`, with a link to that day's solve page);
  2. **the current step card**: `Step 2 of 12`, the section label in evenings (Tonight / For tomorrow), the recipe and component, the Polish instruction, the timing badge and duration, the **amounts this step uses** (its component's ingredients, per batch), and — on the last step of a dish in that section — the **portions** for You and Partner;
  3. **Previous / Next** links (the last step's Next becomes "Back to sessions"), plus a "Done — next step" button once JavaScript has loaded;
  4. **All steps**: the numbered step list, each linking to its step, the current one highlighted and done ones ticked;
  5. **Ingredients and portions**: per dish (per batch for merged entries) the full ingredient amounts and every component's split line, plus a **serving note** with that meal's own portions for each later meal of a shared batch.
- Without JavaScript every step is reachable through `?step=N` links. With JavaScript (`client:idle` island) Previous / Next / Done switch steps in place and update the URL, done ticks persist per device in `localStorage`, and a "Keep screen on" toggle appears where the Screen Wake Lock API exists.
- Both partners see the same amounts, with "You" and "Partner" swapped.
- Malformed or missing `start` / `session` / `step` → 404. A session key that is not in the plan → 404. A date with no plan → `No plan for that date.` A failed read → 500, never "no plan". A `step` above the step count shows the last step.
- `npm test` (new `cook-mode.test.ts`), lint, `astro check`, build and `npm run smoke` (new S-11 section) pass. `test:rls`, `test:seed` and `check:migrations` are untouched. CLAUDE.md and README describe the slice.

### Key Discoveries:

- **Currency is uniform per section, not per session.** Every dish in one section has its lead meal on the same day (`now`: the session's own day; `ahead`: the next day), and a day belongs to exactly one solve group. So exact-vs-estimate is decided per section. An evening's Tonight and For tomorrow can differ (`cooking-sessions.ts:85-88`, `:219-221`).
- **Look stored rows up by meal id, not by "first row per dish".** `perPerson` holds only the eaters of *that row's* meal (`src/types.ts:223-225`). The portions for a dish's cooking must come from its **lead meal's** row, and a serving note's own portions from **that meal's** row. Since every row of a batch carries identical batch amounts, the lead meal's row is also the canonical amount source. This picks exactly one row per dish, so the S-09 dedup invariant ("count each `dishId` once, never sum") holds without sharing `storedMealsByDish()`.
- **`formatSplitLine` already speaks shared batches.** With a `SplitLineContext` naming the lead meal and its day, it lists this meal's servings first and suffixes the rest (`You (Tuesday): …`). With `ownOnly` it gives one meal's own portions, a percent share also in grams (`day-solutions.ts:614-692`). Cook mode needs no new split wording.
- **Seed shape for per-step amounts.** Curry steps 401-404 each have a component (rice, chicken, sauce), and 405 ("Odważ porcje, odgrzej i podaj") has none. Ciastka step 301 ("Rozgrzej piekarnik") has none. So a null-component step must render without amounts, and the "portion it out" moment has to be found structurally (D4), not from step text.

## What We're NOT Doing

- **No server-side progress.** No `cook_step_checks` table, RPC, KD codes or isolation-test change. Done ticks and the current step are per device; partners do not see each other's progress.
- **No amounts inside the instruction text**, and no rewriting of recipe content (it stays Polish, FR-026).
- **No timers, alarms, clock times or parallel lanes.** No service worker or offline mode (F-03).
- **No library schema change** (no `serve` / `reheat` timing value, no equipment). Reheat-and-serve for a later meal of a shared batch is covered by the serving note.
- **No re-derivation of quantities.** Exact amounts and splits come only from the stored solve; estimates come only from the library base amounts. Nothing is scaled, summed across batches or re-split.
- **No solving from the cook page.** It links to `/plan/day` instead.
- **No changes to the S-10 schedule rules**, step order or `/plan/sessions` layout beyond the new link.
- **No keyboard shortcuts, swipe gestures or speech.**

## Implementation Approach

The slice keeps the pure-core / thin-shell split of S-09 and S-10:

1. **Groundwork and pure engine** (Phase 1): add `componentId` to steps, move the split-line formatters into an island-safe pure module, add the S-11 types and labels and the pure builder `buildCookMode()` with its display strings, and pin it with vitest. No user-visible change.
2. **Server-rendered cook page** (Phase 2): the I/O function, `/plan/sessions/cook` with `?step=N` navigation that works without JavaScript, and the entry links on `/plan/sessions`. The slice is usable end to end after this phase.
3. **Focus-mode island** (Phase 3): in-place step switching, per-device done ticks and the optional wake lock, as a progressive enhancement over Phase 2's markup.
4. **Smoke and docs** (Phase 4).

### Decisions taken in place of questions

- **[Decision] D1 — Progress is client-only** (research Open Q1, option B). The current step is the `step` URL parameter, and done ticks are in `localStorage` under `duo-kitchen:cook:<planId>:<sessionKey>`, holding step ids. Nothing in FR-023 asks for shared progress, and a server-side version would bring the whole S-09 write stack (table, definer RPC, KD codes, isolation test). *Alternative:* option C, shared household progress. Revisit if the couple cook one session together on two phones.
- **[Decision] D2 — Route** `/plan/sessions/cook?start=<YYYY-MM-DD>&session=<YYYY-MM-DD>-<morning|evening>[&step=<n>]` (S-10's D11 suggestion). `start` and `session` are both **required**: the link always passes them, and a session key alone is ambiguous across overlapping plans. `step` is 1-based over the session's steps in display order (sections in `now`, `ahead` order, each in its merged order). Missing `step` means 1. A malformed value (`^[1-9]\d{0,2}$` fails) is 404. A well-formed value above the step count shows the last step, because a plan edit can shorten a session that is open on a phone. *Alternative:* `/plan/sessions/<key>/cook` path segments. Rejected: every other plan page keys by `?start=`.
- **[Decision] D3 — Exact vs estimate, per section** (research Open Q2). A section is **exact** when `currentSolutions[day]` exists for its dishes' lead day, where `day` is the section's own day for `now` and the next day for `ahead`. Exact amounts and splits come from the lead meal's stored row (Key Discoveries). Any stored status counts, including `needs_confirmation` and `no_fit`, as in S-09's A2. Otherwise the section is an **estimate**: library base amounts from `state.recipes` (`baseAmountG`), **no split lines**, and a note linking to `/plan/day?start=…&day=<lead day>`. If a current day's solution unexpectedly lacks the lead meal's row, that dish falls back to the estimate and is recorded in `diagnostics.dishesFellBack` (S-09 precedent). The page never blocks (PRD guardrail, `prd.md:45`). *Alternative:* hide amounts until solved. Rejected: a plan is usable unsolved.
- **[Decision] D4 — Per-step amounts and the portion moment** (research Open Q4). Add `componentId: string | null` to `RecipeDetailStep`. A step with a component shows **that component's ingredient amounts** (one block per batch of the entry). A step with no component shows no amounts. The **last step of each entry within a section** also shows the entry's **portions**: every component's split line, per batch. That is when a dish is finished, divided or packed (curry 404 "sauce" ahead, curry 405 "weigh portions, reheat and serve" fresh, leczo 604 "season, cool, transfer"). *Alternative:* entry-level amounts only, without the type change. Rejected: in the kitchen, the amounts for the step in hand are the point of a step-by-step mode.
- **[Decision] D5 — Merged same-recipe entries list amounts and portions per batch** (research Open Q3, **overriding** the research's assumption (a)). The steps stay listed once, but each batch keeps its own ingredient block and split lines, headed by its meals (`For Monday Lunch`, `For Monday Dinner`). Each stored batch has its own amounts. A summed list would be a new derived quantity, and a percent split ("Partner: 40% of the dish") would become ambiguous once two batches share a pot. *Alternative:* (a) one summed list.
- **[Decision] D6 — Split-line context.** An entry's portions use `formatSplitLine` with the context of **each batch's lead meal**: `mealId` = lead meal, `viewedDay` = its day, not `ownOnly`. So a batch eaten on two days reads `You: … · Partner: … · You (Tuesday): … · Partner (Tuesday): …`, which tells the cook how to divide the batch into containers. In a per-component recipe, each line is prefixed by the component name, as on `/plan/day`.
- **[Decision] D7 — Serving notes** (research Open Q5). Each S-10 batch note in the session becomes a serving note: the S-10 text (`Lunch: from the same batch as Monday Lunch — nothing new to cook.`) followed by **that meal's own portions** (`ownOnly` context with the note meal's id and day, read from the note meal's own stored row). On an estimate section it shows the text only. A serving note is not a step and is not counted by `step`.
- **[Decision] D8 — Island-safe formatting.** The pure builder returns a **display-ready view model** (strings, not raw stored rows), so the island only renders. To let the builder use `formatSplitLine` without pulling in zod, Supabase or the solver, move the split-line formatters out of `day-solutions.ts` into a new pure `src/lib/services/split-lines.ts`. `day-solutions.ts` re-exports them, so no existing import changes (research Open Q7).
- **[Decision] D9 — Screen wake lock** (research Open Q9): an opt-in "Keep screen on" toggle, rendered only after hydration and only when `"wakeLock" in navigator`. It is re-acquired on `visibilitychange` (the browser drops it when the tab is hidden) and released on unmount or toggle-off. A failed request just turns the toggle off. Chrome, Edge and Safari 16.4+ ship the API, so iOS gets it where supported, and nothing depends on it.
- **[Decision] D10 — Smoke placement** (research Open Q8). The exact-portion assertions go inside the solved-and-shared window (right after "Tuesday's day page eats from Monday's batch, with no batch amounts", before "B marks Tuesday's lunch for A only"). One estimate assertion goes in the stale window (right after the S-09 stale shopping check). See Critical Implementation Details.

## Critical Implementation Details

- **Smoke ordering.** S-11's exact-portion steps depend on plan `2031-01-20` being solved **and** shared. Insert them between `:1110` and `:1113`, with an order-sensitivity comment like the S-09 ones (`:1074`, `:1123`). The S-10 block runs later on a stale group and must stay where it is.
- **No apostrophes in pinned strings.** Astro escapes `'` as `&#39;`. Every string the smoke test matches is apostrophe-free. `formatFromBatchNote` ("Monday's batch") must not be reused.
- **Hydration.** The island's server render must equal its first client render. So `localStorage` ticks and wake-lock support are read in `useEffect`, never in a `useState` initialiser. Every storage access is wrapped in `try/catch` (private mode, blocked storage).
- **History.** In-place navigation uses `history.replaceState`, so Back from the cook page returns to `/plan/sessions` and not through every step. Each Previous / Next is still a real `<a href="?…&step=N">`, so no-JS navigation and "open in new tab" keep working.
- **Focus.** After an in-place step change, move focus to the step card's heading (`tabIndex={-1}`), so screen readers announce the new step and the page scrolls to it on a phone.

## Phase 1: Groundwork and pure cook-mode engine

### Overview

Tie steps to components, make split-line formatting island-safe, add the S-11 types, labels and the pure builder with its display strings, and pin it with vitest. Nothing user-visible changes.

### Changes Required:

#### 1. `componentId` on steps

**Files**: `src/types.ts`, `src/lib/services/recipes.ts`, `src/lib/services/cooking-sessions.fixtures.ts`

**Intent**: Expose the library component id that both step reads already select, so a step can be matched to the stored solve's `DaySolutionComponent.id` (D4).

**Contract**:
- `RecipeDetailStep` gains `componentId: string | null`, placed next to `componentName`. `ScheduledStep` inherits it.
- `getRecipeSteps()` and `getRecipeDetail()` set it from `row.component_id`. No query changes.
- The fixture `step()` sets `componentId` from `SEED_RECIPES[recipeId(r)].components.find(c => c.position === componentPosition)?.id ?? null`, the same lookup that already supplies `componentName`.
- The recipe detail page ignores the new field.

#### 2. Island-safe split-line formatters

**Files**: `src/lib/services/split-lines.ts` (new), `src/lib/services/day-solutions.ts`

**Intent**: Move the split-line formatting code unchanged into a pure module, so the cook-mode builder (which the island imports) can use it (D8).

**Contract**:
- Move `personLabel`, `viewerFirst`, `formatPieces`, `formatGramsShort`, `SplitLineContext`, `percentShareGrams`, `isOwnShare`, `shareSuffix` and `formatSplitLine` into `split-lines.ts`. It may import only types, `recipe-labels.ts` and `roundHalfUp` from `recipe-macros.ts`.
- `day-solutions.ts` imports what it still uses (`personLabel` for `formatPersonLine` / `formatEaters`) and re-exports `formatSplitLine`, `viewerFirst` and `type SplitLineContext`, so `day.astro` and `day-solutions.test.ts` are untouched.
- Behaviour is byte-for-byte unchanged, and the existing `formatSplitLine` tests must pass without edits.

#### 3. Types

**File**: `src/types.ts`

**Intent**: Add an `--- S-11: step-by-step cook mode ---` block holding the display-ready view model the page and island render. Strings are already viewer-relative.

**Contract** (field names are what Phases 2–4 depend on):

```ts
export type CookAmountSource = "exact" | "estimate";

export interface CookIngredientLine { ingredientId: string; productName: string; amount: string } // formatted
export interface CookPortionLine { componentName: string | null; line: string } // name only for per_component recipes

// One batch's amounts for one component (a step) or for the whole dish (the overview).
export interface CookBatchAmounts {
  dishId: string;
  heading: string | null; // "For Monday Lunch" — set only when the entry has more than one batch (D5)
  ingredients: CookIngredientLine[];
}
export interface CookBatchPortions { dishId: string; heading: string | null; lines: CookPortionLine[] }

export interface CookStep {
  number: number; // 1-based across the session
  id: string; // recipe_steps id
  sectionKind: SessionSectionKind;
  entryKey: string;
  recipeId: string;
  recipeName: string;
  componentName: string | null;
  instruction: string;
  timing: StepTiming;
  durationMinutes: number | null;
  amounts: CookBatchAmounts[]; // empty for a null-component step (D4)
  portions: CookBatchPortions[] | null; // set on the entry's last step in its section; null on an estimate section, and batches that fell back to the estimate are left out
}

export interface CookEntryOverview {
  key: string; recipeId: string; recipeName: string | null; mealsLine: string; // formatEntryMeals()
  hasSteps: boolean;
  batches: {
    dishId: string;
    heading: string | null;
    // one block per component, as on /plan/day; componentName set only for per_component recipes
    components: { componentName: string | null; ingredients: CookIngredientLine[]; portion: string | null }[];
  }[];
}
export interface CookServingNote { mealId: string; dayIndex: PlanDayIndex; mealType: MealType; text: string; portions: CookPortionLine[] }

export interface CookModeSection {
  kind: SessionSectionKind;
  source: CookAmountSource;
  sourceDayIndex: PlanDayIndex; // the lead day its amounts come from (and the solve link's day)
  boundsWarning: boolean; // exact only: currentSolutions[sourceDayIndex].boundsViolated
  entries: CookEntryOverview[];
  servingNotes: CookServingNote[];
}

export interface CookModeView {
  planId: string; startDate: string; sessionKey: string; date: string; part: SessionPart;
  sections: CookModeSection[];
  steps: CookStep[];
  diagnostics: { dishesFellBack: string[]; missingRecipeIds: string[] };
}
```

#### 4. Labels

**File**: `src/lib/recipe-labels.ts`

**Intent**: Add an `--- S-11: cook mode ---` block, so S-14 localises one file.

**Contract**: `COOK_MODE_LABELS` (as const) with `cookLink: "Cook step by step"`, `previous: "Previous"`, `next: "Next"`, `doneNext: "Done — next step"`, `finish: "Back to sessions"`, `allSteps: "All steps"`, `overview: "Ingredients and portions"`, `amounts: "You need"`, `portions: "Portions"`, `keepScreenOn: "Keep screen on"`.

#### 5. Pure builder and display strings

**File**: `src/lib/services/cook-mode.ts` (new)

**Intent**: Join one S-10 session with the current stored solves into the view model (D3–D7). Keep it pure: it imports only types, labels, `cooking-sessions.ts` (formatters), `meal-plans.ts` (`addDays`, `weekdayLabel`, `MEAL_TYPES`), `recipe-macros.ts` (`formatIngredientAmount`), `split-lines.ts` and `utils.ts`. It must never import `day-solutions.ts`, `macro-solver.ts`, zod or Supabase. Its header comment states this, as `shopping-list.ts` does.

**Contract**:
- `buildCookMode(input: { plan: MealPlan; session: CookingSession; currentSolutions: Partial<Record<PlanDayIndex, DaySolution>>; recipes: Record<string, SolverRecipe>; viewerId: string }): CookModeView`.
  1. For each section: the lead day is the section date's day index for `now`, plus one for `ahead`. The section is exact if `currentSolutions[leadDay]` exists (D3). `boundsWarning` is true when the section is exact and `currentSolutions[leadDay].boundsViolated` is true.
  2. For each entry and each of its `dishIds`, the batch's lead meal is the dish's first meal in `entry.meals`. Exact: the stored row is `currentSolutions[lead.dayIndex].meals.find(m => m.mealId === lead.mealId)`. If it is missing, use the estimate for this dish and push to `dishesFellBack`. Estimate: `recipes[entry.recipeId]` components with `baseAmountG`; if absent, no amounts and push to `missingRecipeIds`.
  3. Ingredient lines use `formatIngredientAmount(amountG, gramsPerPiece, allowHalfPieces)`. Estimate lines use the `SolverIngredient` fields. Portions apply `formatSplitLine` per component with the D6 context; `weekdayOf` and `mealTypeOf` are built from the plan. Estimate batches have no portion lines.
  4. Steps are numbered across sections in display order. `amounts` = the step's `componentId` component, per batch. `portions` is set only on the last step of each `entryKey` within its section (D4), and only on an exact section: it is `null` on an estimate section, and a batch that fell back to the estimate contributes no `CookBatchPortions` (if none remain, `portions` is `null`). The overview groups each batch's ingredients by component (one block per component, with that component's split line as `portion`, null when estimate).
  5. Serving notes come from `section.batchNotes` (D7), using `formatBatchNote()` for the text and `ownOnly` portions from the note meal's own row.
- Output is deterministic and depends only on its input.
- Display text, all apostrophe-free:
  - `COOK_UNAVAILABLE = "Cook mode is unavailable right now."`
  - `COOK_NO_PLAN_FOR_DATE = "No plan for that date."`
  - `COOK_NO_STEPS = "No steps recorded for this session — the amounts are below."`
  - `COOK_BOUNDS_WARNING = "Some amounts break the solver limits — check them on the day page before cooking."`
  - `formatStepCounter(n, total)` → `"Step 2 of 12"`
  - `formatCookExactNote(weekday)` → `"Amounts and portions from the day solve of Monday."`
  - `formatCookEstimateNote(weekday)` → `"Estimate for Monday: recipe base amounts and no portions yet — solve Monday to get them."`
  - `formatBatchHeading(meals, startDate)` → `"For Monday Lunch"`, built from the S-10 meal label (no `· N batches`). `mealLabel()` is module-private in `cooking-sessions.ts` today, so export it from there and reuse it rather than duplicating it.
  - `cookPath(startDate, sessionKey, step?)` → `/plan/sessions/cook?start=…&session=…[&step=n]`, shared by the page, the island and the sessions link.

#### 6. Unit tests

**File**: `src/lib/services/cook-mode.test.ts` (new)

**Intent**: Pin D3–D7 on real solver output. Build stored solutions by running `solveGroup()` over the seed fixtures (`SEED_RECIPES`, `USER_A`/`USER_B`, `TARGET_A`/`TARGET_B` from `macro-solver.fixtures.ts`), as `day-solutions.test.ts` does for split lines. Build sessions with `buildCookingSessions()` over `SEED_RECIPE_STEPS` and `planOf()`.

**Contract** (one `it` each, at minimum):
- **Shared batch, cook side** (`planOf(F5)` solved, Sunday evening): the curry entry has exactly one batch whose ingredient amounts equal the Monday-lunch stored row's `amountG` values. Its portions appear only on step 404's card (the entry's last step in the section), and those lines include `(Tuesday)` servings. Steps 402 and 403 carry the chicken component's amounts, and step 401 carries the rice's.
- **Shared batch, serve side** (Tuesday morning): one serving note for Tuesday lunch whose portion lines equal `formatSplitLine(…, { ownOnly: true })` on Tuesday's own row, with no `(Monday)` suffix. No curry step appears in the session.
- **No double counting**: within any one session each plan `dishId` yields exactly one batch block, and Tuesday morning has no curry batch block, only the serving note — even though both days' rows carry the full batch.
- **Same-day double meal**: build a day with the curry at both lunch and dinner (`day([…, CURRY, …, CURRY])`), then `shareDish(…, [0,"lunch"], [0,"dinner"])`. The batch reads its portions from the lunch row, with `(Dinner)`-suffixed servings.
- **Merged entry (D5)**: Leczo at Monday lunch and dinner as two dishes gives one Sunday-evening entry with two batch blocks, headed `For Monday Lunch` and `For Monday Dinner`. Each block holds its own stored amounts, and steps are listed once.
- **Null-component step**: curry 405 in Monday morning has `amounts: []` and, being the entry's last step there, the portions.
- **Per-person components**: Jajecznica *Pieczywo* renders a `pieces` split, and Owsianka *Owoce* renders `per_ingredient` per-person lines.
- **Bounds warning**: a solved fixture with `boundsViolated: true` set on the lead day gives `boundsWarning: true` on that section; an estimate section is always `false`.
- **Estimate (D3)**: the same plan with `currentSolutions = {}` gives `source: "estimate"` on every section, amounts equal to `baseAmountG`, and no portion lines anywhere, serving notes included. A current day missing a dish's row puts that dish in `diagnostics.dishesFellBack`.
- **Evening mixes sources**: with only day 1 current, Monday evening's Tonight section (day 0) is an estimate and its For tomorrow section (day 1) is exact.
- **Viewer relativity**: `viewerId = USER_B` yields the same numbers with You and Partner swapped. Compare parsed share maps, not strings (`formatSplitLine` sorts the viewer's shares first): a test helper strips the `<component>: ` prefix, splits on ` · `, maps each `Label(suffix): value` segment to `{ "<label><suffix>": value }`, swaps You↔Partner in the keys (and `All for you` ↔ `All for your partner`), and compares the non-share tail segments (`split in half`, `split evenly N ways`) verbatim.
- **Estimate portions**: on an estimate section the entry's last step has `portions: null`.
- **Numbering**: steps are numbered 1…N across Tonight then For tomorrow, and their ids equal the session's merged order.
- **Formatters**: `formatStepCounter`, the exact and estimate notes, `formatBatchHeading` and `cookPath` (with and without `step`).

### Success Criteria:

#### Automated Verification:

- Unit tests pass, including the unchanged `formatSplitLine` tests: `npm test`
- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`
- The island-safety rule holds: `cook-mode.ts` and `split-lines.ts` import nothing from `day-solutions`, `macro-solver`, `zod` or `@supabase` (check with Grep over the two files)

#### Manual Verification:

- Start `npm run dev` and sign in. Open `/plan/day?start=2031-01-20&day=0` (or any solved day of yours). The split lines under each meal read exactly as before the move (`You: … g cooked · Partner: … g cooked`, with `(Tuesday)` suffixes on a shared batch).
- Open `/recipes`, then **Kurczak curry z ryżem**. The steps list, with each step's component name, renders as before.
- Open `/plan/sessions?start=2031-01-20`. The page renders exactly as before (no user-visible change is expected in this phase).

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Server-rendered cook page and entry links

### Overview

Wire the builder to the database and render `/plan/sessions/cook`, with `?step=N` navigation that works without JavaScript, and link to it from every session on `/plan/sessions`. The slice is usable end to end after this phase.

### Changes Required:

#### 1. I/O

**File**: `src/lib/services/cooking.ts`

**Intent**: Read the plan once, then load the steps and the solve state in parallel, and build both the schedule and the session's cook view. This mirrors `getShoppingList()`.

**Contract**:
- Extract a private `scheduleOf(plan, recipeSteps)` that runs `buildCookingSessions()` and logs its diagnostics. `getCookingSchedule()` keeps its signature and behaviour.
- `getCookMode(supabase, startDate: string, sessionKey: string, viewerId: string): Promise<{ plan: MealPlan; view: CookModeView | null } | null>`. It returns `null` when there is no plan, and `view: null` when the key is not one of the plan's sessions. It runs `Promise.all([getRecipeSteps(...), getPlanSolveState(supabase, plan)])`. A failed read throws.
- When `view.diagnostics` has entries, it calls `console.error("buildCookMode worked around inconsistent inputs", plan.id, view.diagnostics)`, with the same eslint-disable comment as `cooking.ts:28`.

#### 2. Cook page

**File**: `src/pages/plan/sessions/cook.astro` (new)

**Intent**: Render one session's cook view server-side, step by step, using the state machine of `sessions.astro` (`not-found` 404, `unavailable` 500, `no-plan`, `loaded`).

**Contract**:
- **Validation** before any query (D2):
  - `start` must pass `isIsoDate`;
  - `session` must match `^(\d{4}-\d{2}-\d{2})-(morning|evening)$` with an `isIsoDate` date part;
  - `step`, if present, must match `^[1-9]\d{0,2}$`.
  - Any failure → `not-found`. `view === null` → `not-found`.
- **Viewer**: `Astro.locals.user?.id ?? ""`. Clamp the step to `[1, steps.length]`.
- **Markup**, top to bottom:
  - Title `formatSessionTitle()` with the date. Under it, per section, a source note as `<p data-testid="cook-source-<kind>">`: `formatCookExactNote` or `formatCookEstimateNote`, the latter followed by a `Solve <weekday>` link to `/plan/day?start=…&day=<sourceDayIndex>`. When `boundsWarning` is true, render `<p data-testid="cook-bounds-<kind>">{COOK_BOUNDS_WARNING}</p>` under the source note, with a link to `/plan/day?start=…&day=<sourceDayIndex>`.
  - **Step card** `<section id="cook-step" data-testid="cook-step" data-step-id={step.id}>`:
    - `<p data-testid="cook-step-counter">{formatStepCounter}</p>`;
    - the section label in evenings (`SESSION_SECTION_LABELS`);
    - recipe · component, instruction, timing badge (`STEP_TIMING_LABELS`, the same `cn()` badge classes as `sessions.astro:159-165`), duration (`formatStepDuration`);
    - a "You need" block per `amounts` batch (`<ul data-testid="cook-step-amounts">`, with each heading when set);
    - when `portions` is set, a "Portions" block `<div data-testid="cook-step-portions">` with one `<p>` per line (`<componentName>: <line>` when the name is set).
  - **Navigation**: Previous (`cookPath(…, n-1)`, omitted on step 1) and Next (`cookPath(…, n+1)`). On the last step, Next is replaced by "Back to sessions" (`/plan/sessions?start=…#<sessionKey>`). The links have `data-testid="cook-prev"` / `"cook-next"` / `"cook-finish"`.
  - **All steps**: `<ol data-testid="cook-all-steps">`, each `<li data-step-id>` linking to its `cookPath`, the current one marked with `aria-current="step"` and highlighted via `cn()`.
  - **Ingredients and portions**: per section (with its label in evenings), per entry: the recipe name (linking to `/recipes/<id>`; "Unknown recipe" when null), `mealsLine`, then per batch a `<div data-testid="cook-batch-<dishId>">` wrapper holding the heading and, per component, the component name (when set), its ingredient `<ul>` and its portion `<p>` (when set), all inside `<div data-testid="cook-entry-<kind>-<recipeId>">`. Then serving notes as `<div data-testid="cook-serving-<day>_<mealType>">`, with the note text as a `<p>` and the portion `<p>`s.
  - **Zero steps** (`steps.length === 0`): `<p data-testid="cook-no-steps">{COOK_NO_STEPS}</p>` instead of the step card, navigation and step list.
  - **Footer**: Back to sessions, Back to plan, Shopping list.
  - Test ids for the other states: `cook-not-found`, `cook-unavailable`, `cook-no-plan` (with an "Open plan" link).
- Everything renders as text (Astro escapes), and there is no `set:html`. The stored jsonb is client-assertable.

#### 3. Entry links

**File**: `src/pages/plan/sessions.astro`

**Intent**: Let the user open any session in cook mode.

**Contract**: Under each session's minutes line, add `<a data-testid="session-cook-<key>" href={cookPath(planStart, session.key)}>` with `COOK_MODE_LABELS.cookLink`.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`
- Existing smoke still passes against the dev server: `npm run smoke`

#### Manual Verification:

Setup: run `npm run dev` with two linked accounts A and B, both with daily targets set on `/targets`. Signed in as A, open `/plan?start=2031-02-10` (a Monday). Fill Monday and Tuesday each with Jajecznica (breakfast), Owsianka proteinowa (second breakfast), Kurczak curry z ryżem (lunch), Twarożek (afternoon snack) and Leczo z kiełbasą (dinner), all eaten by both. Set Tuesday lunch's batch to share Monday Lunch, and save.

- **Sign-in guard:** in a private window, open `http://localhost:4321/plan/sessions/cook?start=2031-02-10&session=2031-02-09-evening`. You are redirected to `/auth/signin`.
- **Entry link:** open `/plan/sessions?start=2031-02-10`. Every session has a **Cook step by step** link. Click Sunday evening's.
- **Estimate before solving:** the page reads `Estimate for Monday: recipe base amounts and no portions yet — solve Monday to get them.` with a **Solve Monday** link. Ingredients and portions shows the curry's base amounts and no You / Partner lines.
- **Solve:** follow **Solve Monday**, click **Solve macros**, and accept a looser tier if offered. Use the browser's Back button to return to the cook page and reload. It now reads `Amounts and portions from the day solve of Monday.`
- **Step walk:** the card reads `Step 1 of 12`, the leczo chopping step (the S-10 Sunday order), with "For tomorrow" and leczo amounts under **You need**. Click **Next**: step 2 is the curry rice, listing only the rice ingredients. Keep clicking: the chicken steps list the chicken ingredients. The curry's last step here (the sauce) also shows **Portions** with `You: … · Partner: … · You (Tuesday): … · Partner (Tuesday): …`. Step 1 has no Previous link, and step 12 shows **Back to sessions** instead of Next, which returns to `/plan/sessions` scrolled to Sunday evening.
- **All steps:** click step 7 in the **All steps** list. The card jumps there, and the list marks it current.
- **Monday morning:** open Monday morning's cook link. The curry "Odważ porcje, odgrzej i podaj" step shows no **You need** block but does show the curry **Portions**.
- **Serving note:** open Tuesday morning's cook link. **Ingredients and portions** shows `Lunch: from the same batch as Monday Lunch — nothing new to cook.` with only Tuesday's portions (no `(Monday)` text), and no curry step appears in the step list.
- **Partner view:** sign in as B and open the same Sunday-evening URL. The numbers are identical, with "You" and "Partner" swapped.
- **Out of date:** as A, change Monday's breakfast eater to "me" on `/plan` and save. Reload the Sunday-evening cook page: it is back to the estimate note with no portions.
- **Edge cases:**
  - `…&session=2031-02-09-noon` → "Plan not found" (404 in the devtools Network tab);
  - `…&session=2031-02-15-morning` (not in the plan) → 404;
  - `…&step=0` and `…&step=abc` → 404;
  - `…&step=99` → the last step;
  - `?start=2040-01-06&session=2040-01-05-evening` → `No plan for that date.` with an Open plan link.
- **No JavaScript:** disable JavaScript in devtools and repeat the step walk. Previous / Next / All steps all work through page loads.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Focus-mode island

### Overview

Progressively enhance the step card, navigation and step list into a `client:idle` island: in-place step switching, per-device done ticks and the optional wake lock. Without JavaScript the page behaves exactly as in Phase 2.

### Changes Required:

#### 1. Progress hook

**File**: `src/components/hooks/useCookProgress.ts` (new)

**Intent**: Own the current step and the done set, plus the URL and storage side effects (D1).

**Contract**: `useCookProgress(view: CookModeView, initialStep: number)` returns `{ current, goTo(n), done: ReadonlySet<string>, toggleDone(stepId), doneAndNext() }`.
- The `done` set starts empty and loads from `localStorage` key `duo-kitchen:cook:<planId>:<sessionKey>` in an effect (see Critical Implementation Details). Ids no longer in `view.steps` are dropped on load.
- Every write and read is wrapped in `try/catch`.
- `goTo` clamps, updates state and calls `history.replaceState` with `cookPath(…, n)`.

#### 2. Wake-lock hook

**File**: `src/components/hooks/useWakeLock.ts` (new)

**Intent**: The D9 opt-in screen wake lock.

**Contract**: `useWakeLock()` returns `{ supported, active, setActive(boolean) }`.
- `supported` is false until an effect detects `"wakeLock" in navigator`.
- `active` holds a `WakeLockSentinel`. It is re-requested on `visibilitychange` back to visible while active, and released on unmount.
- A rejected request sets `active` false.

#### 3. Island

**File**: `src/components/cook/CookMode.tsx` (new)

**Intent**: Render the step card, the navigation and the All steps list with the **same markup, test ids and links as Phase 2**, so its server render replaces that markup one-to-one. Once hydrated, clicks switch steps in place. It imports only `@/types`, `cook-mode.ts`, `recipe-labels.ts`, `utils.ts` and its hooks; never `cooking.ts` or `day-solutions.ts`.

**Contract**:
- Props: `{ view: CookModeView; initialStep: number; labels: { sections: Record<SessionSectionKind, string>; timings: Record<StepTiming, string> } }`.
- Previous / Next / All-steps items stay `<a href={cookPath(…)}>`. Their `onClick` calls `preventDefault()` and `goTo(n)` for a plain left click only (no modifier keys), so "open in new tab" still works.
- After hydration it adds:
  - a **Done — next step** button (marks done and advances; on the last step it marks done only);
  - a ✓ toggle per All-steps item (`aria-pressed`) with done items shown struck through;
  - a done count `"3 of 12 done"` (a `formatDoneCount` added to `cook-mode.ts`);
  - the **Keep screen on** checkbox when supported.
- The step card heading receives focus after an in-place change.
- Render each portion line from one pre-joined string expression (e.g. ``{componentName ? `${componentName}: ${line}` : line}``), never adjacent text expressions, so React inserts no `<!-- -->` markers inside it.
- `cook.astro` replaces its Phase-2 step card / navigation / list block with `<CookMode client:idle … />`. The overview stays plain Astro.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`
- Existing smoke still passes against the dev server: `npm run smoke`
- Island bundle stays clean: after `npm run build`, no file under `dist/client/` contains `yalps` or zod's `ZodError` (Grep over `dist/client/`)

#### Manual Verification:

Use the Phase 2 plan (`2031-02-10`, re-solved if Phase 2 left it out of date) on a phone-sized viewport (devtools device mode, or the installed app on a phone pointed at the dev server's LAN address).

- **In-place stepping:** open Sunday evening's cook page and wait a moment for hydration. Click **Next** three times. The card changes without a page reload (no new document request in the Network tab), the address bar shows `&step=4`, and reloading the page stays on step 4.
- **Back button:** after stepping, press the browser Back button once. You return to `/plan/sessions`, not to the previous step.
- **Done ticks:** click **Done — next step** on steps 1 and 2. Both show ✓ and struck-through text in All steps, and the count reads `2 of 12 done`. Reload: the ticks are still there. Untick step 1 with its ✓ toggle: the count reads `1 of 12 done`.
- **Per device:** open the same URL in a private window (or as B on another browser). No steps are ticked there.
- **New tab:** Ctrl/Cmd-click **Next**. A new tab opens on the next step, and the current tab does not move.
- **Keep screen on:** in Chrome or Edge (or Safari 16.4+), the **Keep screen on** checkbox appears. Tick it, switch to another tab and back, and confirm it is still ticked. Leave the page untouched past your screen-timeout: the screen stays on. In a browser without the API, the checkbox does not appear.
- **Keyboard and screen reader:** tab to **Next** and press Enter. Focus lands on the new step's heading.
- **Still no-JS safe:** with JavaScript disabled, the page behaves exactly as in Phase 2's manual check, and the Done and Keep screen on controls are absent.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Smoke coverage and documentation

### Overview

Pin the slice end to end over HTTP against the production preview, and describe it in CLAUDE.md and README.

### Changes Required:

#### 1. Smoke helpers and constants

**File**: `scripts/smoke.mjs`

**Intent**: Add an S-11 header line to the slice list, constants and small parsing helpers next to the S-10 ones.

**Contract**:
- `cookPath(session, step?)` for `2031-01-20`.
- `S11_EXACT_NOTE = "Amounts and portions from the day solve of Monday."`.
- `S11_ESTIMATE_NOTE = "Estimate for Monday: recipe base amounts and no portions yet — solve Monday to get them."`.
- `cookSection(body, testId)`: the slice of a `data-testid` block.
- `portionLines(html)`: the text of every `<p>` inside a portions block. It (and any other text extraction) reuses the existing marker-and-tag stripping helper at `scripts/smoke.mjs:297`, so React's `<!-- -->` text markers never reach a comparison.
- `portionShares(line)`: for partner symmetry, compares parsed share maps, not strings (`formatSplitLine` sorts the viewer's shares first, so a label swap of A's string never equals B's). It strips the `<component>: ` prefix, splits on ` · `, maps each `Label(suffix): value` segment to `{ "<label><suffix>": value }`, swaps You↔Partner in the keys (and `All for you` ↔ `All for your partner`), and returns the non-share tail segments (`split in half`, `split evenly N ways`) separately for a verbatim comparison.
- Curry step ids come from the S-10 constants (`S10_SUNDAY_ORDER`, `S10_CURRY_STEPS`), never retyped. They hold 3-digit suffixes while `data-step-id` is the full uuid, so always compare through the existing `s10Step()` helper (`smoke.mjs:365`), e.g. `s10Step(S10_SUNDAY_ORDER[i])`.

#### 2. Smoke steps

**File**: `scripts/smoke.mjs`

**Intent**: Add the S-11 sequence (D10).

**Contract**:
- **Solved and shared window**, after "Tuesday's day page eats from Monday's batch, with no batch amounts", with an order-sensitivity comment:
  1. `the sessions page links each session to cook mode`: `/plan/sessions?start=2031-01-20` contains `data-testid="session-cook-2031-01-19-evening"` with the expected `href`.
  2. `A cook mode of Sunday evening is exact and starts at step 1`: `testIdBody("cook-source-ahead", S11_EXACT_NOTE)`, no `cook-source-*` estimate, `cook-step-counter` = `Step 1 of 12`, and `data-step-id` of `cook-step` = `s10Step(S10_SUNDAY_ORDER[0])`.
  3. `the curry rice step lists only its component amounts`: `step=2` → the step id is `s10Step(S10_SUNDAY_ORDER[1])` (curry 401), `cook-step-amounts` has at least one `<li`, and there is no `cook-step-portions`.
  4. `the last curry step of the evening portions the shared batch`: the step whose index in `S10_SUNDAY_ORDER` holds curry 404 → `cook-step-portions` lines include a `You` line, a `Partner` line and `(Tuesday)` servings.
  5. `the shared curry batch has one batch block`: exactly one `cook-batch-` block inside `cook-entry-ahead-<curryRecipeId>`.
  6. `Tuesday morning serves its own portions from the batch`: `cook-serving-1_lunch` contains the S-10 batch note text and portion lines with no `(Monday)`, and none of `S10_CURRY_STEPS.map(s10Step)` appears in `cook-all-steps`.
  7. `B sees the same portions with You and Partner swapped`: on B's curry-404 step, each portion line's `portionShares` equals the swapped `portionShares` of A's matching line, and the tail segments are equal verbatim.
  8. `a step past the end shows the last step`: `step=99` → `Step 12 of 12`, with `cook-finish` present.
- **Stale window**, after "A shopping list of the stale shared plan falls back to estimates for both days":
  9. `cook mode of the stale plan falls back to estimates`: Sunday evening at the curry-404 step (`step = S10_SUNDAY_ORDER.indexOf("404") + 1`) → `testIdBody("cook-source-ahead", S11_ESTIMATE_NOTE)`, no `cook-step-portions` block, and no `You:` / `Partner:` text inside the `cook-entry-ahead-<curryRecipeId>` overview block.
- **With the S-09/S-10 anonymous and edge checks**:
  - `cook mode redirects anonymous user` (302 → `/auth/signin`);
  - `a malformed cook session is 404` (`session=2031-01-19-noon`, `testIdBody("cook-not-found", "Plan not found")`);
  - `a cook session outside the plan is 404` (`session=2031-01-25-morning`);
  - `a malformed cook step is 404` (`step=0`);
  - `a cook date with no plan says so` (`start=2032-01-05&session=2032-01-04-evening`, `testIdBody("cook-no-plan", "No plan for that date.")`).
- Register the new test ids in the failure printer's debug lists, following the existing pattern.

#### 3. Documentation

**Files**: `CLAUDE.md`, `README.md`

**Intent**: Describe the slice where every earlier slice is described.

**Contract**:
- **CLAUDE.md:**
  - Add a "Cook mode (S-11)" bullet after the S-10 bullet. It covers:
    - derived on read, nothing stored server-side, progress per device (D1);
    - the route and its validation (D2);
    - the per-section currency through `getPlanSolveState()` (D3);
    - lookup of stored rows by the lead meal's / note meal's `mealId` (one row per dish, never summed);
    - per-step amounts by `componentId` and portions on an entry's last step (D4);
    - per-batch blocks (D5), split-line context (D6), serving notes (D7);
    - the island-safety rule (`cook-mode.ts` and `split-lines.ts` never import `day-solutions.ts`, the solver, zod or Supabase);
    - the files.
  - Note in the S-10 bullet that `RecipeDetailStep` now carries `componentId`.
  - Add `cook-mode.test.ts` to the `npm test` list.
- **README:**
  - Add a routes-table row: `/plan/sessions/cook` — one cooking session step by step with amounts and You/Partner portions (`?start=<date>&session=<date>-<part>[&step=<n>]`).
  - Add "cook mode" to the `npm test` description.
  - Add an S-11 smoke paragraph after the S-10 one: what is pinned, which window, and that portion numbers are checked by structure and partner symmetry, not pinned from SQL (`npm test` pins them).
  - Add a cleanup note: S-11 stores nothing server-side, and done ticks live in each browser's `localStorage`.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build passes: `npm run build`
- Smoke passes against the production preview: `npm run build && npm run preview`, then `BASE_URL=http://localhost:4321 npm run smoke`
- Migration gate unchanged: `npm run check:migrations` passes (no new migration files)

#### Manual Verification:

- After the smoke run, sign in as the smoke account A (`smoke-<timestamp>@example.com`, password from the script) and open `/plan/sessions?start=2031-01-20`. Click Sunday evening's **Cook step by step**. The run left this plan edited after its last solve, so the page shows the estimate note and no portions. That matches the stale-window assertion.
- Temporarily change `S11_EXACT_NOTE` in `scripts/smoke.mjs` (e.g. drop the final period). Run the smoke against the preview and confirm it fails at the S-11 step with a message showing the expected and actual note. Then revert the edit.
- Read the new CLAUDE.md bullet and README paragraphs, and check each claim against the running app: the route and parameters, the 404 cases, the estimate fallback, and the per-device done ticks.
- On a real phone with the app installed (F-03), open a solved session's cook mode and follow three steps. Text is readable without zooming, Previous / Next are thumb-reachable (at least 44 px tall), and nothing scrolls sideways.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- `cook-mode.test.ts` on real `solveGroup()` output over the seed fixtures:
  - shared-batch cook and serve sides;
  - no double counting;
  - same-day double meal;
  - merged entry with per-batch blocks;
  - null-component step;
  - per-person components (pieces and per-ingredient);
  - bounds warning;
  - full estimate (no portions) and per-dish fallback;
  - an evening with mixed sources;
  - viewer swap;
  - numbering;
  - formatters.
- The existing `formatSplitLine` tests guard the module move unchanged.

### Integration Tests:

- Smoke on `2031-01-20`:
  - in the solved-shared window: exact note, step 1 identity, per-step component amounts, portions on the last curry step with Tuesday servings, a single batch block, the Tuesday serving note, partner symmetry, step clamping;
  - in the stale window: the estimate fallback.
- Smoke edge cases: anonymous redirect, malformed session, session outside the plan, malformed step, and no plan for the date.
- No RLS or seed test changes: the reads use existing select policies, and nothing is written.

### Manual Testing Steps:

1. Build the worked-example plan on `2031-02-10`, check the estimate state, then solve and walk Sunday evening step by step (Phase 2).
2. Check Monday morning's portion step and Tuesday morning's serving note (Phase 2).
3. Check the partner view and the out-of-date fallback (Phase 2).
4. Check in-place stepping, done ticks, the Back button and the wake lock on a phone-sized viewport (Phase 3).
5. Run the edge URLs and the no-JS walk (Phases 2–3).

## Performance Considerations

One page load runs `getMealPlan()`, then in parallel `getRecipeSteps()` (3 flat queries) and `getPlanSolveState()` (the stored rows plus the household, targets and solver-recipe reads, and one SHA-256 fingerprint per solve group). That is the same cost as `/plan/shopping` plus the steps read. The builder handles one session (at most about 40 steps), so its cost is negligible. The island receives one session's view model as props, a few KB.

## Migration Notes

None. S-11 adds no migration, table, function or grant. `check:migrations`, `test:rls` and `test:seed` are unaffected. `RecipeDetailStep.componentId` is additive and read from columns already selected.

## Addendum (implementation review)

- **Progress storage** (review F3): `useCookProgress` reads the ticks through `useSyncExternalStore` with a `null` server snapshot instead of an effect, which is equally hydration-safe. Ticks also sync across tabs of the same browser through the `storage` event, and a module-level in-memory map keeps them for the page's lifetime when `localStorage` is blocked.
## References

- Research: `context/changes/step-by-step-cook-mode/research.md`
- Change identity: `context/changes/step-by-step-cook-mode/change.md`
- Schedule to consume: `src/lib/services/cooking-sessions.ts`, `src/lib/services/cooking.ts`, `src/pages/plan/sessions.astro`; S-10 plan `context/archive/2026-10-13-cooking-session-schedule/plan.md` (D4 "S-11 owns serving", D11 route)
- Currency rule: `src/lib/services/day-solutions.ts:316-390`; S-09 precedent `src/lib/services/shopping.ts:15-50`
- Split rendering: `src/lib/services/day-solutions.ts:568-692`, `src/pages/plan/day.astro:247-306`
- Island precedent: `src/components/shopping/ShoppingList.tsx`, `src/components/hooks/useShoppingChecks.ts`
- Smoke windows: `scripts/smoke.mjs:1046-1157`
- Source requirements: `context/foundation/prd.md` US-03 (`:67-70`), FR-023 (`:116`), unsolved-plan guardrail (`:45`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Groundwork and pure cook-mode engine

#### Automated

- [x] 1.1 Unit tests pass, including the unchanged `formatSplitLine` tests: `npm test` — 41a07eb
- [x] 1.2 Lint passes: `npm run lint` — 41a07eb
- [x] 1.3 Type check passes: `npx astro check` — 41a07eb
- [x] 1.4 Build passes: `npm run build` — 41a07eb
- [x] 1.5 `cook-mode.ts` and `split-lines.ts` import nothing from `day-solutions`, `macro-solver`, `zod` or `@supabase` — 41a07eb

#### Manual

- [x] 1.6 `/plan/day` split lines read exactly as before the move
- [x] 1.7 Curry recipe detail steps render as before
- [x] 1.8 `/plan/sessions` renders exactly as before

### Phase 2: Server-rendered cook page and entry links

#### Automated

- [x] 2.1 Unit tests pass: `npm test` — 251a623
- [x] 2.2 Lint passes: `npm run lint` — 251a623
- [x] 2.3 Type check passes: `npx astro check` — 251a623
- [x] 2.4 Build passes: `npm run build` — 251a623
- [x] 2.5 Existing smoke still passes against the dev server: `npm run smoke` — 251a623

#### Manual

- [x] 2.6 Anonymous visitor is redirected from the cook page
- [x] 2.7 Every session on `/plan/sessions` has a working Cook step by step link
- [x] 2.8 Unsolved session shows the estimate note, base amounts and no portions
- [x] 2.9 After solving, the exact note appears
- [x] 2.10 Step walk shows per-component amounts, portions on the last curry step, and correct Previous/Next/finish
- [x] 2.11 All steps list jumps to a step and marks it current
- [x] 2.12 Monday morning's null-component curry step shows portions only
- [x] 2.13 Tuesday morning's serving note shows only Tuesday's portions
- [x] 2.14 Partner sees identical numbers with You/Partner swapped
- [x] 2.15 An edit after solving brings back the estimate state
- [x] 2.16 Malformed/unknown session and step URLs give 404, step 99 clamps, no-plan date says so
- [x] 2.17 The step walk works with JavaScript disabled

### Phase 3: Focus-mode island

#### Automated

- [x] 3.1 Unit tests pass: `npm test` — cdb2b88
- [x] 3.2 Lint passes: `npm run lint` — cdb2b88
- [x] 3.3 Type check passes: `npx astro check` — cdb2b88
- [x] 3.4 Build passes: `npm run build` — cdb2b88
- [x] 3.5 Existing smoke still passes against the dev server: `npm run smoke` — cdb2b88
- [x] 3.6 No file under `dist/client/` contains `yalps` or `ZodError` — cdb2b88

#### Manual

- [x] 3.7 Next/Previous switch steps in place, update the URL and survive reload
- [x] 3.8 Back returns to `/plan/sessions`, not the previous step
- [x] 3.9 Done ticks and the done count persist across reloads and can be undone
- [x] 3.10 Done ticks are per device (absent in a private window)
- [x] 3.11 Ctrl/Cmd-click on Next opens a new tab without moving the current one
- [x] 3.12 Keep screen on appears where supported and keeps the screen awake
- [x] 3.13 Keyboard navigation moves focus to the new step heading
- [x] 3.14 With JavaScript disabled the page behaves as in Phase 2

### Phase 4: Smoke coverage and documentation

#### Automated

- [x] 4.1 Unit tests pass: `npm test` — 4b92c17
- [x] 4.2 Lint passes: `npm run lint` — 4b92c17
- [x] 4.3 Type check passes: `npx astro check` — 4b92c17
- [x] 4.4 Build passes: `npm run build` — 4b92c17
- [x] 4.5 Smoke passes against the production preview — 4b92c17
- [x] 4.6 Migration gate unchanged: `npm run check:migrations` — 4b92c17

#### Manual

- [x] 4.7 Post-smoke `2031-01-20` Sunday evening cook page shows the estimate state
- [x] 4.8 A deliberately wrong `S11_EXACT_NOTE` makes smoke fail with a clear message
- [x] 4.9 CLAUDE.md and README claims match the running app
- [x] 4.10 On a real phone the cook page is readable and thumb-friendly with no sideways scroll
