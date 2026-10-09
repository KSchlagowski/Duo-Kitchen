# Solve a Day's Macros for A and B (S-04) — Plan Brief

> Full plan: `context/changes/solve-daily-macros/plan.md`
> Research: `context/changes/solve-daily-macros/research.md`

## What & Why

A household can solve one planned day. They see how much of every ingredient to cook, and how to split each component between A and B, so that each person's daily kcal, protein, fat and carbs land within ±10 % of their targets. If that is impossible, they accept ±15 % or ±20 %. Beyond ±20 % the app names the recipe that most hinders a fit. This is the product's core value (US-01, FR-018–FR-020), and it is the riskiest slice in the roadmap.

## Starting Point

All the inputs already exist:

- plans with per-meal eaters (S-03);
- per-person targets readable by the partner (S-02);
- a public recipe library with rounding steps, piece rules, minimums and division modes (F-02/F-04);
- pure macro arithmetic reserved for S-04 (`recipe-macros.ts`).

Nothing yet solves or stores a solve, and the repo has no unit-test runner. Research showed a pure-JS LP takes under 1 ms per day. It also showed that rounding, not the LP, decides whether a day fits.

## Desired End State

`/plan` shows each day's solve status, and prompts to solve every day that has all 5 meals. `/plan/day` shows the stored result:

- the cook amount of every ingredient, as whole or half pieces or step-rounded grams;
- each component's split between "You" and "Partner";
- each person's totals against their targets;
- a status line: solved within ±10 %, needs ±N % (with an Accept button), or no fit with the most obstructive recipe named.

Both partners see the same result. Any later change to the day's meals, eaters, members, targets or recipes marks it **Out of date**. Saving the plan is never affected.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Solver | Minimax LP over per-eater component scale factors, `yalps`, with an L1 tie-break | ~30 variables, < 1 ms, deterministic, no WASM needed | Research |
| Tier basis | Judge the tier on the **rounded, displayed** amounts; repair rounding with a bounded local search (≤ 50 moves) | Naive rounding pushed a day from 11.4 % to 16.1 %; MILP is heavier than needed | Research + Plan |
| Escalation UX | One confirmation that names the tier the solve actually needs | The solve is deterministic, so an intermediate ±15 % click could not change the outcome | Plan (P3) |
| Persistence | New write-revoked `plan_day_solutions` table plus definer RPC `save_day_solution` (KD013/KD014) | Gives FR-018 a solved state, honours the S-02 targets-snapshot hand-off, and feeds S-09/S-11 | Research (B) |
| Invalidation | SHA-256 input fingerprint compared on read, including `SOLVER_VERSION`; `save_meal_plan` untouched | Eater-only edits keep meal ids, and target changes have no FK path | Research + Plan |
| Pieces | Batch-level for mixed items (eggs in cookies); per-person whole/half pieces where `allow_half_pieces` is set (bread, rolls) | Matches how the seed data marks served-as-pieces items | Research (A7) |
| Bounds | Solver constants: 0.2–1.5× base batch per eater, ≤ 3× component ratio, ingredient minimums per eater | No library columns exist, and a migration would be out of proportion | Plan (P4) |
| Zero targets | A 0 g target is measured against a 50 g reference (±10 % means ≤ 5 g) | A relative tolerance on 0 is unsatisfiable | Plan (P6) |
| Obstructive recipe | Inconsistent targets are blamed first; otherwise leave-one-out on LP optima, ties broken by slot order then recipe id | Stable, explainable, ≤ 5 extra solves | Research |
| Partial days | Solve only people who eat that day, always against the full daily target, with a UI note | Simplest rule; eating out is not modelled | Plan (P5) |
| Tests | Add vitest (`npm test`, in CI) with seed-recipe fixtures | The solver is pure logic, where unit tests pay off most | Research (A9) |

## Scope

**In scope:**

- the pure solver;
- the batch library reader;
- `getMealPlan` returning meal ids;
- the `/plan/day` page;
- `POST /api/plan/solve`, covering both solve and accept;
- the new table, RPC and isolation tests;
- `/plan` status cards and the 5-meal prompt;
- vitest and CI;
- smoke steps;
- CLAUDE.md and README updates.

**Out of scope:**

- cross-day or shared dishes (S-08);
- shopping list and cooking sessions (S-09/S-11);
- dish-level min/max columns;
- eating-out modelling;
- Polish labels (S-14);
- automatic re-solve on save;
- islands;
- MILP/WASM.

## Architecture / Approach

`day-solutions.ts` loads the inputs: the plan day with meal ids, household members, targets, and library rows for the day's recipes. The pure `macro-solver.ts` then:

1. builds the LP in a fixed, sorted order;
2. solves it;
3. rounds the amounts to steps and pieces and splits them per person;
4. repairs the rounding;
5. computes totals from the displayed amounts;
6. picks the tier;
7. explains a no-fit;
8. fingerprints the inputs.

The API route stores the result through `save_day_solution`. `/plan/day` and `/plan` read it back, recompute the fingerprint and flag stale results. Everything is server-rendered POST/redirect/GET, with no client JS.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Pure solver + read-only preview | Unit-tested solver on seed fixtures; `/plan/day` previews any saved day | Ratio bound or rounding repair fails to get the mixed fixture day within ±10 % (fallback: ratio bound 3 → 4) |
| 2. Persistence + solve/accept + stale | Table, RPC, isolation tests, solve API, stored results, Out of date banner | CI tests the deployed schema: `db push` must come before merge |
| 3. Grid status, prompt, smoke, docs | Per-day status and 5-meal prompt on `/plan`; full smoke coverage; docs | A failing status read must never hide the plan grid (FR-020) |

**Prerequisites:** S-01, S-02 and S-03 are done (they are). The CLI is linked to the hosted project `tvmfkhnxxsnmvogplknz`. Two linked test accounts with targets are needed for manual checks.

**Estimated effort:** about 3 sessions, one per phase. Phase 1 is the largest.

## Open Risks & Assumptions

- The P1–P14 product assumptions were made without the user, because the session was non-interactive. The most consequential are the one-click escalation (P3), the scale and ratio bounds (P4) and the full-day target on partial days (P5).
- Fixture outcomes for F3 (needs ±15 % or ±20 %) and the exact explanation wording are pinned loosely in the smoke test. Exact values are pinned in unit tests from the implementation, because no independent SQL oracle exists for an LP.
- Fixtures are transcribed from the seed migration. A future seed change could drift from them. The smoke test against the real database catches gross drift.
- The Workers plan's CPU limit was not checked. The measured cost is about 1 ms, so no config change is assumed.

## Success Criteria (Summary)

- A full mixed day of seed recipes solves to within ±10 % with cookable amounts: whole eggs, bread slices split per person, spices in grams.
- Whole-dish-heavy days escalate with one confirmation or name *Leczo z kiełbasą*, and the same inputs always give the same output for both partners.
- Plans save and work whatever the solve state, and stale results are flagged, never silently changed.
