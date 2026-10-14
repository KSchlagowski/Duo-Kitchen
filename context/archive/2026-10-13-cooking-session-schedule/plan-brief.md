# Cooking-Session Schedule (S-10) — Plan Brief

> Full plan: `context/changes/cooking-session-schedule/plan.md`
> Research: `context/changes/cooking-session-schedule/research.md`

## What & Why

Roadmap S-10 (US-03, FR-022): a household opens `/plan/sessions` and sees its 3-day plan arranged into evening and morning cooking sessions ("Sunday evening", "Monday morning"). In each session, steps from several recipes are merged into one ordered list. Everything that can be made ahead goes to the evening before. A morning holds only what must be fresh. This turns a plan into "what do we cook, and when".

## Starting Point

Every input already exists. The plan comes from `getMealPlan()`, and each meal carries its `dishId`, which is the S-08 batch. The steps come from the library's `recipe_steps`, with `timing` (`make_ahead` | `fresh`) and `duration_minutes`. In all 8 seed recipes the make-ahead steps form a prefix. S-09 (the shopping list) supplies the pattern to copy: a pure builder, a thin I/O wrapper and a server-rendered page.

## Desired End State

`/plan/sessions?start=…` (default: the latest plan) lists the sessions in chronological order. Each session has a minutes line. An evening has two sections, **Tonight** and **For tomorrow**. Each section shows its dishes with the meals they feed, batch notes for later meals of a shared batch, and one merged, numbered step list. A shared batch is cooked once. The page is linked from `/plan` and the dashboard. Both partners see the same schedule.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Storage | Derived on read; no table, migration or RPC | The schedule is a pure function of plan + library | change.md / Research |
| Solve dependency | None; steps only, no amounts | Prerequisite is S-03; portions are S-11 | Research |
| Session identity | (date, morning/evening), key `<date>-<part>`, up to 7 | Matches the concept doc's "Monday evening … for Tuesday"; the key is S-11's handle | Research / Plan |
| Make-ahead placement | Evening before the dish's cook day | The PRD's literal rule | Research |
| Fresh placement | Once per dish, at the earliest meal: morning, or the same evening if it is dinner | Avoids cooking a fresh dinner at breakfast | Research (recommended) |
| Shared batch | Steps once (by plan `dishId`); later meals get a batch note | CLAUDE.md S-08 dedup rule; no double baking | Research / change.md |
| Merge order | Longest remaining duration chain first, with recipe order as a hard constraint; ties by earliest meal → name (pl) → dish id | Starts long or passive work early; no equipment data exists | change.md / Research |
| Same recipe twice in a section | One entry, `· N batches` | No duplicated "preheat the oven" | Research (recommended) |
| Make-ahead after a fresh step | Treated as fresh (defensive) | Protects future user recipes; the seed never triggers it | Research |
| Smoke pinning | Step sets from a SQL oracle; Sunday order hand-derived; exact orders in `npm test` | No SQL oracle exists for the ordering | Research |

## Scope

**In scope:**
- pure engine `cooking-sessions.ts` with its types, labels, fixtures and vitest suite;
- `getRecipeSteps()` and `getCookingSchedule()`;
- the `/plan/sessions` page and links from `/plan` and the dashboard;
- smoke coverage on the shared plan `2031-01-20`;
- CLAUDE.md and README.

**Out of scope:**
- the step-by-step cook mode, per-step done state, amounts and portions (S-11);
- any library schema change (equipment, active/passive, "serve" timing);
- clock times or parallel lanes;
- per-person views;
- schedules spanning several plans.

## Architecture / Approach

`getMealPlan()` and `getRecipeSteps()` (three flat queries, no embed because of PGRST201) feed `buildCookingSessions()`. The builder groups meals by dish and takes each dish's earliest meal, which also gives the cook day. It splits the steps into a make-ahead prefix and a fresh tail, places them into sessions and sections, merges same-recipe dishes and orders each section by critical-path list scheduling. `sessions.astro` renders the result server-side with no island, using a 404 / 500 / no-plan / loaded state machine copied from `/plan/shopping`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Pure scheduling engine | Types, labels, builder and display strings, seed fixtures, unit tests pinning every rule and the worked example | The hand-derived orders must match the algorithm exactly |
| 2. Read, page, navigation | `getRecipeSteps()`, `getCookingSchedule()`, `/plan/sessions`, links | PGRST201 if someone embeds instead of using flat queries |
| 3. Smoke + docs | An S-10 smoke section inside the S-08 sequence, plus edge cases; CLAUDE.md / README | Smoke steps are order-sensitive and must sit after the re-share and before the lead-slot swap |

**Prerequisites:** S-09's branch (the base of this one); a hosted Supabase project with the seed library; nothing to `db push`.
**Estimated effort:** about 2 sessions across 3 phases.

## Open Risks & Assumptions

- Reheat or serve steps are stored as `fresh` (Curry 5, Leczo 5). They are scheduled as morning or Tonight steps, and they are not repeated for later meals of a shared batch. A better data model belongs to S-07 / S-11.
- Untimed passive steps (overnight soak, thaw) count 0 for priority, so they sort late. That is fine for v1.
- The minutes line is a sequential upper bound, not a timeline.
- All decisions were taken without the user (non-interactive session), using the research's recommended options. Each one is listed with its alternative in the plan.

## Success Criteria (Summary)

- On a shared-batch plan, the curry steps appear exactly once across all sessions, and Tuesday shows a batch note instead.
- Dinner fresh steps land in the same evening, and every make-ahead step lands in the evening before its cook day.
- Unit tests, lint, `astro check`, build and smoke pass, with no database change.
