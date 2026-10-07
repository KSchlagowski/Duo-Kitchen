<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Seed Products and Recipes Implementation Plan

- **Plan**: context/changes/seed-products-and-recipes/plan.md
- **Research**: context/changes/seed-products-and-recipes/research.md
- **Mode**: Deep (codebase verification done inline. The touched surface is small: 1 migration, 1 SQL test, 6 app/CI files)
- **Date**: 2026-10-07
- **Verdict**: REVISE
- **Findings**: 0 critical, 6 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | WARNING |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

The plan is well grounded and stays inside the F-01 household rule. The main design choices hold up: per-household copies, a denormalised `household_id` with composite FKs, `seed_id` for idempotency, and separate schema and content migrations. Phase order and verification are sound.

Every finding below can be fixed with a targeted edit. None of them forces a redesign. The most likely to cause friction during implementation are:

- **F1**: the Atwater check would reject real nutrition values.
- **F4**: the smoke script cannot see the response body.
- **F5**: the Phase 1 deliberate-break test proves nothing.

## Grounding

Grounding: 12/12 existing paths ✓. New files (2 migrations, `seed_integrity.sql`, `services/recipes.ts`) are correctly absent. Symbols 8/8 ✓:

- `private.handle_new_user` (`migrations/20261006120000_household_data_scope.sql:88-111`; only caller is the trigger at `:109-111`)
- `private.user_household_ids` (`:41-54`)
- the catch-all (`household_isolation.sql:249-287`; exempts only `household_members`)
- test users in `auth.users` (`:23-26`)
- `smoke.mjs:56`, `dashboard.astro:9-24`, `household.ts:5-26`
- CI step "Run household isolation test" (`ci.yml`), `.claude/settings.json` `test:rls` entries
- `config.toml` `major_version = 17`, so `on delete set null (col)` works (it needs PG 15+)

brief↔plan ✓. Progress↔Phase ✓ (6+2 / 7+2 / 4+2 rows match the success-criteria bullets; no checkboxes in the phase bodies). No `context/foundation/lessons.md` or `docs/reference/contract-surfaces.md` exists, so those checks were skipped.

## Findings

### F1 — Atwater check rejects real nutrition values for cocoa and spices

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 2 §1 (Products: "within the Atwater tolerance") and §2 (Atwater assertion `abs(kcal − (4P + 4C + 9F)) ≤ greatest(0.15·kcal, 15)`)
- **Detail**: The rule has no fibre term and does not say which labelling convention applies. High-fibre items in the planned recipes fail it under both common conventions:
  - **Cocoa** (recipe 3), EU/Polish label (carbs exclude fibre): ≈ 334 kcal, P 23, F 10.5, C 13, fibre 33. Then 4P + 4C + 9F ≈ 238. The gap of 96 is more than the 50 allowed.
  - **Cocoa**, USDA convention (carbs include fibre): 228 kcal, P 19.6, F 13.7, C 57.9. Then the formula gives ≈ 433. It fails in the other direction.
  - **Curry powder** (recipe 4), USDA: 325 kcal, P 14, F 14, C 56. The formula gives ≈ 406, a gap of 81 against 49 allowed.

  So the implementer must either enter nutrition values that are not plausible (this goes against FR-012, "plausible products and nutrition values") or loosen the test without guidance. Fixing this is part of the largest piece of work in the change, the Phase 2 content authoring.
- **Fix A ⭐ Recommended**: Fix the convention and make the exemptions explicit in the test, with no schema change.
  - State in Phase 2 §1 that nutrition follows the Polish/EU label convention (carbs exclude fibre).
  - In `seed_integrity.sql`, skip the Atwater check for products in the `spices` aisle and for a short `atwater_exempt uuid[]` list of named seed UUIDs (e.g. cocoa). Give each entry a comment citing the label values.
  - Keep the 15 % tolerance for everything else.
  - Strength: Keeps the "minimum shape" scope; the check still catches typos on the ~35 bulk products that actually drive solver macros.
  - Tradeoff: Exempt products are not checked at all. They are small-quantity items (1 g steps), so their effect on recipe macros is negligible.
  - Confidence: HIGH. The example values above are typical label figures, and the exempt items are used at 1–10 g per recipe.
  - Blind spot: Other borderline products (e.g. high-fibre bread, oat bran) may still need an exemption. Verify by running the test once the content is drafted.
