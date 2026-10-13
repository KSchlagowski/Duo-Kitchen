# Shopping List from the Plan (S-09) — Plan Brief

> Full plan: `context/changes/shopping-list-from-plan/plan.md`
> Research: `context/changes/shopping-list-from-plan/research.md`

## What & Why

Roadmap S-09 (US-02, FR-021): a household member opens one shopping list for a 3-day plan. Each product appears once, with quantities combined for both people, grouped by store aisle in FR-021's fixed order, and either partner can check items off online. The list is the "shop" step of the "plan, shop, cook one cycle" Success Criterion. It must work whether the plan is solved or not.

## Starting Point

Nothing shopping-related exists yet, but every input does:

- the plan, via `getMealPlan()`;
- solved amounts, stored per day as zod-gated jsonb;
- base amounts, via `getSolverRecipes()`;
- each product's aisle, on `products.aisle`.

The canonical "is this solve group current?" rule lives inside `getPlanSolveStatuses()`. Since S-08, every day of a shared batch stores the full batch amount, so a consumer must count each dish once.

## Desired End State

`/plan/shopping[?start=<date>]` shows an aisle-grouped list. It says which days use exact solved amounts and which use recipe-base estimates, linking each estimated day to its solve page. A tick saves in place without a reload, with a plain-form fallback, and the partner sees it. Solving a day or editing the plan changes the list on the next load, and checks survive amount changes.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Unsolved quantities (roadmap Unknown) | One recipe base batch per dish, labelled "estimate" per day | Base batches are already shoppable and sized for two; scaling by eater count breaks rounding and piece rules | Research default → Plan |
| What counts as exact | Any **current** stored row (solved / needs confirmation / no fit) | These are the rounded amounts the day page shows, and they predict the cook better than base amounts do | Research default → Plan |
| Currency rule | Refactor `getPlanSolveStatuses()` into `getPlanSolveState()`, which also returns current solutions and recipes | One rule, so `/plan`, `/plan/day` and the list never disagree (S-08 F4) | Research → Plan |
| Shared-batch dedup | Key by the plan's `dishId` and read one stored meal per dish | Each day of a batch carries the full amount, so iterating stored meals would double-count | Research (CLAUDE.md rule) |
| List persistence | Derived on every read, never stored; only checks persist | Avoids a second staleness problem | Research |
| Check storage | `shopping_list_checks (plan_id, product_id)` PK, household-scoped, write-revoked | Matches every plan-family table; household resolved server-side | Research → Plan |
| Write path | `public.set_shopping_item_checked(date, uuid, boolean)` definer RPC; KD018 malformed, KD019 product not on the plan; reuses KD007 and KD014 | Distinct KD codes give precise messages, and KD019 stops planting arbitrary rows | Plan |
| Check semantics | Keyed on (plan, product); survives amount changes; idempotent; uncheck always allowed | Simple and convergent for two concurrent partners; "online, not live" | Research → Plan |
| Interaction | No-JS forms first, then a React island with optimistic toggles over a JSON mode of the same API | In-store usability without losing the smoke-testable, no-JS path | Research → Plan |
| Which plan | `?start=`, or else the most recently saved plan | Matches the dashboard's default | Research → Plan |
| Ordering | Aisles in enum order; items by Polish collation; checked items stay in place | Deterministic output; positions don't jump while shopping | Plan |

## Scope

**In scope:**

- the new table, its RPC and their isolation tests;
- the pure builder, with a vitest suite;
- the currency-rule refactor;
- `/plan/shopping` and `POST /api/plan/shopping`, with redirect and JSON modes;
- dashboard and `/plan` links;
- the React check-off island;
- smoke coverage, plus CLAUDE.md and README updates.

**Out of scope:**

- offline check-off, Sync and realtime updates (v2);
- lists spanning several plans;
- `checked_by` and per-recipe breakdowns;
- spice-blend display;
- eater-scaled base amounts;
- any solver or jsonb change;
- the unrelated `MAINTAIN` gap and S-08 archiving.

## Architecture / Approach

The slice follows S-04's split between a pure core and an I/O shell:

1. `getShoppingList()` loads:
   - the plan;
   - `getPlanSolveState()`: statuses, current parsed solutions and base recipes from one load;
   - a new `getIngredientProducts()` map (ingredient id → product id, name, aisle, grams per piece);
   - the household's checks.
2. It passes these to the pure `buildShoppingList()`, which:
   - walks the plan's dishes;
   - takes stored amounts for dishes in current groups, and base batches otherwise;
   - sums per product id and groups by aisle.
3. Checks are written only through the definer RPC.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Check-off table and RPC | Migration, RLS and grants, isolation tests, `db push` | Missing an assertion (`maintain`, function grants) the catch-all doesn't check |
| 2. Pure builder + shared solve state | `buildShoppingList()`, vitest suite, `getPlanSolveState()` refactor | Refactor drifting from current `/plan` statuses |
| 3. Page, API, navigation (no JS) | Usable list with per-item forms, partner-shared checks | Shared-batch double counting; CPU budget on Workers Free |
| 4. In-place check-off island | Optimistic toggle, JSON API mode, revert on failure | Markup and testids diverging from Phase 3 and breaking smoke |
| 5. Smoke + docs | SQL-pinned base-amount check, cross-partner checks, CLAUDE.md and README | Choosing a seed recipe pair that actually shares a product |

**Prerequisites:**

- S-03, S-04 and S-08 are merged (they are, on `main`).
- The Supabase CLI is linked to `tvmfkhnxxsnmvogplknz` with db push rights.
- Two linked test accounts are available for manual checks.

**Estimated effort:** about 3–4 sessions across 5 phases. Phase 4 is optional if time is tight.

## Open Risks & Assumptions

- **A1 is an estimate.** A meal for one person still buys a two-person base batch until its day is solved. The page says so, and the user owns that call (roadmap Unknown).
- **A2 counts unaccepted best fits as exact.** If the household prefers base amounts until a fit is accepted, the change is a one-line filter in `getPlanSolveState()` consumers.
- **Checks survive amount changes.** An item checked before solving stays checked even if solving raises the amount. Flagging that change was rejected as YAGNI.
- **No live sync.** Partners see each other's ticks only on reload, which is acceptable under FR-021's "online" and the PRD's v2 deferral.

## Success Criteria (Summary)

- Opening the list for any plan, solved or not, shows every product once with summed amounts under the right aisle, and says which days are estimates.
- A tick saves in place and the partner sees it. Solving a day switches it to exact amounts, and a shared batch is never doubled.
- `test:rls`, `npm test` and `smoke` cover isolation, quantities and the cross-partner flow, and all pass.
