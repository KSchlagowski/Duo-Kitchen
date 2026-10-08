# Plan a 3-Day Grid (S-03) — Plan Brief

> Full plan: `context/changes/plan-three-day-grid/plan.md`
> Research: `context/changes/plan-three-day-grid/research.md`

## What & Why

A household fills 3 consecutive days × 5 meals with any library recipe, marks each meal (or a whole day) for A, B or both, leaves slots empty, and saves and re-opens the plan without solving (US-01, FR-013–FR-016, FR-020). This is the next step on Stream B toward the first solved day (S-04). The plan shape must already allow S-08 (one dish across several days) without rework.

## Starting Point

Nothing plan-related exists. The building blocks are present:
- the `meal_type` enum (already in grid order);
- the public read-only `recipes` library with suggested `meal_types`;
- `private.user_household_ids()`;
- the write-revoked-table + definer-RPC + KD SQLSTATE pattern from S-01;
- isolation-test catch-alls that pick up new household tables automatically.

## Desired End State

`/plan` shows a dated 3×5 grid. Each slot has a recipe picker (Suggested first, Other after, never hidden) and an eater picker (Both / Me / Partner once linked), and each day has a "whole day for" shortcut. Saving is atomic. Linked partners see and edit the same plan, and the dashboard shows `Plan: from <date> · N of 15 meals`. The isolation test and smoke run prove all of it.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Data shape | `meal_plans` → `plan_dishes` (recipe) ← `plan_meals` (slot, eater), `unique (dish_id)` for now | S-08 just drops one constraint; no data migration or rework of S-04's output | Research |
| Write path | One definer RPC `save_meal_plan(start_date, meals jsonb)`, client writes revoked | Atomic three-table save, plus eater membership checks that no policy may do | Research |
| Eater storage | `eater_user_id` (null = both), plain FK to `auth.users` | A/B letters are presentation only; null covers a partner who links later | Research (S-02 hand-off) |
| Membership FK | **Not** added on plan rows | It would cascade on redemption and break it with 23503; plans stay behind | Research |
| Save semantics | Slot-level diff; unchanged slots keep ids | Lets S-04 keep solve results for untouched days | Research |
| Error codes | KD010 malformed, KD011 unknown recipe, KD012 eater not in household; KD007 reused | Distinct SQLSTATE per reason, per the hard rule | Research |
| Whole-day marking | Save-time shortcut, not stored | One source of truth for the solver | Research (A2) |
| Payload parsing | Read as text, validate, then cast; KD010 catch only around parsing | A bare cast would surface 22P02 or swallow KD011/KD012 | Plan |
| Default start date | `?start=`, else latest plan, else tomorrow in Europe/Warsaw | Predictable re-open without a plan-history UI | Plan (A5) |
| UI | Astro-only form, native selects, no island | No client state needed (project convention) | Research |
| S-05 coordination | Every shared-file edit is its own S-03 block; `PROTECTED_ROUTES` one per line | S-05 rebases onto adjacent hunks only | Research |

## Scope

**In scope:** migration (3 tables, RLS, revokes incl. MAINTAIN, RPC); isolation-test extension; `listRecipes()`; types; `meal-plans.ts` service; `/plan` page; `POST /api/plan`; middleware; dashboard line; smoke steps; CLAUDE.md / README additions.

**Out of scope:** recipe browse or filters (S-05/S-06); solving (S-04); shared dishes (S-08); plan history or delete; `/join` warning about left-behind plans; the MAINTAIN gap on older tables; roadmap status (archive step).

## Architecture / Approach

Browser form → `POST /api/plan` (zod, maps me/partner to user ids, applies day overrides) → `meal-plans.ts` → `rpc("save_meal_plan")`. The RPC resolves the household, validates the payload, upserts the plan with a row lock, and diffs slots. Reads go through RLS-scoped PostgREST embeds (`meal_plans → plan_meals → plan_dishes`, using named FKs to avoid embed ambiguity).

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Database | Tables, policies, revokes, RPC, isolation test, pushed to cloud | Migration timestamp collision with S-05; payload-parsing SQLSTATE leaks |
| 2. App layer | Types, `listRecipes`, plan service, `/plan`, `/api/plan`, middleware, dashboard | PostgREST embed ambiguity (PGRST201) |
| 3. Smoke + docs | End-to-end smoke for one user and for linked partners; CLAUDE.md / README | Merge conflicts on shared lines with S-05 |

**Prerequisites:** F-01, F-04 and S-01 deployed (they are). CLI linked to `tvmfkhnxxsnmvogplknz`.
**Estimated effort:** ~2–3 sessions across 3 phases.

## Open Risks & Assumptions

- A1: a dish belongs to one plan. A3: deleting a partner's account drops meals marked only for them. A4: no delete-plan path. A10: last writer wins on concurrent saves.
- A rejected save does not preserve form input. This is only reachable by tampering or races, since the UI never offers rejected inputs.
- The `listRecipes()` option list is rendered 15 times. That is fine at 8 recipes and needs revisiting once S-07 grows the library.
- S-05 may push a migration first, so re-check `migration list --linked` before `db push`.

## Success Criteria (Summary)

- A user can build, save, re-open and clear a 3-day plan with per-meal and per-day eaters, and any recipe fits any slot.
- Linked partners share one plan, and redemption still succeeds with the redeemer's old plans left behind.
- `npm run test:rls` and `npm run smoke` pass against the hosted project.