- **Fix B**: Add a fibre column and use the EU energy formula.
  - Add `fiber_per_100g numeric(5,1) not null default 0 check (>= 0)` to `public.products` and `private.seed_products`.
  - Check `abs(kcal − (4P + 4C + 9F + 2·fibre)) ≤ greatest(0.15·kcal, 15)`.
  - Strength: A principled check that matches how EU labels compute energy; fibre data may later be useful to S-05.
  - Tradeoff: Adds a column no consumer in the roadmap needs yet. Cocoa still lands near the edge (≈ 304 against 334), so an exemption may still be needed.
  - Confidence: MED. This fixes the formula, but label rounding still makes some spices fail.
  - Blind spot: Whether S-04/S-05 would ever use fibre has not been checked.
- **Decision**: FIXED — Fix A: Polish/EU label convention (carbs exclude fibre) stated in Phase 2 §1; Atwater assertion in §2 exempts the spices aisle and a commented `atwater_exempt uuid[]` list (e.g. cocoa), 15 % tolerance kept for the rest

### F2 — Re-running `seed_household` brings back seed rows the user deleted

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Migration Notes ("Future content changes … re-runs the backfill loop. Existing copies are untouched."); Phase 3 §5 (CLAUDE.md bullet "Seed content changes go in a new data-only migration that inserts templates and re-runs the backfill")
- **Detail**: Idempotency depends only on `on conflict (household_id, seed_id) do nothing`. That stops duplicates, but any seed row a household has deleted no longer exists, so a re-run inserts it again. Once S-05 lets users edit recipes:
  - Removing a seed ingredient from a seed recipe, then running any later content migration that "re-runs the backfill", puts the ingredient back into the user's edited recipe.
  - A deleted seed recipe comes back in full.

  So "existing copies are untouched" is not true for deletions. The plan writes the wrong workflow into CLAUDE.md, where later slices will follow it. Nothing breaks today (there is no UI that deletes), which is why this is a WARNING and not CRITICAL.
- **Fix A ⭐ Recommended**: Correct the docs and limit `seed_household` to its current use. No new mechanism.
  - Reword the Migration Notes and the CLAUDE.md bullet: "`private.seed_household()` seeds a *new or empty* household (sign-up trigger, first backfill). Once households can edit or delete seed rows (S-05+), do not re-run it on existing households. A later content migration copies only its *new* template rows with targeted `insert … select` keyed on the new seed ids. If repeated backfills become common, add a `private.household_seed_log (household_id, seed_id)` record of past copies and skip ids that were ever copied."
  - Strength: No extra schema now. The current Phase 2 backfill is still correct, because no household has deleted anything yet.
  - Tradeoff: Future content migrations need hand-written targeted copies, especially for child rows.
  - Confidence: HIGH. The failure needs S-05 deletes, which do not exist yet.
  - Blind spot: How often seed content will change after MVP is unknown.
- **Fix B**: Add a copy log now, so re-runs are safe forever.
  - In Phase 1, create `private.household_seed_log (household_id uuid references public.households on delete cascade, seed_id uuid, primary key (household_id, seed_id))` with `revoke all … from public, anon, authenticated`.
  - `seed_household` inserts only template rows whose `seed_id` is not in the log for that household, and records each copied id.
  - Strength: The "re-run the backfill" workflow stays correct for every future migration and future slice.
  - Tradeoff: One more table, and more logic in the most sensitive function (it runs inside sign-up). That adds work to the plan's own "minimum shape" scope.
  - Confidence: MED. A standard pattern, but it adds code paths that `test:seed` must also cover.
  - Blind spot: How S-01 dedupe would use the log has not been designed.
- **Decision**: FIXED — Fix A: Migration Notes, Desired End State, What We're NOT Doing and the Phase 3 §5 CLAUDE.md bullet now limit `seed_household()` to new/empty households, warn about resurrection of deleted rows, and prescribe targeted `insert … select` for new seed ids (copy log noted as the future option)

### F3 — `unique (household_id, name)` on products collides with seed copies

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 §1 `public.products` (`unique (household_id, name)`), together with Critical Implementation Details ("Every insert uses `on conflict (household_id, seed_id) do nothing`")
- **Detail**: The copy names `(household_id, seed_id)` as its conflict target, so a collision on *name* is not caught and raises `unique_violation`. That happens in these cases:
  - **Future content migration**: it adds a seed product "Jajko L" after a user (S-07) has created a product with that name. The backfill fails and the whole content migration aborts for every household.
  - **Isolation test**: a fixture product (Phase 1 §2 "Setup", and "insert a product into A's household succeeds") that reuses a seed product's name fails once Phase 2 content exists.
  - **S-01**: the brief says the household "holds two seed sets" when a partner joins. Both unique keys forbid that, so S-01 must dedupe before moving rows.

  No consumer in this change needs name uniqueness, and the plan gives no reason for it.
