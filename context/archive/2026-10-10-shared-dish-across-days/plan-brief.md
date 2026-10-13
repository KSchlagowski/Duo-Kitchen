# S-08 Shared dish across days — Plan Brief

> Full plan: `context/changes/shared-dish-across-days/plan.md`
> Research: `context/changes/shared-dish-across-days/research.md`

## What & Why

Let one cooked batch cover meals on several days of a 3-day plan, and still land each person's
*daily* macro totals within tolerance (roadmap S-08, PRD US-01 / FR-017). The couple cooks in bulk
and eats from a box during the day, so "lunch for 2–3 days" is the normal case — today the schema
forbids it (`plan_meals_dish_id_key unique (dish_id)`) and the solver only ever sees one day.

## Starting Point

S-03 designed `plan_dishes` for exactly this: the batch entity carries **no** quantity column and
**no** `unique (plan_id, recipe_id)`, and the migration header already spells out the two DDL
statements S-08 would run. S-04's solver bounds each scale variable **per serving**, not per batch,
and `plan_day_solutions` stores un-normalised jsonb with no FK to meals or dishes. So the groundwork
holds — but the dish id is projected away above SQL, `save_meal_plan` can only ever insert one dish
per slot, its diff is dish-blind, and the fingerprint sees neither `dayIndex` nor dish identity.

## Desired End State

Each slot on `/plan` gains a *"Share a batch with"* select naming another slot. Picking one makes the
two slots eat from one dish. Solving any day of a group solves the whole group in one LP and writes
one row per day atomically, so both days show the same status and the same tier. The cooking day's
page says *"set aside X for Wednesday"*; the other says *"from Tuesday's batch"*. Editing either day
marks both out of date.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Coupling | Couple the days; the unit is the **solve group** | Sequential solving hits a sizing paradox — day 0 has no reason to cook more than day 0 needs, and re-solving it invalidates day 1 again | Research |
| Blast radius | A day sharing nothing is a group of one | Makes the singleton path byte-identical to today, protecting F1–F4 and six smoke assertions | Research |
| Cooking day | The lowest `day_index` of the dish's meals | Stable under re-solve, needs no column, matches the cook-ahead intent S-10 schedules against | Research |
| Stored shape | Keep `version: 1`, add optional `meals[].batch` | A `version: 2` bump would turn every pre-S-08 row from "Out of date" into "Not solved" | Research |
| Dedup key | Consumers count each `batch.dishId` once | S-09's shopping list and S-11's cook mode would otherwise double-count a shared batch | Research |
| Solution write path | One new `save_plan_day_solutions`; **drop** `save_day_solution` | A group's days share one fingerprint and tolerance, so they must be written atomically — and `plan_day_solutions` keeps exactly one write path | Plan (D2) |
| Affordance | Explicit per-slot select naming **another slot** | Inference would surprise (two identical breakfasts are usually fresh); a slot reference validates against the submitted payload, so no island is needed | Plan (D3) |
| Tier semantics | `requiredTier` = the group's; `maxDeviationPct` = the day's | An accept must apply group-wide, or one day sits at ±15 % while its partner day does not | Plan (D5) |
| No-fit blame | Leave-one-**dish**-out, once per group | Removing one meal of a shared dish does not remove the batch; also fewer re-solves | Research + Plan (D6) |
| Explanation shape | Add a defaulted `sharedAcrossDays` flag, not a third `kind` | A zod `discriminatedUnion` fails on an unknown discriminator, forcing reader-before-writer deploys | Plan (D7) |
| Repair budget | `MAX_REPAIR_MOVES × dayCount` | A fixed 50 spread over 3× the states would round worse per day; reduces to 50 for a singleton | Plan (D9) |
| Solver constants | Unchanged, `MAX_SCALE` included | The 1.5× bound is already **per serving** and the cook amount is already a sum of them | Research §4.1 |
| F8 (names) | Fold in | Renaming a recipe currently leaves a stale name on a row that reads as current; the version bump makes it free | Plan (D11) |
| F10 (concurrent accept) | Out of scope | The SQL `greatest(…)` fix would desynchronise the stored `status` from the tolerance, since `statusFor()` runs in the app | Plan (D10) |

## Scope

