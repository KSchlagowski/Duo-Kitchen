# Step-by-Step Cook Mode (S-11) — Plan Brief

> Full plan: `context/changes/step-by-step-cook-mode/plan.md`
> Research: `context/changes/step-by-step-cook-mode/research.md`

## What & Why

Roadmap S-11 (US-03, FR-023): a household member opens one scheduled cooking session and follows it **one step at a time**. Each step shows the amounts it uses, and each finished dish shows **how much goes to You and to Partner**. S-10 gave the order of the steps and S-04/S-08 gave the solved amounts, but nothing joins the two yet. Without that join the user cooks from the order alone and has to divide portions by guesswork.

## Starting Point

- S-10's pure `buildCookingSessions()` and the `/plan/sessions` page list each session's merged steps, with no amounts.
- The stored day solves (`plan_day_solutions`) hold rounded batch amounts and per-person splits. They are read through `getPlanSolveState()`, the single currency rule.
- Steps carry a component *name* but not its id, so a step cannot yet be matched to the solve's components.

## Desired End State

- Every session on `/plan/sessions` links to `/plan/sessions/cook?start=…&session=…`.
- The cook page shows:
  - a step card (`Step 2 of 12`, the instruction, the amounts for that step's component);
  - on a dish's last step, the portion lines (`You: … · Partner: … · You (Tuesday): …`);
  - Previous / Next, the list of all steps, and an ingredients-and-portions overview;
  - serving notes for later meals of a shared batch.
- Unsolved or out-of-date days show recipe base amounts marked as an estimate, with no portions and a link to solve.
- Navigation works without JavaScript. With it, steps switch in place, done ticks persist per device, and "Keep screen on" appears where the browser supports it.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Progress storage | Client-only (URL `step` + `localStorage` ticks) | FR-023 needs no shared progress, and a server version would bring the full S-09 table/RPC/KD/RLS stack | Research (A), Plan |
| Route | `/plan/sessions/cook?start&session[&step]`, both required; bad values 404, a step past the end clamps | Matches the other plan pages, and a plan edit cannot strand a phone on a 404 mid-cook | Research (A), Plan |
| Currency | Per section, via `getPlanSolveState()`; any stored status counts as exact | `/plan`, the shopping list and cook mode can never disagree | Research |
| Not-current days | Base amounts marked as an estimate, no portions, link to solve | The plan stays usable unsolved, and placeholders are clearly labelled | Research (A) |
| Stored-row lookup | By the lead meal's or note meal's `mealId`, one row per dish | `perPerson` is per meal, and batch amounts are equal on every row, so nothing is summed | Plan |
| Step ↔ amounts | Add `componentId` to steps; portions on each dish's last step in a section | The amounts for the step in hand are the point of a step mode; there is no step-type schema | Research (A), Plan |
| Merged same-recipe entries | Per-batch amount and portion blocks, steps listed once | Overrides research (a): a summed list would be a new derived quantity and make percent splits ambiguous | Plan |
| Island safety | Move split-line formatters to a pure `split-lines.ts` (re-exported) | The island must not pull zod, Supabase or the solver into the browser | Research, Plan |
| Wake lock | Opt-in, feature-detected toggle | Useful in the kitchen, but not required and not available everywhere | Plan |
| Smoke | Exact portions in the solved-shared window, the estimate in the stale window | Uses the existing `2031-01-20` states, with no extra solve | Research |

## Scope

**In scope:**
- `componentId` on steps
- the `split-lines.ts` move
- the pure `cook-mode.ts` builder with vitest
- `getCookMode()` I/O
- the `/plan/sessions/cook` page and the links to it from `/plan/sessions`
- the `CookMode` island with its progress and wake-lock hooks
- smoke and docs

**Out of scope:**
- shared or server-side progress
- timers or clock times
- amounts inside the instruction text
- library schema changes (a serve or reheat timing)
- solving from the cook page
- any change to the S-10 schedule rules
- offline use

## Architecture / Approach

`cook.astro` → `getCookMode()` (`cooking.ts`) reads the plan once, then runs `getRecipeSteps()` and `getPlanSolveState()` in parallel. It builds the S-10 schedule, picks the session and calls the pure `buildCookMode()`. That returns a display-ready, viewer-relative `CookModeView`: numbered steps with per-batch amounts and portions, a source per section, an overview and serving notes. The page renders it as plain Astro. Phase 3 swaps the step card, navigation and step list for a `client:idle` island with identical markup.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Groundwork + pure engine | `componentId`, `split-lines.ts`, types, labels, `buildCookMode()`, unit tests | The module move silently changes day-page split text (guarded by the existing tests) |
| 2. Server-rendered cook page | I/O, `/plan/sessions/cook` with `?step` navigation, links from the sessions page | Validation and clamping edge cases; viewer-relative strings |
| 3. Focus-mode island | In-place stepping, done ticks, wake lock | Hydration mismatch from reading `localStorage`; history and Back behaviour |
| 4. Smoke + docs | End-to-end HTTP coverage and the CLAUDE.md / README entries | Smoke steps placed outside the solved-shared window |

**Prerequisites:**
- S-10 and S-04/S-08 are merged (they are).
- Two linked accounts with targets set, for manual checks.
- The hosted Supabase project is linked, for smoke.

**Estimated effort:** about 3–4 sessions across 4 phases. No migration.

## Open Risks & Assumptions

- Client-only progress assumes one person drives a session. If partners cook together on two phones, they will not see each other's ticks.
- "Portions on the last step of a dish in a section" is a structural heuristic. A future recipe whose real portioning step is not last would show the portions one step late.
- The wake lock depends on the browser. Older iOS versions or installed-PWA quirks may hide the toggle, and nothing else depends on it.
- The smoke test asserts portion structure and partner symmetry, not exact grams; `npm test` pins the numbers.

## Success Criteria (Summary)

- On a solved plan, a user can walk any session step by step on a phone and always sees the amounts for the step in hand and the You / Partner split when a dish is done.
- A shared batch is cooked and portioned once, and its later meal shows only its own portions.
- Unsolved or out-of-date days never block cooking: they show clearly labelled estimates and a way to solve.