- **Fix A ⭐ Recommended**: Drop `unique (household_id, name)` from `public.products` (keep it on `private.seed_products`, where it guards seed content). Leave the product-dedupe policy to S-07, which owns the add-product form and can decide on case-insensitive matching. Name fixture products `RLS test product A/B`.
  - Strength: Removes the failure modes above. The `(household_id, seed_id)` key alone already makes copies idempotent.
  - Tradeoff: Nothing at the DB level stops a household from having duplicate product names until S-07 decides.
  - Confidence: HIGH. Nothing in Phases 1–3 reads products by name.
  - Blind spot: Whether S-07/S-12 agent imports want "upsert by name" has not been checked.
- **Fix B**: Keep the constraint and let `seed_household` adopt existing rows with the same name.
  - Before inserting products, run `update public.products p set seed_id = t.id from private.seed_products t where p.household_id = p_household_id and p.seed_id is null and p.name = t.name`, then insert with the existing conflict target.
  - Add a `test:seed` assertion for this path.
  - Strength: Names stay unique, and the user's product is reused instead of duplicated.
  - Tradeoff: Seed recipes then use the user's nutrition values. The function is more complex, and the adopted row's values differ from the template.
  - Confidence: MED. Correct, but it changes the meaning of `seed_id` ("copied from" becomes "linked to").
  - Blind spot: How this interacts with F2's future "update copies by `seed_id`" story.
- **Decision**: FIXED — Fix A: dropped `unique (household_id, name)` from `public.products` (dedupe left to S-07), kept `unique (name)` on `private.seed_products`, fixture products named `RLS test product A/B`

### F4 — The smoke script cannot see the response body, so the library assertion needs a refactor

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §4 (Smoke assertion)
- **Detail**: The plan says to "also assert that the HTML contains `data-testid="library"`… in the existing step". But `request()` in `scripts/smoke.mjs` returns only `{ status, location }` and never reads `response.text()`. The step table's `expected` only supports `status` and `location`, compared in the loop at `smoke.mjs` (lines 67-70). So the assertion cannot be added "in the existing step" as described.
- **Fix**: Update the Phase 3 §4 contract:
  - `request()` also returns `body: await response.text()`;
  - `expected` gains an optional `body` RegExp, and the loop checks `expected.body === undefined || expected.body.test(actual.body)`;
  - the "dashboard renders for signed-in user" step gets `body: /data-testid="library"[^>]*>\s*Library: [1-9]\d* recipes/`;
  - on failure, print the matched `<p data-testid="library">` text, or "library line missing".
- **Decision**: FIXED — Phase 3 §4 contract now specifies `request()` returning `body`, an optional `expected.body` RegExp checked in the loop, the library regex on the dashboard step, and the failure message

### F5 — Phase 1's deliberate-break test trips the composite FK, not the isolation assertions

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 Success Criteria, 4th automated bullet (Progress 1.4)
- **Detail**: The scratch break "changes A's fixture product's `household_id` to B's". A's fixture ingredient references `(product_id, household_id)` through the composite FK, and that FK uses the default `on update no action`. So the `update` itself fails with `foreign_key_violation`, before any isolation assertion runs. The script exits non-zero, so the criterion technically passes, but it proves nothing about the RLS assertions. (Phase 2's break, flipping `division_mode`, is fine.)
- **Fix**: Replace the scratch break with an RLS break inside the rolled-back transaction, as postgres before impersonating A: `alter policy "products_select_authenticated" on public.products using (true);`. Confirm the run fails with the "B's fixture ids are invisible" / "every row … has household_id = a_household" message, not an FK error.
- **Decision**: FIXED — Phase 1 deliberate break replaced with `alter policy "products_select_authenticated" … using (true)` inside the rolled-back transaction; must fail on the isolation messages, not an FK error

### F6 — New tables skip F-01's `truncate/references/trigger` revoke for `authenticated`

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 §1, "RLS on all five tables" (`revoke all … from anon` only)
- **Detail**:
  - F-01 revoked `insert, update, delete, truncate, references, trigger` from `authenticated` (`20261006120000_household_data_scope.sql:68-69`).
  - The plan revokes only from `anon`, so `authenticated` keeps Supabase's default `ALL`, which includes `TRUNCATE`. TRUNCATE is **not subject to RLS**.
  - PostgREST does not expose it today, so this is defence in depth, not an open hole. Still, it departs from the precedent and the isolation test would not notice.