**In scope:** dropping `plan_meals_dish_id_key` plus its replacement index; a `share_with` key on
`save_meal_plan` with KD015/KD016/KD017 and a grouping-aware diff; `save_plan_day_solutions`
replacing `save_day_solution`; the coupled LP, the N-serving split model, per-dish blame and the
fixed fingerprint; `dishId` carried up through `getMealPlan()`; the grid's batch select and the day
page's batch notes; new isolation, unit and smoke coverage.

**Out of scope:** a dish across two plans; spoilage/expiry/pantry/servings/pot capacity; any library
schema change; any new `public` table; any solver-constant change; F9 and F10; a `/plan` island.

## Architecture / Approach

```
/plan grid  ──d{day}_{meal}_batch (names a SLOT)──▶  /api/plan  ──share_with──▶  save_meal_plan
                                                                                  │ union-find over
                                                                                  │ the share edges
                                                                                  ▼
                                                                    one plan_dishes row per group

plan.meals (+dishId) ──solveGroups()──▶ one SolveDayInput per connected component of days
                                            │
                                            ▼
                          solveGroup(): one LP, tot_{day}_{person}_{macro},
                          scale per (dish, component, serving) ──▶ one DaySolution per day
                                            │
                                            ▼
                        save_plan_day_solutions(start_date, [{day_index, …}])  — atomic
```

One group fingerprint, stored on every day of the group, is what makes cross-day staleness and
group-wide acceptance work without any FK.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. The coupled solver (pure) | Grouping, the N-serving split model, the coupled LP, per-dish blame, the fixed fingerprint, F5/F6 fixtures | **CPU on the edge** — a coupled 3-day no-fit solve multiplies the LP, the repair search and the leave-one-out count; measured here with a pre-committed, behaviour-neutral mitigation |
| 2. Schema + the two RPCs | The migration, the grouping-aware diff, the atomic group writer, the isolation test | The write-revoke probe loses the dropped constraint as its backstop and would pass silently if not re-reasoned |
| 3. Services, routes, pages | `dishId` up the read path, group-aware solve service, the batch select, the batch notes | PostgREST may change the `plan_dishes` embed's shape once the unique constraint is dropped |
| 4. Smoke, docs, full chain | The S-08 smoke section, CLAUDE.md / README, the mandated verification order | "One batch, not two" is only observable over HTTP via a `data-testid` on a `<p>` element |

**Prerequisites:** `npm ci` (this checkout has no `node_modules`), `.env` / `.dev.vars` with
`SUPABASE_URL` / `SUPABASE_KEY`, the Supabase CLI linked to `tvmfkhnxxsnmvogplknz`, and S-04 shipped.

**Estimated effort:** ~4 sessions, one per phase; phase 1 is the largest (the solver surgery) and
phase 2 the most test-churn-heavy. Phases 2 and 3 must land in one branch — between them the app
calls a dropped function.

## Open Risks & Assumptions

- **CPU budget is the one finding that could change the design.** Today's single-day no-fit solve is
  already ~10 ms, at the Workers Free plan's limit, and the repository does not record which plan the
  account is on. Phase 1 gates on a relative (≤ 25× the single-day solve) and absolute (≤ 250 ms)
  budget; every fallback is behaviour-neutral, so the measurement can only change speed, not output.
- **F5's exact tier is a property of the LP.** The plan asserts `[10, 15]`, mirroring the pattern F3
  already uses, rather than pinning ±10 % it cannot know in advance.
- **A 3-day shared lunch for two people can reach ~9× a base batch.** Accepted and documented: the
  PRD has no equipment or servings model.
- **Every stored solve goes stale** on the `SOLVER_VERSION` 2 → 3 bump. Intended, and stale rows
  still render with "Solve again".
- **Assumed from prior decisions, not re-litigated:** a dish never crosses plans (S-03); no
  spoilage/pantry/servings model (PRD Non-Goals); no library schema change (S-04).

## Success Criteria (Summary)

- A user can mark one slot's batch as shared with another slot, save, and see one batch — not two —
  on both days.
- Solving either day solves both, and both days report the same tolerance tier; editing either day
  marks both out of date.
- Nothing about an unshared plan changes: F1–F4 and every existing smoke assertion pass untouched.
