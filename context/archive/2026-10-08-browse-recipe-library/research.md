---
date: 2026-10-08T15:54:00+02:00
researcher: Claude (Opus 5.5) for Kamil Schlagowski
git_commit: e3ce0b547e5dc2b6cc753015364e9d207348c9fa
branch: claude/s-05-prompt-chain-183cb8
repository: KSchlagowski/Duo-Kitchen
topic: "S-05 browse-recipe-library — recipe cards and full recipe detail over the F-04 public library, built in parallel with S-03"
tags: [research, codebase, recipes, public-library, s-05, astro-pages, supabase, smoke-test, coordination-s-03]
status: complete
last_updated: 2026-10-08
last_updated_by: Claude (Opus 5.5)
---

# Research: S-05 — browse the recipe library (cards + full detail)

**Date**: 2026-10-08T15:54:00+02:00
**Researcher**: Claude (Opus 5.5) for Kamil Schlagowski
**Git Commit**: e3ce0b547e5dc2b6cc753015364e9d207348c9fa (same as `origin/main`)
**Branch**: claude/s-05-prompt-chain-183cb8
**Repository**: KSchlagowski/Duo-Kitchen

## Research Question

How should S-05 (`browse-recipe-library`, roadmap `context/foundation/roadmap.md:182-192`) be built on the current codebase? The user should be able to browse recipe cards (photo, name, cuisine, both partners' ratings) and open a recipe's full details: ingredients with quantities, macros and rounding step; make-ahead vs. fresh steps; divisible components or the whole-dish flag; raw/cooked weights; suggested meal types; cuisine and prep time (PRD FR-005, FR-009, FR-010, FR-012). The slice must follow the coordination rules in `change.md`, because S-03 (`plan-three-day-grid`) is being built in parallel and merges first.

Non-interactive session: no scoping questions were asked. Assumptions are stated inline and collected under **Assumptions**.

## Summary

- **Everything S-05 needs to show already exists in the schema, except the photo.** The F-04 public library (`supabase/migrations/20261008150000_shared_recipe_library.sql:294-373`) carries name, cuisine, prep time, meal types, division mode, components with `cooked_yield_ratio`, ingredients with base amounts, rounding overrides, minimum amounts and half-piece flags, products with per-100 g nutrition, rounding step and `grams_per_piece`, and steps with `timing`, `duration_minutes` and an optional component. Every authenticated user can read all of it through one `select … using (true)` policy per table. S-05 can therefore be a **read-only, zero-migration slice**.
- **No photo column, no photos and no write path.** All 8 seed recipes would have a null photo, and the library is read-only for clients until S-07. The recommendation is **not** to add a column in S-05. The card renders a photo slot with a deterministic placeholder, and the column and Storage bucket arrive with the first slice that can supply a photo (S-12 agent import, or S-07's write path). This conflicts with an F-02 note ("S-05 adds `photo_url` with the storage work"); see **Decision: photo**. If the planner still wants the column, a nullable `ALTER TABLE … ADD COLUMN` keeps both grant levers intact (details below).
- **Macros (FR-010) are computed in TypeScript from product rows.** Nothing stores them. Per ingredient the formula is `base_amount_g × per_100g / 100`, summed per component and per recipe. A pure helper is the natural home, and S-04's solver will need the same arithmetic.
- **App shape is two SSR `.astro` pages with no islands:** `/recipes` (card grid) and `/recipes/[id]` (detail). They are backed by `getRecipeCards()` and `getRecipeDetail(id)` in `src/lib/services/recipes.ts`, with S-05-specific DTO names in `src/types.ts`. Add `"/recipes"` to `PROTECTED_ROUTES`. The middleware's `startsWith` check also covers `/recipes/<id>`.
- **Coordination hot spots:**
  - S-03 is still at `change.md` stage (`D:/Duo-Kitchen` worktree, branch `feat/plan-three-day-grid`, no commits past `e3ce0b5`). Its brief says S-03 adds `listRecipes()` (id, name, cuisine, prep_minutes, meal_types) and "its type" to `src/types.ts`. S-05's card query needs exactly those fields, so the two will overlap and must be deduped at rebase.
  - Six shared files will conflict on rebase: `recipes.ts`, `types.ts`, `middleware.ts`, `dashboard.astro`, `smoke.mjs` and README/CLAUDE/roadmap. Keeping S-05's lines in separate blocks keeps each conflict mechanical.
  - This worktree is **not linked** to the Supabase project. `npx supabase migration list --linked` fails with `LegacyProjectNotLinkedError`. `npm run test:rls` and `npm run test:seed` need `npx supabase link --project-ref tvmfkhnxxsnmvogplknz` first.
- **Two real risks found:**
  - PostgREST may see `recipe_steps` as a junction table between `recipes` and `recipe_components`. A nested `recipes → recipe_components` embed could then fail with PGRST201 (ambiguous relationship). Use FK hints or parallel flat queries.
  - A non-UUID `id` in the URL makes PostgREST raise `22P02`. Validate with zod and return 404 before querying.

## Detailed Findings

### 1. Intent and constraints (change.md, roadmap, PRD)

- `change.md` coordination rules, verbatim intent:
  - no plan tables or plan files;
  - distinct function names (`getRecipeCards()`, `getRecipeDetail(id)`) and S-05-specific DTO names, deduped against S-03's `listRecipes()` on rebase;
  - **no ratings table**, but a ratings slot on the card;
  - a photo column only under the Public library hard rule;
  - S-05-only blocks in shared files, and S-03's roadmap status never changed;
  - check the migration timestamp before `db push`;
  - merge only after S-03 is on `main`, then rebase and rerun lint, `astro check`, build, `test:rls`, `test:seed` and `smoke`.
- Roadmap S-05 (`context/foundation/roadmap.md:182-192`): prerequisite F-04 (done). Not on the path to the first solved day. "It is where agent-imported recipes (S-12) become visible", so the detail view must cope with non-seed recipes too (any uuid, nulls in optional columns).
- PRD (`context/foundation/prd.md:88-95`):
  - **FR-005**: cards show photo, name, cuisine and both partners' thumbs up/down. Ratings are S-06, so S-05 ships only the slot.
  - **FR-009**: detail shows ingredients with quantities, macros and rounding step; steps split into make-ahead and fresh; divisible components or a whole-dish-only flag; raw and cooked weights where relevant; 0–2 meal types; cuisine; prep time.
  - **FR-010**: macros are computed from products.
  - **FR-012**: the seed recipes exist (8 today).
- PRD NFR (`prd.md:137`): "every displayed quantity is weighable in practice: it follows the ingredient's rounding step, and a halved item may be shown as 'podziel na pół' without a gram amount". This bears on how piece products are rendered.
- PRD NFR (`prd.md:138`) and Access Control (`prd.md:151`): the library is public to authenticated users, and anon reaches only sign-in, sign-up and `/join`. So `/recipes` must be protected.

### 2. Data model available to S-05 (F-04 public library)

Defined in `supabase/migrations/20261008150000_shared_recipe_library.sql`:

| Table                | Columns relevant to S-05                                                                                                                                                                                          | Lines   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `products`           | `name` (unique), `kcal/protein/fat/carbs_per_100g numeric(5,1)`, `aisle store_aisle`, `rounding_step_g numeric(5,1) default 10`, `grams_per_piece numeric(6,1)` (non-null = counted in pieces)                    | 294-308 |
| `recipes`            | `name`, `cuisine text`, `prep_minutes int > 0`, `meal_types meal_type[]` (cardinality ≤ 2), `division_mode` (`per_component` / `whole_dish`), `created_at`. **No photo, no description, no `created_by`.**        | 312-320 |
| `recipe_components`  | `recipe_id`, `position`, `name`, `cooked_yield_ratio numeric(4,2)` (cooked/raw; null = not weighed after cooking); `unique (recipe_id, position)`, `unique (id, recipe_id)`                                       | 324-335 |
| `recipe_ingredients` | `component_id`, `product_id` (`on delete restrict`), `position`, `base_amount_g numeric(7,1)`, `rounding_step_g` (overrides product), `min_amount_g`, `allow_half_pieces`; `unique (component_id, position)`      | 339-354 |
| `recipe_steps`       | `recipe_id`, `position`, `instruction`, `timing step_timing` (`make_ahead`/`fresh`), `component_id` (nullable), `duration_minutes` (nullable); FK `(component_id, recipe_id) → recipe_components (id, recipe_id)` | 358-371 |

- Enums are in `supabase/migrations/20261007120000_products_and_recipes.sql:15-28` and mirrored as TS unions in `src/types.ts:22-25` (`StoreAisle`, `MealType`, `DivisionMode`, `StepTiming`). The comment at `src/types.ts:21` says "labels are mapped in the UI". There is no label map yet. S-05 adds the first one for meal types, division mode and step timing. S-14 owns PL/EN switching later, so keep the map in one place.
- RLS and grants (`…shared_recipe_library.sql:421-449` plus `20261008160000_library_revoke_maintain.sql`):
  - one `*_select_authenticated … using (true)` policy per table;
  - `revoke all` from anon;
  - insert/update/delete/truncate/references/trigger/maintain revoked from authenticated.

  S-05's SSR reads use the user's cookie session (`src/lib/supabase.ts`), so they pass through that policy. No definer function is needed.

- Seed content (`supabase/migrations/20261007120100_seed_products_and_recipes.sql`): 8 recipes, 14 components, 69 ingredients, 33 steps, 46 products (pinned at `supabase/tests/seed_integrity.sql:328-331`). Shapes the UI must handle:
  - `whole_dish` recipes with one component (Ciastka proteinowe, Leczo, Zapiekanka) vs. `per_component` with 2–3 components (Kurczak curry: Ryż ×2.50, Kurczak ×0.75, Sos curry).
  - A recipe with **0 meal types** (`Zapiekanka makaronowa`, line 105-106). The detail must render "no suggested meal type" gracefully.
  - Piece products with halves allowed (bread 35 g/piece, banana 120 g, grahamka 60 g; lines 140, 147, 199) and without (eggs 50 g/piece, `min_amount_g` 50; line 135).
  - A 1 g ingredient-level rounding override (cocoa, line 155) and many 1 g spice/salt products.
  - Steps with `component_id` null (oven preheat, line 235) and `duration_minutes` null (overnight fridge, line 230).
  - Recipe names, cuisines (`polska`, `fit`, `indyjska`, `włoska`, `węgierska`) and step text are Polish. The PRD keeps recipe content Polish even after S-14.

### 3. Existing service, type and page patterns

- `src/lib/services/recipes.ts:1-23` holds only `getRecipeLibrarySummary()` (head-only counts, used by the dashboard). It throws on error and does no mapping beyond counts. S-05 adds `getRecipeCards()` and `getRecipeDetail(id)` here; S-03 adds `listRecipes()` to the same file, so a rebase conflict here is certain.
- The mapping convention is in `src/lib/services/macro-targets.ts:8-34`:
  - a private `…Row` interface in snake_case;
  - `.select("<explicit columns>")`;
  - `if (error) throw error;`;
  - a map to a camelCase DTO from `src/types.ts`.

  Follow it for S-05 (for example `RecipeCardRow` → `RecipeCard`).

- Page pattern (`src/pages/targets.astro:9-29`, `src/pages/dashboard.astro:10-45`):
  - create the client with `createClient(Astro.request.headers, Astro.cookies)`;
  - each read sits in its own `try/catch` that `console.error`s with the eslint-disable comment and leaves the value `null`;
  - labels never let a failed read look like "empty" (`dashboard.astro:61`, `targets.astro:11-12`).

  S-05 should keep the distinction between "Recipe library is unavailable right now" and "No recipes yet".

- Visual language: `bg-cosmic` full-height wrapper, `rounded-2xl border border-white/10 bg-white/10 backdrop-blur-xl` glass card, gradient `h1`, `text-blue-100/80` body text, `text-purple-300 hover:underline` links (`dashboard.astro:80-99`, `targets.astro:61-124`).
  - Conditional classes go through `cn()` (`targets.astro:77`), as the CLAUDE.md hard rule requires.
  - `data-testid` attributes on `<p>` elements are what the smoke test regex-matches (`scripts/smoke.mjs:68-71, 83-85`).
- Islands: only the auth forms are React (`client:load`, `src/pages/auth/*.astro`). S-05 has no state and no browser events: no filters (S-06) and no rating clicks (S-06). Per CLAUDE.md ("use a `.tsx` island only if … state, effects, or browser event handlers"), **all S-05 components are `.astro`**, for example `src/components/recipes/RecipeCard.astro`.
- UI kit: `src/components/ui/` has only `button.tsx` and `LibBadge.astro`. A badge or chip for meal types and the whole-dish flag can be plain Tailwind, or `npx shadcn@latest add badge`. The React `badge` would only be usable inside an island, so plain Tailwind in `.astro` is the lighter choice. Icons: `lucide-react` is installed but React-only. In `.astro`, an inline SVG or text is simpler.
- `src/components/Topbar.astro` exists but is used only by `Welcome.astro`. No authenticated page has shared navigation; every page links back with "Back to dashboard" (`targets.astro:120-124`). S-05 can follow that.
- `src/layouts/Layout.astro:6-10` takes `title`. Pass recipe names as titles.

### 4. Routing and protection

- `src/middleware.ts:4` has `const PROTECTED_ROUTES = ["/dashboard", "/targets"];` and line 18 matches with `pathname.startsWith(route)`. Adding `"/recipes"` protects `/recipes` and `/recipes/<id>`.
  - Side effect: the check also matches any future `/recipes…` prefix. That is harmless.
  - S-03 will add its own entry, probably `/plan`. To keep the rebase trivial, put S-05's entry on its own line, or append it at the end of the array. Either way it conflicts on the same line, but the resolution is a union.
- Detail route: `src/pages/recipes/[id].astro` (dynamic SSR route; `output: "server"` in `astro.config.mjs`).
  - **Validate `id` before querying.** PostgREST raises `22P02 invalid input syntax for type uuid` on a malformed id, which the page would surface as "unavailable" rather than "not found".
  - Use zod (`z.uuid()` in zod 4, installed as `^4.6.5`). Seed ids (`5eed0002-0000-4000-8000-…`, version nibble 4, variant 8) and fixture ids (`…-4000-b000-…`) are RFC-valid, so `z.uuid()` accepts them. `z.guid()` is the looser fallback if a non-RFC id ever appears.
  - On invalid or missing: `return new Response(null, { status: 404 })`, or render a small "Recipe not found" body with status 404 via `Astro.response.status = 404`. There is no custom 404 page in `src/pages/`.
  - The smoke test can assert the 404 status either way.
- Assumption: S-05 adds no `/api/*` route. Both pages are GET-only SSR reads, so there is nothing to POST.

### 5. Query design (and the PostgREST embedding risk)

**Cards** (`getRecipeCards()`): a single `supabase.from("recipes").select("id, name, cuisine, prep_minutes, meal_types, division_mode").order("name")`. That is FR-005 minus photo and ratings, plus prep time and meal types, which cost nothing and help scanning. No join is needed.

- Assumption: the cards do **not** show computed kcal. FR-005 does not list it, and per-person sensible calories is an S-06 concern (`roadmap.md:203`, FR-007 "minimum sensible calories"). The planner can add a batch-kcal figure later; it would need the full ingredient join for every recipe.
- Sort is by name with Polish collation. PostgREST's `order=name` uses the DB collation, so verify how `Ś`/`Z` sort on the hosted DB, or sort in TS with `localeCompare(…, "pl")`.

**Detail** (`getRecipeDetail(id)`): one recipe plus its components, ingredients (each with its product) and steps.

- **Risk: ambiguous embed.** `recipe_steps` has FKs to both `recipes` (`recipe_id`) and `recipe_components` (`(component_id, recipe_id)`). PostgREST may treat `recipe_steps` as a many-to-many junction between `recipes` and `recipe_components`. If it does, `recipes?select=…,recipe_components(…)` resolves to two candidate relationships (direct one-to-many, and many-to-many via `recipe_steps`) and fails with **PGRST201**. Whether PostgREST counts it as a junction depends on its detection rules (FK columns being part of a key), which this table only partly meets via `unique (recipe_id, position)`. Not verified against the hosted project.
- Mitigations, in order of preference:
  1. Disambiguate explicitly with FK-name hints, e.g. `recipe_components!recipe_components_recipe_id_fkey(...)` and `recipe_steps!recipe_steps_recipe_id_fkey(...)`. FK constraint names are Postgres defaults; confirm with `npx supabase db query --linked "select conname from pg_constraint where conrelid = 'public.recipe_steps'::regclass"`.
  2. Use three flat parallel queries (`Promise.all`, the same idiom as `getRecipeLibrarySummary`):
     - `recipes` `.eq("id", id).maybeSingle()`;
     - `recipe_components` with nested `recipe_ingredients(…, products(…))` `.eq("recipe_id", id)`, where `recipe_ingredients → products` is unambiguous;
     - `recipe_steps` `.eq("recipe_id", id)`, ordered by `position`.

     Then assemble in TS. Three round-trips from the Worker are acceptable at this scale and avoid the question entirely.
- Ordering: order `recipe_components.position`, `recipe_ingredients.position` and `recipe_steps.position` explicitly. Embedded resources need `.order("position", { referencedTable: "recipe_components" })` or a sort in TS. Do not rely on insertion order.
- `maybeSingle()` returning `null` means not found (404). An error means unavailable. This mirrors `getCurrentHousehold` (`src/lib/services/household.ts:6-16`).
- Numeric columns: PostgREST serialises `numeric` as JSON numbers, so `numeric(5,1)` arrives as e.g. `12.5`. Type the Row fields as `number`. Arithmetic in JS doubles is fine at these magnitudes, but round the displayed values (e.g. 1 decimal for grams of macros, integer kcal).

### 6. Macro computation, rounding, pieces and raw/cooked (FR-009/FR-010)

These are pure functions with no I/O. Put them in a domain helper such as `src/lib/recipe-macros.ts` or an exported function in `src/lib/services/recipes.ts`. CLAUDE.md puts "domain logic used by more than one page" in `src/lib/services/`, and S-04 will reuse it.

- **Per ingredient**: `kcal = base_amount_g × product.kcal_per_100g / 100`, and the same for protein, fat and carbs.
- **Per component**: the sum of its ingredients. **Per recipe (one base batch)**: the sum of components.
  - `recipes` table comment: "Amounts are one base batch". The seed migration (line 12) says "one sensible batch for two people".
  - Label it as "whole batch", not "per serving". There is no servings concept, and the split is S-04's job.
- **Effective rounding step**: `ingredient.rounding_step_g ?? product.rounding_step_g`. This is the same `coalesce` the seed test uses (`seed_integrity.sql:125-131`). Show it per ingredient (FR-009 "rounding step"), e.g. "co 10 g" or "step 10 g". Language is an open item; the UI is English today.
- **Piece products** (`grams_per_piece` not null): show a piece count next to grams.
  - Count is `base_amount_g / grams_per_piece`. Halves are possible when `allow_half_pieces`; the seed test guarantees divisibility (`seed_integrity.sql:136-146`).
  - Examples: "4 szt. (200 g)"; bread 140 g at 35 g/piece gives "4 kromki".
  - Per the PRD NFR, a half piece may be shown as "½" / "podziel na pół" without grams. For S-05 (base batch, no split) the counts are whole in most seeds, but render generically.
- **Minimum amount** (`min_amount_g`): optional "min. 50 g" hint. FR-009 does not demand it, but it is a solver-relevant attribute and cheap to show.
- **Raw/cooked** (FR-009 "raw and cooked weights where relevant"): for a component with `cooked_yield_ratio`, raw weight = sum of its ingredients' `base_amount_g` and cooked ≈ raw × ratio.
  - Example: Ryż 161 g raw → ~402 g cooked (×2.50). Kurczak 416 g → ~312 g (×0.75).
  - Caveat: the sum includes salt and spices (1–4 g). That is negligible, but strictly the ratio was authored for the main product. Assumption: show the component-level sum, labelled "≈".
- **Divisibility** (FR-009): `division_mode = whole_dish` gives a "Whole dish only" badge, with the single component's ingredients listed without a component heading. `per_component` lists components as "divisible components" with their own subtotals.
- **Steps**: two sections, **Make ahead** (evening before) and **Fresh** (right before eating), from `timing`. Each keeps `position` order and shows `duration_minutes` when present and the component name when `component_id` is set.
  - Edge case: `whole_dish` recipes whose steps are all one timing (Leczo). Render an empty section as "—", or hide it.
- **Meal types**: 0–2 values mapped to labels (`breakfast` "Śniadanie"/"Breakfast", …). 0 renders "No suggested meal type".
- **Prep time**: `prep_minutes` shown as "40 min". S-06 introduces the buckets (≤ 20 / 20–45 / 45+); not needed here.

### 7. Types (`src/types.ts`) — S-05-specific names

S-03 will add a type for `listRecipes()`, likely named `RecipeListItem`, `RecipeSummary` or `RecipeOption`. To keep the rebase additive, S-05 should use names S-03 will not:

- `RecipeCard`: `{ id; name; cuisine; prepMinutes; mealTypes: MealType[]; divisionMode: DivisionMode; photoUrl: null }`.
  - The photo slot is typed `null` (or omitted) until a photo column exists.
  - **No rating fields.** S-06 extends the type, e.g. `ratings: { mine; partner }`.
- `RecipeDetail`: `RecipeCard` fields + `components: RecipeDetailComponent[]` + `steps: RecipeDetailStep[]` + `totals: MacroTotals`.
- `RecipeDetailComponent`: `{ id; position; name; cookedYieldRatio: number | null; ingredients: RecipeDetailIngredient[]; totals: MacroTotals; rawWeightG; cookedWeightG: number | null }`.
- `RecipeDetailIngredient`: `{ id; position; productName; amountG; effectiveRoundingStepG; minAmountG: number | null; gramsPerPiece: number | null; allowHalfPieces; macros: MacroTotals }`.
- `RecipeDetailStep`: `{ id; position; instruction; timing: StepTiming; componentName: string | null; durationMinutes: number | null }`.
- `MacroTotals`: `{ kcal; proteinG; fatG; carbsG }`.
  - Avoid `MacroTargets`/`MacroTargetsInput`, which are S-02's.
  - `MacroTargetsInput` has the same shape, so a structural alias is tempting. Keep them separate because the semantics differ (target vs. computed amount).
- Avoid `RecipeSummary`: it is easy to confuse with the existing `RecipeLibrarySummary` (`src/types.ts:27-30`), and it is a likely S-03 pick.
- **Dedupe at rebase**: if S-03's `listRecipes()` returns a superset or the same fields as `getRecipeCards()` minus `divisionMode`, either have `getRecipeCards()` wrap `listRecipes()` and add the missing fields, or keep both and document why. The planner should decide after seeing S-03's actual signature.

### 8. Photo — options and the hard-rule consequences

The decision is recorded under **Decision: photo** below. These facts underpin it:

- `recipes` has no photo column (`…shared_recipe_library.sql:312-320`). The F-02 plan explicitly deferred it: "(no `photo_url`: S-05 adds it with the storage work)" (`context/archive/2026-10-07-seed-products-and-recipes/plan.md:154`). The same plan lists "photos/storage (S-05/S-12)" as out of scope (line 53).
- There are no seed photos, and the agent cannot generate real food photos as part of a migration. A column added now would be null on every row until S-12 (agent import with a photo, PRD US-04) or a write slice (S-07 adds `created_by` and the first library write path).
- Supabase Storage is enabled in `supabase/config.toml:109-118`, but no buckets exist and no `storage.objects` policies are defined. Serving photos from Storage needs either:
  - a **public** bucket, which conflicts with "never anon" (anyone with the URL can fetch it; arguably fine for food photos, but it is a policy decision); or
  - a private bucket with a `storage.objects` select policy for `authenticated` plus signed URLs generated server-side.

  Either option is new security surface, unrelated to S-05's browsing goal.

- If a column is added anyway (option B):
  - `alter table public.recipes add column photo_url text` (nullable, maybe `check (photo_url ~ '^https://')`). Postgres default privileges fire on **CREATE**, not on `ADD COLUMN`, so the table-level revokes from F-04 keep applying to the new column. The select-only policy is unchanged and still covers it.
  - The isolation test's library assertions (`supabase/tests/household_isolation.sql:713-791`) would still pass unchanged. The change note asks to "update the library assertions". The meaningful addition would be a column-level privilege check, already covered generically by `has_any_column_privilege` at lines 774-778.
  - `seed_integrity.sql` changes only if seed rows get values or counts change. With no photos, they would not.
  - The migration needs a timestamp after S-03's and after `20261008160000`, plus a link, a push, and `test:rls`/`test:seed` (see section 10).

### 9. Ratings slot (S-06 boundary)

- No ratings table and no rating fields in DTOs. Per-person ratings belong to S-06 with PK `(user_id, recipe_id)` and the composite membership FK (CLAUDE.md, Auth flow "Per-person data").
- "Leave a slot" means the card has a dedicated, empty, named region, e.g. `<div data-slot="ratings" class="…" aria-hidden="true"></div>` or an Astro `<slot name="ratings" />` on `RecipeCard.astro`. S-06 can then fill it without restructuring the card.
  - Do **not** render placeholder thumbs or "no ratings yet" text, because "don't display … any ratings".
  - A named Astro slot is the cleanest seam: S-06 passes `<RatingPair slot="ratings" … />` from the page.

### 10. Supabase linkage, migration timestamps and tests

- **This worktree is not linked.** `npx supabase migration list --linked` returned `LegacyProjectNotLinkedError: Cannot find project ref`; `supabase/.temp/` is gitignored and absent here. Before any `db push`, `npm run test:rls` or `npm run test:seed`, run `npx supabase link --project-ref tvmfkhnxxsnmvogplknz` in this worktree (CLAUDE.md, "Supabase is cloud-only").
- The newest local migration is `20261008160000_library_revoke_maintain.sql`. S-03 will add plan-table migrations, probably `20261008/9…`.
  - With the recommended zero-migration approach, the timestamp race disappears.
  - With option B, run `npx supabase migration list --linked` right before pushing and pick a timestamp later than every remote entry. After rebasing onto main, also make sure S-05's migration still sorts after S-03's. Otherwise `db push` refuses an out-of-order local migration, or needs `--include-all`. Renaming is the stated fix.
- `npm run test:rls` and `npm run test:seed` still need to run before merge, per change.md, even with no migration. They are expected to pass unchanged because S-05 touches no schema.
- No unit-test runner exists (`package.json` scripts: lint, build, smoke, test:rls, test:seed). The macro helper therefore has no automated test harness.
  - Options: verify its output in the smoke test via a known seed recipe's rendered totals; or add a tiny SQL cross-check, since `seed_integrity.sql:268-290` already computes component macros in SQL, which could serve as an oracle; or do a manual check.
  - Assumption: smoke assertions on a known seed recipe are enough for S-05. Adding vitest is out of scope.

### 11. Smoke test (`scripts/smoke.mjs`) additions

The structure is a `steps` array of `[name, run, expected]`, with `testIdBody(id, text)` for exact `<p data-testid>` matches (`scripts/smoke.mjs:83-85, 109-305`) and a failure dump list of test ids (line 330). Proposed S-05 block, inserted as its own commented group:

- Anon (client `b` before sign-up, or `a` before sign-in): `/recipes` → `302 /auth/signin`, and `/recipes/5eed0002-0000-4000-8000-000000000004` → 302.
- Signed-in A:
  - `/recipes` → 200, with a card for each seed recipe. For example, assert `data-testid="recipe-card"` appears ≥ 8 times, or that a known name appears together with a link to `/recipes/5eed0002-…-000000000004`. "≥ 8" stays robust once S-07 or S-12 add rows; an exact count would break.
  - `/recipes/5eed0002-0000-4000-8000-000000000004` (Kurczak curry z ryżem: per_component, 3 components, two cooked-yield ratios, make-ahead + fresh steps) → 200, with stable `data-testid`s for:
    - name;
    - division (e.g. "Divisible components");
    - meal types ("Lunch · Dinner");
    - a computed batch total. Pin the exact string from the formatter, the same way S-02 pins `formatMacroTargets()` (`src/lib/services/macro-targets.ts:72-75`); it is deterministic from seed data;
    - make-ahead and fresh sections;
    - a cooked-weight line.
  - Optionally a whole_dish recipe (`…0006` Leczo) showing "Whole dish only", and `…0008` Zapiekanka showing the 0-meal-type label.
  - `/recipes/not-a-uuid` → 404; `/recipes/00000000-0000-4000-8000-000000000000` (valid but absent) → 404.
- Add the new test ids to the failure-dump list at line 330.
- Smoke steps run against the production preview with the hosted DB, so pinned seed strings are safe: seed rows are immutable to clients and covered by `seed_integrity.sql`.
- Rebase note: S-03 will also append steps. Keep S-05's block as a contiguous, separately commented group placed **before** the final sign-out steps (lines 299-304). The merge is then a matter of keeping both blocks.

### 12. Shared-file touchpoints (S-05 lines only, separate blocks)

| File                                          | S-05 addition                                                                                    | Conflict expectation with S-03                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `src/middleware.ts:4`                         | `"/recipes"` in `PROTECTED_ROUTES`                                                               | Same line; resolve as union                      |
| `src/pages/dashboard.astro`                   | A "Browse recipes" link next to the `data-testid="library"` line (`:91-93`), its own `<a>` block | S-03 likely adds a "Plan" link nearby; keep both |
| `src/lib/services/recipes.ts`                 | `getRecipeCards()`, `getRecipeDetail()` (+ macro helper if placed here)                          | S-03 adds `listRecipes()`; dedupe                |
| `src/types.ts`                                | `RecipeCard`, `RecipeDetail*`, `MacroTotals`, label maps if typed here                           | S-03 adds its list type; additive                |
| `scripts/smoke.mjs`                           | S-05 step group + test ids in the dump list                                                      | Both append; keep both blocks                    |
| `README.md` route table (`Auth routes` table) | `/recipes` and `/recipes/[id]` rows                                                              | Both add rows                                    |
| `CLAUDE.md` Architecture                      | One S-05 bullet (pages, service functions, the no-photo and ratings-slot decisions)              | Both add bullets                                 |
| `context/foundation/roadmap.md`               | S-05 status only (table row line 40, section line 192, backlog line 319)                         | Never touch S-03 rows                            |

## Code References

Permalinks are pinned to `e3ce0b5`, which is on `origin/main`.

- [`src/lib/services/recipes.ts:6-23`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/lib/services/recipes.ts#L6-L23): the only library reader today (head counts). S-05's functions go here.
- [`src/types.ts:21-30`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/types.ts#L21-L30): enum unions and `RecipeLibrarySummary`. S-05 DTOs are added after these.
- [`src/lib/services/macro-targets.ts:8-34,72-75`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/lib/services/macro-targets.ts#L8-L34): Row→DTO mapping idiom, and a formatter whose exact output the smoke test pins.
- [`src/lib/services/household.ts:5-16`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/lib/services/household.ts#L5-L16): `maybeSingle()` with null as "not found" and a thrown error as "unavailable".
- [`src/middleware.ts:4,18`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/middleware.ts#L4): `PROTECTED_ROUTES` and its `startsWith` match.
- [`src/pages/dashboard.astro:51-53,91-99`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/pages/dashboard.astro#L91-L99): the library line and the targets link (pattern for a "Browse recipes" link).
- [`src/pages/targets.astro:9-47,60-124`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/src/pages/targets.astro#L9-L47): page pattern with independent reads, null meaning unavailable, `cn()`, the glass card and "Back to dashboard".
- [`supabase/migrations/20261008150000_shared_recipe_library.sql:294-373,421-449`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261008150000_shared_recipe_library.sql#L294-L373): library table shapes, FKs (including the `recipe_steps` dual FK behind the embed risk) and the select-only RLS.
- [`supabase/migrations/20261008160000_library_revoke_maintain.sql`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261008160000_library_revoke_maintain.sql): latest local migration timestamp, `20261008160000`.
- [`supabase/migrations/20261007120100_seed_products_and_recipes.sql:38-106,131-210,215-290`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/migrations/20261007120100_seed_products_and_recipes.sql#L89-L106): seed products, recipes, ingredients and steps. Source for smoke fixtures and edge cases.
- [`supabase/tests/household_isolation.sql:677-791`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/tests/household_isolation.sql#L677-L791): classification catch-all and library grant assertions, which must keep passing.
- [`supabase/tests/seed_integrity.sql:121-166,268-290,328-331`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/tests/seed_integrity.sql#L268-L290): rounding and piece invariants the UI can rely on, the SQL macro computation (a possible oracle), and pinned counts.
- [`scripts/smoke.mjs:68-91,109-305,330`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/scripts/smoke.mjs#L109-L305): step structure, test id helpers and the failure dump list.
- [`supabase/config.toml:109-118`](https://github.com/KSchlagowski/Duo-Kitchen/blob/e3ce0b547e5dc2b6cc753015364e9d207348c9fa/supabase/config.toml#L109-L118): Storage enabled, no buckets configured.

## Architecture Insights

- **Three ownership classes** (CLAUDE.md, `household_isolation.sql:13-16`): household-scoped, per-person and public library. S-05 reads only the library class, which is why it needs no RLS work. Its first per-person neighbour (S-06 ratings) will reference `public.recipes` with a plain FK, valid only because the library is public.
- **Read-only, SSR-first slices are the cheapest shape here.** S-02 shows the pattern: an `.astro` page, a service in `src/lib/services/`, DTOs in `src/types.ts`, smoke steps pinning exact formatter strings. S-05 is the same minus the API route.
- **Deterministic formatters as test seams.** `formatMacroTargets()` exists partly so the smoke test can match its exact output. S-05 should do the same for macro totals and the cooked-weight line, so the smoke test proves FR-010 computation end to end against real seed data.
- **Fail-soft reads.** Every page renders even if one read fails, and logs to Worker observability. A detail page has one essential read, so "unavailable" (error) and 404 (null) are the two non-happy states.
- **Polish content, English chrome.** The UI chrome is English today (dashboard, targets). Recipe content is Polish by PRD decision. Keep enum label maps in one module so S-14 can swap them.

## Historical Context (from prior changes)

- `context/archive/2026-10-07-seed-products-and-recipes/plan.md:52-54`: recipe UI deferred to S-05/S-07; "photos/storage (S-05/S-12)"; "FR-010 macros are computed by S-04/S-05 consumers", meaning no macro view exists in SQL.
- `context/archive/2026-10-07-seed-products-and-recipes/plan.md:154`: "(no `photo_url`: S-05 adds it with the storage work)". This is the prior expectation that the recommendation below deliberately revises.
- `context/archive/2026-10-07-seed-products-and-recipes/plan.md:397,405`: "No entity interfaces … The first reading slice (S-03/S-05) adds them alongside its queries"; "List and detail readers are deliberately left to S-03/S-05". This confirms S-05 owns the detail reader and its types.
- `context/archive/2026-10-07-seed-products-and-recipes/research.md:63-70`: macros are computed from products, not stored; rounding step is a product default with an ingredient override; whole-dish is modelled as one component.
- `context/archive/2026-10-07-link-partner-household/plan.md:127` and `plan-brief.md:76`: "the slice that enables [deleting seed rows] (S-05) must revisit the KD006 guard". **Moot.** KD006 was retired by F-04 (`…shared_recipe_library.sql:19-20`), and S-05 is read-only anyway.
- `context/archive/2026-10-08-shared-recipe-library/plan.md:48`: F-04 explicitly left "recipe browsing (S-05)" out of scope. Its manual check expects `Library: 8 recipes · 46 products` on every dashboard (line 230). S-05's card count should agree.
- `context/archive/2026-10-08-shared-recipe-library/` (roadmap F-04 Unknowns, `roadmap.md:125`): the write rule (`created_by`, author plus partner editing) lands with S-07. S-05 must not introduce any write path.
- `D:/Duo-Kitchen/context/changes/plan-three-day-grid/change.md` (S-03, sibling worktree, uncommitted): S-03 owns `listRecipes()` (id, name, cuisine, prep_minutes, meal_types) "with its type in src/types.ts"; S-03 must not change library tables or `seed_integrity.sql`; and "S-05 will build on it after rebasing".

## Related Research

- `context/archive/2026-10-07-seed-products-and-recipes/research.md`: the solver attribute matrix behind every field S-05 displays.
- `context/archive/2026-10-08-shared-recipe-library/research.md`: the public-library decision S-05 reads from.
- `context/archive/2026-10-08-set-daily-macro-targets/research.md`: the closest UI and service precedent.
- `context/archive/2026-10-07-link-partner-household/research.md`: middleware and route protection, `/join` exemption.

## Decision: photo (recommended; stated as an assumption for the planner)

**Recommendation: no schema change in S-05.**

`RecipeCard.astro` gets a fixed-aspect photo slot rendering a deterministic placeholder, for example a gradient keyed on cuisine plus the recipe's initial, or a neutral dish glyph. The DTO carries `photoUrl: null` (or omits it). The photo column and Storage bucket are added by the first slice that can supply a photo (S-12 agent import, or S-07 if it adds a photo field to its write path). That slice also designs the Storage access policy, where public bucket vs. signed URLs is a real "never anon" question.

Why:

- A column that is null on 100% of rows adds no user value.
- No migration means no S-03 timestamp race, no `db push`, and no new isolation-test surface.
- No write path exists in S-05 to populate it.

Revisits the F-02 note at `plan.md:154`; record that in S-05's plan.

**Alternative (option B), if the planner prefers to honour the F-02 note:**

- one nullable `photo_url text` column (`ADD COLUMN` keeps the F-04 revokes in force; the select-only policy is unchanged);
- the card renders the image when non-null, else the placeholder;
- an explicit grant assertion for the new column in `household_isolation.sql`, even though the generic `has_any_column_privilege` checks already cover it;
- no seed-integrity change.

Follow section 10 for the link, timestamp, push and test steps.

## Assumptions

1. No scoping questions were asked (non-interactive). Scope is the full FR-005 (minus ratings display) plus FR-009/FR-010 as listed in the roadmap outcome.
2. No photo column in S-05 (see Decision). Placeholder in the card's photo slot.
3. No `/api/*` route. Two GET SSR pages: `/recipes` and `/recipes/[id]`.
4. Cards show name, cuisine, prep time and meal types, plus an empty named ratings slot. No computed kcal on cards.
5. Detail macros are for one **whole base batch**, labelled as such. There is no per-serving concept.
6. Raw/cooked shown per component with `cooked_yield_ratio` as `≈ raw × ratio`, summing all the component's ingredients.
7. UI chrome stays English to match existing pages. Enum labels sit in one map for S-14. Recipe content renders as stored (Polish).
8. Smoke assertions against pinned seed recipe output stand in for unit tests (no test runner exists).
9. S-05 does not change `supabase/tests/*.sql`, but runs `test:rls` and `test:seed` before merging, after linking this worktree.

## Open Questions

1. **PostgREST embed ambiguity.** Does `recipes?select=recipe_components(...)` raise PGRST201 on the hosted project because `recipe_steps` looks like a junction table? Verify early in implementation with one `select`, or sidestep with FK hints or flat parallel queries (section 5).
2. **Dedupe shape with S-03.** S-03's `listRecipes()` signature and type name are not yet known; the S-03 worktree is still at `change.md`. At rebase, decide whether `getRecipeCards()` wraps `listRecipes()` or both stay.
3. **Rounding-step and piece wording.** "step 10 g", "co 10 g", "4 pcs" or "4 szt." depends on the English-chrome assumption. Confirm when the plan is reviewed. S-14 later localises.
4. **Polish collation** for card ordering on the hosted DB (`order=name`) vs. `localeCompare("pl")` in TS.
5. **Photo**: accept the no-column recommendation, or take option B. Either is compatible with the coordination rules. Option B adds the migration-ordering steps.