- **Fix**: Add `revoke truncate, references, trigger on public.<table> from authenticated;` for each of the five tables. Add one isolation-test assertion as user A: `truncate public.products` raises `insufficient_privilege`.
- **Decision**: FIXED — Phase 1 §1 RLS block adds `revoke truncate, references, trigger … from authenticated` per table; isolation test asserts `truncate public.products` as A raises `insufficient_privilege`

### F7 — `npx supabase db advisors --linked` is unverified, and `db lint` is a different tool

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 Success Criteria, 2nd automated bullet (Progress 1.2)
- **Detail**: `node_modules` is not installed in this checkout, so I could not confirm the subcommand exists in the pinned CLI (`supabase ^2.23.4`). The fallback `db lint --linked` runs plpgsql_check on function bodies. It is not the security/performance advisors (RLS-disabled, missing FK index, mutable search_path), so a pass would not mean what the criterion claims.
- **Fix**: Reword 1.2 so it is runnable either way: "run `npx supabase db advisors --linked` if `npx supabase db --help` lists it; otherwise check Dashboard → Advisors (Security + Performance) and record the result. In both cases also run `npx supabase db lint --linked` for the plpgsql functions."
- **Decision**: FIXED — Phase 1 criterion 1.2 reworded: `db advisors --linked` if listed in `db --help`, else Dashboard → Advisors recorded; `db lint --linked` always run for plpgsql functions

### F8 — Deleting a household through the new FKs is never tested

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 §1 (`recipe_ingredients` product FK `on delete restrict`; steps' `on delete set null (component_id)`); Phase 2 §2 Copy fidelity
- **Detail**: Each household delete now cascades through 5 tables along two paths each (the direct `household_id` FK and the composite parent FK), with a non-deferrable `RESTRICT` on `product_id` among them. Postgres queues the cascaded RI checks, so this should succeed, but nothing proves it. S-01 (discarding a household when a partner joins) will be the first code to do this, on live data.
- **Fix**: At the end of the Copy-fidelity block in `seed_integrity.sql`, run `delete from public.households where id = <fresh household>` as postgres. Assert it succeeds and that all five tables have 0 rows for that household.
- **Decision**: FIXED — Phase 2 §2 Copy fidelity ends by deleting the fresh household as postgres and asserting 0 rows in all five tables

### F9 — Each CI smoke run now leaves ~170 seed rows in the hosted project

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Performance Considerations; Phase 3 §5 (README CI section)
- **Detail**: The README already notes that every smoke run signs up a `smoke-<ts>@example.com` account, and nothing ever removes it. After this change each of those accounts also gets ~170 copied rows, and the Phase 2 backfill seeds all old smoke accounts. The amount is small (tens of KB per run), but it grows with every push and PR, the plan doesn't mention it, and it makes manual Table Editor checks (2.8/2.9) noisier.
- **Fix**: Add a line to Performance Considerations and to the README CI section saying that each smoke run leaves one seeded household (~170 rows) behind. Point to the cleanup query `delete from auth.users where email like 'smoke-%@example.com'`, which leaves the households orphaned (account deletion removes only memberships). Leave automated cleanup out of scope.
- **Decision**: FIXED — Performance Considerations and the Phase 3 §5 README contract note ~170 leftover rows per smoke run, with the cleanup query; automated cleanup out of scope

### F10 — Unused surface: entity interfaces and `photo_url`

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 3 §1 (`Product`, `Recipe`, `RecipeComponent`, `RecipeIngredient`, `RecipeStep` interfaces); Phase 1 §1 `public.recipes.photo_url`
- **Detail**:
  - The only TS consumer in this change is `getRecipeLibrarySummary`, which needs only `RecipeLibrarySummary`. The five entity interfaces are hand-written with nothing that uses them or checks them against the schema, so they can drift before S-03/S-05 rely on them.
  - `photo_url` sits on a table whose photo work the plan itself lists under "What We're NOT Doing" (S-05/S-12).
- **Fix**:
  - Limit Phase 3 §1 to `RecipeLibrarySummary` plus the four enum unions, and let the first reading slice (S-03/S-05) add entity interfaces alongside its queries.
  - Drop `photo_url` from Phase 1 and let S-05 add it with the storage work. (If the user prefers to keep the column for agent imports, keep it and add a one-line justification to the plan.)
- **Decision**: FIXED — Phase 3 §1 limited to the four enum unions + `RecipeLibrarySummary` (entity interfaces deferred to S-03/S-05); `photo_url` dropped from `public.recipes` (S-05 adds it)
