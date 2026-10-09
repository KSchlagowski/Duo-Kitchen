<!-- PLAN-REVIEW-REPORT -->

# Plan Review: Browse the Recipe Library (S-05) Implementation Plan

- **Plan**: context/changes/browse-recipe-library/plan.md
- **Mode**: Deep (I checked the code myself instead of using a sub-agent)
- **Date**: 2026-10-08
- **Verdict**: REVISE
- **Findings**: 0 critical, 5 warnings, 2 observations

## Verdicts

| Dimension             | Verdict |
| --------------------- | ------- |
| End-State Alignment   | WARNING |
| Lean Execution        | PASS    |
| Architectural Fitness | WARNING |
| Blind Spots           | WARNING |
| Plan Completeness     | WARNING |

## Grounding

Grounding: 11/11 modified paths ✓ (new files go under `src/components/recipes/` and `src/pages/recipes/`, which don't exist yet, as expected), 8/8 symbols ✓, brief↔plan ✓, Progress↔Phase ✓.

- **Symbols checked:**
  - `getRecipeLibrarySummary`, `PROTECTED_ROUTES` + `startsWith`, `formatMacroTargets`, `maybeSingle` in `getCurrentHousehold`;
  - smoke `testIdBody` and the failure-dump list at `scripts/smoke.mjs:330`;
  - seed ids `…0004` (Kurczak curry), `…0006` (Leczo), `…0008` (Zapiekanka);
  - zod `^4.6.5`.
- **Progress section:** Phases 1–4 map to Progress entries 1.1–1.4, 2.1–2.10, 3.1–3.8 and 4.1–4.10 one-to-one. There are no checkboxes in the phase bodies and only one `## Progress` heading.
- **404 handling (A7):** I checked it against Astro 7. `core/routing/handler.js:126` and `core/errors/handler.js:26` reroute a 404 or 500 only when the response body is `null`. So a page that sets `Astro.response.status = 404` and renders a body keeps that body. A7 works as planned.

The plan is in good shape overall:

- The zero-migration decision, the flat-query workaround for PGRST201 and the "SQL oracle, not page output" pinning rule are all well grounded.
- The findings below are targeted fixes. None of them calls for a redesign.

## Findings

### F1 — The smoke "oracle" SQL the plan points to computes a different quantity

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Critical Implementation Details (smoke pins); Phase 3 §1 Contract; Key Discoveries ("`seed_integrity.sql:268-290` … is the oracle")
- **Detail**:
  - **What the referenced SQL computes.** The plan says to derive the `recipe-total` and `component-cooked` pins by "adapting the component-macro SQL at `seed_integrity.sql:268-290`". That block does not compute what the page shows:
    - It sums `protein_per_100g × 4`, `carbs_per_100g × 4` and `fat_per_100g × 9`, which are macro-derived kcal shares.
    - It reads the `pg_temp.seed_*` views, not `public.*`.
    - It never touches `kcal_per_100g` and has no cooked-weight term.
  - **The page computes something else.** `formatMacroTotals()` uses `kcal_per_100g` directly. A faithful "adaptation" therefore gives a kcal pin that disagrees with the page.
  - **That pushes the implementer toward a tautological fix.** Their next move is to "fix" the pin from the rendered page, which is exactly the tautology the plan forbids.
  - **The cooked line is an exact-.5 case, and the research has it wrong.** Ryż is 160 + 1 = 161 g × 2.50 = 402.5 g (`seed_products_and_recipes.sql:118,158-159`), but `research.md` §6 says "~402". JS `Math.round` and Postgres `round(numeric)` both give **403**. The pin is still correct as long as both sides round half-up, but the research figure must not be copied.
- **Fix**: Replace the "adapt `seed_integrity.sql:268-290`" wording in Critical Implementation Details with the literal oracle queries below, and say that the pins are exactly their output. Ryż is expected to give `Raw 161 g → cooked ≈ 403 g (×2.50)` and Kurczak `Raw 416 g → cooked ≈ 312 g (×0.75)`.
  ```sql
  -- recipe-total (whole batch)
  select round(sum(i.base_amount_g * p.kcal_per_100g    / 100)) as kcal,
         round(sum(i.base_amount_g * p.protein_per_100g / 100)) as protein_g,
         round(sum(i.base_amount_g * p.fat_per_100g     / 100)) as fat_g,
         round(sum(i.base_amount_g * p.carbs_per_100g   / 100)) as carbs_g
  from public.recipe_ingredients i
  join public.recipe_components c on c.id = i.component_id
  join public.products p on p.id = i.product_id
  where c.recipe_id = '5eed0002-0000-4000-8000-000000000004';
  -- component-cooked lines
  select c.position, c.name, sum(i.base_amount_g) as raw_g,
         round(sum(i.base_amount_g) * c.cooked_yield_ratio) as cooked_g, c.cooked_yield_ratio
  from public.recipe_components c
  join public.recipe_ingredients i on i.component_id = c.id
  where c.recipe_id = '5eed0002-0000-4000-8000-000000000004' and c.cooked_yield_ratio is not null
  group by c.id order by c.position;
  ```
- **Decision**: FIXED (Fix) — Critical Implementation Details now carries the literal oracle queries, the expected Ryż/Kurczak cooked lines and the exact-.5 warning; Key Discoveries and References no longer call `seed_integrity.sql:268-290` the oracle.

### F2 — Phase 4's label-map consolidation contradicts "No S-05 behaviour changes"

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: Phase 4 §1 (Intent: "consolidate onto one map and keep whichever one landed first on `main`"; Contract: "No S-05 behaviour changes")
- **Detail**:
  - **Which map wins.** S-03 lands first, so if it ships a meal-type label map, Phase 4 keeps S-03's map.
  - **Why that matters.** S-03's picker may use different wording: Polish labels, or "Second Breakfast" instead of "Second breakfast". It may also have no `DivisionMode` or `StepTiming` entries.
  - **What breaks.** Any wording change alters S-05's rendered `recipe-meal-types` and `recipe-division` text. That breaks the smoke pins (`"Lunch · Dinner"`, `"Divisible components"`, `"No suggested meal type"`) and contradicts the phase's own "No S-05 behaviour changes" contract.
  - **No resolution rule.** The plan gives no rule for a wording conflict. A10 also only forbids changing S-03's _function or type_, and says nothing about its label constants. The implementer would have to guess.
- **Fix A ⭐ Recommended**: Adopt S-03's map as the single map and extend it with S-05's missing `DivisionMode` / `StepTiming` entries. Re-pin the affected smoke strings from the adopted labels, and change the Phase 4 contract to "No S-05 behaviour change except label wording, if consolidation changes it; smoke pins updated accordingly".
  - Strength: It keeps the "one map, first on main wins" rule and the S-14 single-swap-point goal. Re-pinning labels is mechanical, because labels are not computed values.
  - Tradeoff: S-05's English wording may change at rebase time, and the smoke label pins are edited in Phase 4.
  - Confidence: HIGH — the change is confined to `recipe-labels.ts` (or S-03's equivalent) and three smoke constants.
  - Blind spot: S-03's map shape is unknown until it lands. It might be keyed or typed differently, for example an array of options instead of a `Record`.
- **Fix B**: Make `src/lib/recipe-labels.ts` the canonical map and add a Phase 4 step that points S-03's picker at it, with S-03's original wording carried over for any key S-03 already rendered.
  - Strength: S-05's labels and smoke pins stay untouched.
  - Tradeoff: It edits S-03 code during S-05's rebase, which pushes against the spirit of change.md's "S-05 adapts to S-03" rule. S-03's own smoke steps may pin its wording too.
  - Confidence: MEDIUM — it depends on S-03 having no smoke assertions on its labels.
  - Blind spot: S-03's tests and owners have not been consulted.
- **Decision**: FIXED (Fix A) — Phase 4 §1 adopts S-03's map, extends it with S-05's `DivisionMode`/`StepTiming` entries, re-pins smoke label strings on a wording change; contract relaxed to "no behaviour change except label wording".

### F3 — The worktree has no `node_modules`, `.env` or `.dev.vars`, so Phase 1 cannot run

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Current State Analysis; Critical Implementation Details ("Link the worktree before Phase 3"); Phase 1 Success Criteria
- **Detail**:
  - **The only setup gap the plan records is the Supabase link.** In this worktree, `ls node_modules` fails, and `.env` and `.dev.vars` are absent. They exist only in the main checkout `D:/Duo-Kitchen`.
  - **What fails:**
    - Phase 1's first automated check, `npm run lint`, fails immediately.
    - Phase 1's manual `console.log` check needs a dev server with `SUPABASE_URL` / `SUPABASE_KEY` from `.dev.vars`.
    - Phase 3's smoke run against `npm run preview` needs the same `.dev.vars`.
    - `astro build` would still succeed, because both env fields are `optional: true` in `astro.config.mjs:19-20`. Every page would then render "unavailable", which looks like a code bug.
- **Fix**: Add a "Worktree setup (before Phase 1)" bullet to Critical Implementation Details, and the same text to Current State Analysis:
  - `npm ci`;
  - copy `.env` and `.dev.vars` from `D:/Duo-Kitchen` (both are gitignored, so do not commit them);
  - `npx supabase link --project-ref tvmfkhnxxsnmvogplknz`. This moves the link step earlier, because Phase 1's manual check already reads the hosted DB.
- **Decision**: FIXED (Fix) — "Worktree setup (before Phase 1)" bullet replaces the old "link before Phase 3" bullet in Critical Implementation Details; matching note added to Current State Analysis.

### F4 — Rebasing an already-pushed branch needs a force push, and the plan doesn't say so

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 3 Implementation Note ("Phases 1–3 may be pushed on the S-05 branch"); Phase 4 §1 (`git rebase origin/main`)
- **Detail**:
  - **The conflict.** Phases 1–3 are pushed to `origin/claude/s-05-prompt-chain-183cb8`, and the project rule is to push every commit. Phase 4 then rewrites that history with `git rebase origin/main`.
  - **What the plan leaves out.** A plain `git push` after the rebase is rejected as non-fast-forward. Nothing says how to publish the rebased branch. Without that, the implementer may use `--force`, which discards any remote-only commits, or may merge instead, which leaves a different history than the plan describes.
- **Fix**: Add to Phase 4 §1: "After the rebase and the re-verification, publish with `git push --force-with-lease origin claude/s-05-prompt-chain-183cb8` (never bare `--force`)". Add a matching Automated row: "Rebased branch published: `git status -sb` shows no divergence from origin".
- **Decision**: FIXED (Fix) — Phase 4 §1 publishes with `--force-with-lease`; new Automated criterion and Progress row 4.9 added (manual rows renumbered to 4.10–4.11).

### F5 — The smoke test checks that the step headings exist, but not the make-ahead/fresh split itself

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Phase 2 §3 Contract (`steps-make-ahead` / `steps-fresh` "as section headings or `<section>` markers"); Phase 3 §1 ("both step-section markers")
- **Detail**:
  - **What FR-009 needs.** It requires steps _split_ into make-ahead and fresh. The smoke step checks only that the two markers exist.
  - **What would still pass.** A bug that puts every step under one heading, or ignores `timing`, would pass with both headings present.
  - **The markers are ambiguous.** The Contract lists the markers among "stable `<p data-testid>`s", then also allows `<section>` markers. `testIdBody()` (`scripts/smoke.mjs:83-85`) only matches an element closed by `</p>`, so the implementer has to guess which form the smoke regex should target.
  - **The data supports a better check.** Kurczak curry has a known make-ahead step tied to the Ryż component, "Ugotuj ryż w osolonej wodzie…" (`seed_products_and_recipes.sql:246`), and one fresh step with no component (line 254). That is enough to assert the split, not just the headings.
- **Fix**: Settle the marker form as `<h2 data-testid="steps-make-ahead">` / `<h2 data-testid="steps-fresh">`, in that order in the DOM. Add a Kurczak smoke assertion with a regex:
  - `data-testid="steps-make-ahead"`, then `Ugotuj ryż w osolonej wodzie`, then `data-testid="steps-fresh"`;
  - plus the fresh step `Odważ porcje każdego składnika, odgrzej i podaj.` (`seed_products_and_recipes.sql:253-254`, timing `fresh`, no component), which must appear only after `steps-fresh`.
- **Decision**: FIXED (Fix) — Phase 2 §3 settles the markers as ordered `<h2 data-testid>` headings; Phase 3 §1 and the Testing Strategy assert the make-ahead/fresh split with the two known Kurczak steps.

### F6 — `RecipeCard` the type and `RecipeCard` the component collide in `src/pages/recipes/index.astro`

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1 (`RecipeCard` DTO); Phase 2 §1–§2 (`RecipeCard.astro`, library page)
- **Detail**:
  - **Why it happens.** The library page follows the `targets.astro` pattern: `let targets: MacroTargets[] | null = null;` with a type import from `@/types`. A page written the same way needs `import type { RecipeCard } from "@/types"` next to `import RecipeCard from "@/components/recipes/RecipeCard.astro"`.
  - **What fails.** That is a duplicate identifier, and `astro check` (2.2) fails on it.
  - **Workaround.** Inferring the type avoids the clash, but the plan prescribes the explicit-null pattern.
- **Fix**: In Phase 2 §2, state that the page imports the DTO under an alias (`import type { RecipeCard as RecipeCardData } from "@/types"`), or rename the component file to `RecipeTile.astro`. Keep the DTO name, because `RecipeDetail extends RecipeCard` and the CLAUDE.md bullet reference it.
- **Decision**: FIXED (Fix, alias option) — Phase 2 §2 imports the DTO as `RecipeCardData`; DTO and component names unchanged.

### F7 — The "status 500 on a failed read" promise is not backed for `/recipes`

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Desired End State ("A failed read renders 'Recipe library is unavailable right now' with status 500"); Phase 2 §2 (library page contract)
- **Detail**:
  - **The promise.** The Desired End State promises status 500 on a failed read, and doesn't say which page it covers.
  - **Detail page.** Phase 2 §3 sets 500, so the promise holds there.
  - **Library page.** Phase 2 §2 follows the `targets.astro` pattern, which renders the unavailable text with the default 200 and never sets a status.
  - **Consequence.** The implementer can't tell whether `/recipes` should return 500. No smoke step can force a read failure, so the gap would never surface.
- **Fix**: Rescope the Desired End State sentence to the detail page ("`/recipes/<id>`: a failed read renders … with status 500"). Add to Phase 2 §2: "`/recipes` keeps status 200 with the unavailable text, matching `dashboard.astro` / `targets.astro`."
- **Decision**: FIXED (Fix) — Desired End State scopes the 500 to `/recipes/<id>`; Phase 2 §2 states `/recipes` keeps 200 with the unavailable text.
