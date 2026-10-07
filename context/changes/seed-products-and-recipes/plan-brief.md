# Seed Products and Recipes — Plan Brief

> Full plan: `context/changes/seed-products-and-recipes/plan.md`
> Research: `context/changes/seed-products-and-recipes/research.md`

## What & Why

Roadmap F-02 adds a product database (nutrition per 100 g, store aisle) and 8 test recipes. Each recipe carries every attribute the solver and scheduler need:

- rounding step;
- minimum sensible amount;
- whole/half-piece rule;
- raw vs. cooked weight;
- per-component vs. whole-dish division;
- make-ahead vs. fresh steps.

S-03, S-04, S-05 and S-07 cannot be built or verified without this data. The scope is seed data and the minimum shape. There is no recipe UI.

## Starting Point

F-01 left one migration: households, memberships, the `private.user_household_ids()` RLS choke point, a sign-up trigger that creates a household, and a rolled-back isolation test with a catch-all over every `household_id` table. Nothing exists yet for products or recipes. Supabase is cloud-only, so seeding must go through `db push`.

## Desired End State

Every household starts with its own copy of ~40 products and 8 Polish recipes. New accounts get the copy through the sign-up trigger, and existing households get it through a backfill. Two SQL tests prove household isolation and seed integrity/coverage, and CI runs both. `/dashboard` shows "Library: 8 recipes · N products", and the smoke test asserts it.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|---|---|---|---|
| Product ownership (roadmap Unknown) | Per-household copy of a `private` template (Option B) | Stays inside the `household_id not null` hard rule and the catch-all, gives one FK target for S-07/S-12, and reuses the recipe mechanism. | Research (assumption) → Plan |
| Recipe ownership | Household-owned, copied per household | FR-003/024/025 and the privacy NFR. | Research |
| Seeding path | Data in migrations + `private.seed_household()` called by the sign-up trigger + backfill | Matches the mandated `db push` workflow; `seed.sql` needs the forbidden `db reset`. | Research → Plan |
| Child-table scoping | `household_id` on every child table + composite FKs | Policies stay one-liners under the catch-all, and cross-household references become impossible. | Research → Plan |
| Copy traceability | `seed_id` + `unique (household_id, seed_id)` | Idempotent copies, deterministic test addressing, and a handle for S-01 dedupe and future update migrations. | Plan |
| Minimum sensible amount | Per recipe ingredient (`min_amount_g`) | The concept's "at least 1 egg" is per ingredient, and S-06 can derive minimum calories from it. | Plan |
| Raw/cooked | `cooked_yield_ratio` on the component | Yield depends on the cooking method, not the product. | Plan |
| Units | Grams only; `grams_per_piece` for piece products | Keeps the solver input uniform; display units are deferred. | Plan |
| Rounding / half pieces | Product default step + ingredient override; `allow_half_pieces` on the ingredient | Concept: "each ingredient has its own rounding step", halves "if the recipe allows it". | Plan |
| Integrity checks | DB `check` constraints + rolled-back `test:seed` in CI | Single-row rules fail on insert, and cross-row and coverage rules fail in CI. | Plan |
| App layer | Types + count service + dashboard line + smoke assertion | Visible confirmation (F-01 precedent), and smoke guards seeding end-to-end; no recipe UI. | Plan |

## Scope

**In scope:**

- 4 enums and 5 household tables with RLS.
- `private.seed_*` templates, `private.seed_household()`, and the extended trigger.
- 8 recipes and ~40 products, plus a backfill for existing households.
- The isolation test extension, the new integrity test, an npm script and a CI step.
- Types, a count service, the dashboard line, the smoke assertion, and docs.

**Out of scope:**

- Recipe or product UI.
- Ratings, plans, photos, and "system" attribution.
- Macro computation in TypeScript or a SQL view.
- ml/piece display units.
- Propagating seed edits to existing copies.
- S-01 dedupe.
- Generated types.
- `seed.sql`.

## Architecture / Approach

The migration fills the `private.seed_*` templates, which have stable `5eed…` UUIDs and are not exposed to the API. `private.seed_household(h)` copies them into `public.products` → `recipes` → `recipe_components` → `recipe_ingredients` / `recipe_steps`. Each copy gets a fresh id and a `seed_id` back-reference, with `on conflict do nothing`. The sign-up trigger calls the function for new accounts, and a backfill loop calls it for existing households. A whole-dish recipe has exactly one component, so the solver always scales components as units with fixed internal ratios.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. Schema, seeding hook & isolation test | Tables, RLS, templates, seed function, trigger; isolation test covers the new tables | A broken trigger blocks sign-up (guarded by smoke); composite FK `set null (col)` subtlety |
| 2. Seed content, backfill & integrity test | 8 recipes + ~40 products in every household; `test:seed` in CI | Implausible nutrition or amounts (caught by the Atwater and multiple-of-step checks) |
| 3. App layer, smoke assertion & docs | Types, count service, dashboard "Library" line, smoke check, CLAUDE.md/README | Low |

**Prerequisites:** F-01 done; `npm ci`; `npx supabase link --project-ref <ref>`; `SUPABASE_ACCESS_TOKEN` available locally.
**Estimated effort:** ~2–3 sessions across 3 phases. Phase 2 content authoring is the largest part.

## Open Risks & Assumptions

- Option B duplicates seed rows per household. Fixing a seed value later needs an explicit update migration keyed on `seed_id`.
- When a partner joins (S-01), the household holds two seed sets. S-01 must discard seed-origin rows (`seed_id is not null`) from one side.
- The macro-diversity thresholds (≥ 50 % protein / ≥ 60 % carb / ≥ 50 % fat components) are a heuristic for "S-04 has independent levers", not a proof of solvability.
- All decisions were taken in a non-interactive session. The product-ownership choice is the one most worth confirming with the user before Phase 1.

## Success Criteria (Summary)

- A fresh account immediately has 8 recipes and its own products, and cannot see or touch another household's.
- `npm run test:rls`, `npm run test:seed` and `npm run smoke` pass locally and in CI against the pushed schema.
- The seed set exercises every solver rule, so S-04 has real fixtures to verify against.
