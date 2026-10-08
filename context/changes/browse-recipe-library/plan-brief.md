# Browse the Recipe Library (S-05) — Plan Brief

> Full plan: `context/changes/browse-recipe-library/plan.md`
> Research: `context/changes/browse-recipe-library/research.md`

## What & Why

Signed-in users can browse the shared recipe library as cards and open a recipe's full detail: ingredients with quantities, computed macros and rounding step, make-ahead vs. fresh steps, divisible components or whole-dish flag, raw/cooked weights, meal types, cuisine and prep time (FR-005, FR-009, FR-010, FR-012). This is also where agent-imported recipes (S-12) will become visible later.

## Starting Point

The F-04 public library already holds every field S-05 shows except a photo. Every authenticated user can read it, and no client can write it. The only library reader today is the dashboard's count summary. S-03 is being built in parallel and merges first.

## Desired End State

`/recipes` shows 8+ cards: a placeholder photo, name, cuisine, prep time, meal types and an empty ratings slot. `/recipes/<id>` shows the full detail with whole-batch and per-component macros computed in TS. Bad ids return 404. The smoke test pins the computed output of a seed recipe against an SQL oracle.

## Key Decisions Made

| Decision     | Choice                                                                            | Why (1 sentence)                                                                         | Source          |
| ------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------- |
| Photo        | No column, placeholder slot (revises the F-02 note)                               | A column null on every row adds nothing, and skipping it removes the S-03 migration race | Research → Plan |
| Schema       | Zero migrations; tests only run                                                   | Library already has every field and select-only RLS                                      | Research        |
| Detail query | 3 flat parallel queries, assembled in TS                                          | Sidesteps the PGRST201 ambiguity from `recipe_steps`' dual FK                            | Plan            |
| Macros       | Pure helpers in `src/lib/services/recipe-macros.ts`, whole batch, integer-rounded | S-04 reuses them; integers keep smoke pins stable                                        | Plan            |
| Islands      | None — `.astro` only                                                              | No state or events until S-06                                                            | Research        |
| Ratings      | Named Astro `ratings` slot, renders nothing                                       | S-06 fills it without restructuring the card                                             | Research        |
| Language     | English chrome, Polish content, one label map                                     | Matches existing pages; S-14 swaps the map                                               | Plan            |
| Sort         | `localeCompare("pl")` in TS                                                       | Hosted DB collation unverified                                                           | Plan            |
| S-03 dedupe  | `getRecipeCards()` wraps `listRecipes()` if it covers the fields, else both stay  | S-03 lands first and owns its function                                                   | Plan            |
| Test oracle  | Smoke pins derived from SQL, not page output                                      | Avoids a tautological test                                                               | Plan            |

## Scope

**In scope:** `/recipes` and `/recipes/[id]` pages, `RecipeCard.astro`, service readers, DTOs, label map, macro helpers, middleware entry, dashboard link, smoke steps, README/CLAUDE/roadmap S-05 lines, gated rebase onto S-03.

**Out of scope:** photo column or Storage, ratings, filters and sorting (S-06), any write path (S-07), plan tables (S-03), per-person macro split (S-04), localisation (S-14), unit-test runner.

## Architecture / Approach

SSR page → `src/lib/services/recipes.ts` (Supabase reads with the cookie session, through select-only RLS) → Row→DTO mapping + `recipe-macros.ts` arithmetic → `.astro` rendering with `data-testid` lines that hold exact formatter output for `scripts/smoke.mjs`.

## Phases at a Glance

| Phase                              | What it delivers                                                | Key risk                                                            |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1. Types, labels, helpers, readers | DTOs, label map, macro math, `getRecipeCards`/`getRecipeDetail` | Embed shape or ordering mistakes                                    |
| 2. Pages, card, protection, link   | Card grid, detail view, 404/unavailable states                  | Edge-case rendering (0 meal types, null component/duration, pieces) |
| 3. Smoke, docs, roadmap            | End-to-end proof against hosted DB                              | Float/rounding mismatch vs. SQL oracle                              |
| 4. Rebase onto S-03 (gated)        | Merged, deduped, fully re-verified                              | Shared-file conflicts; duplicate label maps                         |

**Prerequisites:** worktree linked with `npx supabase link --project-ref tvmfkhnxxsnmvogplknz` (before Phase 3); S-03 on `main` (before Phase 4).
**Estimated effort:** ~2 sessions for Phases 1–3, plus a short session for Phase 4.

## Open Risks & Assumptions

- PGRST201 is avoided by design, but the nested `recipe_components → recipe_ingredients → products` embed is still unverified on the hosted project (checked manually in Phase 1).
- English wording for steps and pieces ("step 10 g", "4 pcs") is an assumption. Revisit it in review or in S-14.
- S-03's `listRecipes()` shape is unknown until it lands, so the dedupe is decided in Phase 4 by rule A10.

## Success Criteria (Summary)

- A signed-in user can browse all recipes and see every FR-009 attribute for any of them, with macros computed from products.
- Anon visitors are redirected. Bad ids return 404. Read failures never look like "empty" or "not found".
- Lint, `astro check`, build, `test:rls`, `test:seed` and smoke all pass after rebasing onto S-03.
