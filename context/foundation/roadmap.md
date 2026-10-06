---
project: "Duo Kitchen"
version: 1
status: draft
created: 2026-10-06
updated: 2026-10-06
prd_version: 1
main_goal: market-feedback
top_blocker: time
---

# Roadmap: Duo Kitchen

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

A couple who cook together in bulk, but have different daily macro targets, improvise every time what to eat, what to buy and how to split one shared batch between two targets. Duo Kitchen plans a 3-day cycle and deterministically splits each cooked batch so that each person's **daily** totals land within ±10% of their own targets, then derives the shopping list and the evening/morning cooking sessions. AI is used only by an external chat agent that imports and edits recipes on the user's explicit command.

## North star

**S-04: User can solve a planned day so both A and B land within ±10% of their daily macro targets** — this is what the build order optimizes for: the primary Success Criterion is that the solver works on a real plan, so a real solved day should reach the couple's kitchen before anything else is polished.

> "North star" here means the smallest end-to-end slice whose successful delivery proves the product works — placed as early as its Prerequisites allow, because shopping, cooking and the agent only matter if the split works.

## At a glance

| ID   | Change ID                     | Outcome (user can …)                                                              | Prerequisites       | PRD refs                                   | Status   |
| ---- | ----------------------------- | --------------------------------------------------------------------------------- | ------------------- | ------------------------------------------ | -------- |
| F-01 | household-data-scope          | (foundation) every account belongs to a household; data access is household-scoped | —                   | Access Control, NFR (household privacy)    | ready    |
| F-02 | seed-products-and-recipes     | (foundation) product database and 5–10 seed recipes with solver-relevant attributes exist | F-01          | FR-010, FR-012                             | proposed |
| F-03 | deploy-and-install-skeleton   | (foundation) merges to main auto-deploy; the app installs on desktop, Android, iOS | —                   | NFR (installable), FR-024 (public endpoint) | ready    |
| S-01 | link-partner-household        | invite their partner and share one household                                      | F-01                | US-01, FR-001, FR-002, FR-003              | proposed |
| S-02 | set-daily-macro-targets       | enter their own daily calorie/protein/fat/carb targets                            | F-01                | US-01, FR-004                              | proposed |
| S-03 | plan-three-day-grid           | fill a 3-day × 5-meal plan, marking each meal for A, B or both, and save it unsolved | F-01, F-02       | US-01, FR-013, FR-014, FR-015, FR-016, FR-020 | proposed |
| S-04 | solve-daily-macros            | solve a day and see per-ingredient quantities and the A/B split within tolerance  | S-01, S-02, S-03    | US-01, FR-018, FR-019, FR-020              | proposed |
| S-05 | browse-recipe-library         | browse recipe cards and open full recipe details                                  | F-02                | FR-005, FR-009, FR-010, FR-012             | proposed |
| S-06 | rate-and-filter-recipes       | rate recipes, see the partner's rating, and filter/sort the library               | S-05, S-01          | FR-006, FR-007, FR-008                     | proposed |
| S-07 | add-missing-product           | add a product with nutrition values and store aisle                               | F-02                | FR-010, FR-011                             | proposed |
| S-08 | shared-dish-across-days       | make one cooked dish cover meals on several days and still solve                  | S-04                | US-01, FR-017                              | proposed |
| S-09 | shopping-list-from-plan       | open a combined, aisle-grouped shopping list and check items off                  | S-03                | US-02, FR-021                              | proposed |
| S-10 | cooking-session-schedule      | see the plan arranged into evening/morning cooking sessions with merged steps     | S-03                | US-03, FR-022                              | proposed |
| S-11 | step-by-step-cook-mode        | follow a session step by step with A and B portions                               | S-10, S-04          | US-03, FR-023                              | proposed |
| S-12 | agent-recipe-import           | import a recipe by talking to the AI agent (photo + description → accepted recipe) | S-05, F-03         | US-04, FR-024, FR-011                      | proposed |
| S-13 | agent-edits-recipes-and-plans | ask the AI agent to edit a recipe or build a plan                                 | S-12, S-03          | US-04, FR-025                              | proposed |
| S-14 | language-and-theme-switch     | switch the UI between Polish and English and between light and dark mode          | —                   | FR-026, FR-027                             | ready    |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                 | Chain                                          | Note                                                                                   |
| ------ | --------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| A      | Household & people    | `F-01` → `S-01` / `S-02`                       | Supplies the two people and their targets; joins Stream B at `S-04`.                   |
| B      | Plan & solve          | `F-02` → `S-03` → `S-04` → `S-08`              | The market-feedback path: shortest route to a real solved day.                          |
| C      | Recipe library & agent | `S-05` → `S-06` / `S-07` → `S-12` → `S-13`    | Hangs off `F-02`; runs in parallel with Stream B; `S-12` also needs `F-03`.             |
| D      | Shop & cook           | `S-09` / `S-10` → `S-11`                       | Branches off `S-03`; `S-11` joins Stream B at `S-04` for A/B portions.                  |
| E      | Ship & polish         | `F-03`, `S-14`                                 | Independent from day one; gets the solved day onto the couple's phones.                 |

## Baseline

What's already in place in the codebase as of `2026-10-06` (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — Astro 7 SSR with React 19 islands, Tailwind 4, shadcn/ui (`astro.config.mjs`, `src/components/ui/`). No PWA manifest, no i18n, no theme switch.
- **Backend / API:** partial — only auth endpoints (`src/pages/api/auth/{signin,signup,signout}.ts`); no domain API.
- **Data:** absent — Supabase client and `supabase/config.toml` exist, but there are no migrations, schema or seed data.
- **Auth:** present — email + password via Supabase SSR (`src/lib/supabase.ts`, `src/middleware.ts` `PROTECTED_ROUTES`). No household or invite concept.
- **Deploy / infra:** partial — `wrangler.jsonc` (worker still named after the starter) and CI with lint/build/smoke, but CI triggers on `master` while the repo uses `main`, and there is no auto-deploy step.
- **Observability:** partial — Cloudflare `observability.enabled` in `wrangler.jsonc` only; no error tracking.

## Foundations

### F-01: Household-scoped data access

- **Outcome:** (foundation) every signed-up person belongs to a household (initially of one), and a household-scoped access policy pattern is in place for all household data.
- **Change ID:** household-data-scope
- **PRD refs:** Access Control (linked accounts share data; flat roles), NFR "Each household's data is visible only to that household's linked accounts and to the AI agent acting on their command"
- **Unlocks:** S-01 (partner joins an existing household), S-02 (targets attach to a person in a household), S-03 (plans are household data); the privacy rule every later table reuses.
- **Prerequisites:** — (auth is present per Baseline)
- **Parallel with:** F-03, S-14
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Sequenced first because retrofitting household scoping onto existing tables is costly; scope is only the household concept and the access pattern, not domain tables — those arrive with the slices that use them.
- **Status:** ready

### F-02: Seed product database and test recipes

- **Outcome:** (foundation) a product database with nutrition values and store aisles, plus 5–10 generated seed recipes carrying the attributes the solver needs (rounding step, minimum sensible amount, whole/half-piece rule, raw vs. cooked weight, per-component vs. whole-dish division, make-ahead vs. fresh steps).
- **Change ID:** seed-products-and-recipes
- **PRD refs:** FR-010, FR-012, Business Logic (solver inputs)
- **Unlocks:** S-03 (recipes to place in slots), S-04 (fixtures without which the solver can't be verified), S-05, S-07
- **Prerequisites:** F-01
- **Parallel with:** F-03, S-14
- **Blockers:** —
- **Unknowns:**
  - Is the product database a repo-maintained seed shared by all households, a per-household table, or both (seed + household extensions)? Shape-notes say "kept in the repository", while FR-011 lets a person or the agent extend it. — Owner: user. Block: no.
- **Risk:** The solver is only as good as these attributes; capturing rounding and piece rules here (rather than in S-04) keeps the solver slice focused on the split itself. Scope stays to seed data and the minimum shape — no recipe UI.
- **Status:** proposed

### F-03: Deploy and install skeleton

- **Outcome:** (foundation) merging to `main` deploys the app to production with a production Supabase project, and the app installs to the home screen on desktop, Android and iOS.
- **Change ID:** deploy-and-install-skeleton
- **PRD refs:** NFR "installable and usable on a desktop browser, Android and iOS", FR-024 (the agent needs a publicly reachable endpoint)
- **Unlocks:** the verification path for S-04 (the couple trying a real solved day on their phones — the primary Success Criterion), S-12 (a hosted endpoint the external agent can reach)
- **Prerequisites:** —
- **Parallel with:** F-01, F-02, S-01–S-11, S-14
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Cheap to do early and essential to market-feedback — a solver only tested on localhost doesn't validate anything in the kitchen. Scope is fixing CI's branch, adding auto-deploy and installability; no offline support (parked).
- **Status:** ready

## Slices

### S-01: Link partner into one household

- **Outcome:** user can generate an invite code/link that their partner redeems, after which both see the same recipes, plans and shopping lists.
- **Change ID:** link-partner-household
- **PRD refs:** US-01, FR-001, FR-002, FR-003
- **Prerequisites:** F-01
- **Parallel with:** S-02, S-03, S-05, S-07, S-14, F-03
- **Blockers:** —
- **Unknowns:**
  - What happens to data a person created in their single-person household before redeeming an invite (merge vs. discard)? — Owner: user. Block: no.
- **Risk:** Needed before S-04 because the solver needs two people; sign-up/sign-in (FR-001) already exist, so this slice only adds invite and redemption.
- **Status:** proposed

### S-02: Set daily macro targets

- **Outcome:** user can manually enter their own daily calorie, protein, fat and carb targets and see their partner's.
- **Change ID:** set-daily-macro-targets
- **PRD refs:** US-01, FR-004
- **Prerequisites:** F-01
- **Parallel with:** S-01, S-03, S-05, S-07, S-14, F-03
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Small but on the critical path to S-04; deliberately no calculator (PRD §Non-Goals).
- **Status:** proposed

### S-03: Plan a 3-day grid

- **Outcome:** user can fill 3 consecutive days with up to 5 meals each, place any recipe in any slot, mark each meal or day for A, B or both, leave slots empty, and save and use the plan without solving.
- **Change ID:** plan-three-day-grid
- **PRD refs:** US-01, FR-013, FR-014, FR-015, FR-016, FR-020
- **Prerequisites:** F-01, F-02
- **Parallel with:** S-01, S-02, S-05, S-07, S-14, F-03
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Uses a minimal recipe picker over seed recipes so it doesn't wait on the full library (S-05); the plan shape must already allow later cross-day dishes (S-08) without rework.
- **Status:** proposed

### S-04: Solve a day's macros for A and B

- **Outcome:** user can solve a planned day (prompted when 5 meals are filled, or manually any time) and see per-ingredient / per-component / whole-dish quantities to cook and how to split them between A and B, with each person's daily totals within ±10%, escalating to ±15% and ±20% on confirmation and then naming the recipe that most hinders a fit.
- **Change ID:** solve-daily-macros
- **PRD refs:** US-01, FR-018, FR-019, FR-020
- **Prerequisites:** S-01, S-02, S-03
- **Parallel with:** S-05, S-06, S-07, S-09, S-10, S-12, S-14
- **Blockers:** —
- **Unknowns:**
  - Can a deterministic solver that respects rounding steps, minimum amounts and half-piece rules run within the edge runtime's CPU budget in pure JS or WASM? — Owner: team. Block: no.
  - How is "the recipe that most hinders a fit" determined so the explanation is stable and reproducible? — Owner: team. Block: no.
- **Risk:** This is the riskiest and most valuable slice, so it goes as early as its prerequisites allow; failure must never block saving the plan (FR-020), and output must be identical for identical input (NFR determinism).
- **Status:** proposed

### S-05: Browse the recipe library

- **Outcome:** user can browse recipe cards (photo, name, cuisine, both partners' ratings) and open a recipe's full details: ingredients with quantities, macros and rounding step, make-ahead vs. fresh steps, divisible components or whole-dish flag, raw/cooked weights, suggested meal types, cuisine and prep time.
- **Change ID:** browse-recipe-library
- **PRD refs:** FR-005, FR-009, FR-010, FR-012
- **Prerequisites:** F-02
- **Parallel with:** S-01, S-02, S-03, S-04, S-07, S-09, S-10, S-14
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Not on the path to the first solved day (S-03 uses a minimal picker), so it can run in a parallel agent session; it is where agent-imported recipes (S-12) become visible.
- **Status:** proposed

### S-06: Rate and filter recipes

- **Outcome:** user can rate a recipe thumbs up/down, see their partner's rating, filter by cuisine, meal type, prep-time bucket (≤ 20 / 20–45 / 45+ min) and minimum sensible calories, with thumbs-down recipes sorted last by default.
- **Change ID:** rate-and-filter-recipes
- **PRD refs:** FR-006, FR-007, FR-008
- **Prerequisites:** S-05, S-01
- **Parallel with:** S-04, S-07, S-08, S-09, S-10, S-11, S-12
- **Blockers:** —
- **Unknowns:**
  - How is "minimum sensible calories" for a recipe derived (smallest solvable portion vs. a stored value)? — Owner: user. Block: no.
- **Risk:** Pure convenience on top of the library; the first candidate to slip if time runs short (see Open Roadmap Questions).
- **Status:** proposed

### S-07: Add a missing product

- **Outcome:** user can add a product with nutrition values and a store aisle from the fixed list, and recipe macros using it are computed from those values.
- **Change ID:** add-missing-product
- **PRD refs:** FR-010, FR-011
- **Prerequisites:** F-02
- **Parallel with:** S-01–S-06, S-08–S-11, S-14
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Same write path the agent will use in S-12; doing it first for the person keeps the agent slice focused on the conversation.
- **Status:** proposed

### S-08: One dish across several days

- **Outcome:** user can make one cooked dish cover meals on several days, and solving still lands each person's daily totals within tolerance.
- **Change ID:** shared-dish-across-days
- **PRD refs:** US-01, FR-017
- **Prerequisites:** S-04
- **Parallel with:** S-05, S-06, S-07, S-09, S-10, S-12, S-13, S-14
- **Blockers:** —
- **Unknowns:**
  - Does a shared dish couple the days into one solve, or are days solved in order with the batch already fixed? — Owner: team. Block: no.
- **Risk:** Separated from S-04 so the north star proves the single-day split first; extending to cross-day batches changes the solver's scope, which is safer once the single-day case works.
- **Status:** proposed

### S-09: Shop from the plan

- **Outcome:** user can open a shopping list generated from the plan with combined quantities for both people, grouped by store aisle, and check off items online.
- **Change ID:** shopping-list-from-plan
- **PRD refs:** US-02, FR-021
- **Prerequisites:** S-03
- **Parallel with:** S-04, S-05, S-06, S-07, S-08, S-10, S-14
- **Blockers:** —
- **Unknowns:**
  - Which quantities feed the list for an unsolved plan (recipe base quantities?) and how does it update after solving? — Owner: user. Block: no.
- **Risk:** Works on unsolved plans, so it doesn't wait for the solver; it is needed for the full "plan, shop, cook one cycle" Success Criterion.
- **Status:** proposed

### S-10: Cooking-session schedule

- **Outcome:** user can see the plan arranged into evening and morning cooking sessions, with steps from several recipes merged, everything possible scheduled for the evening and only what must be fresh in the morning.
- **Change ID:** cooking-session-schedule
- **PRD refs:** US-03, FR-022
- **Prerequisites:** S-03
- **Parallel with:** S-04, S-05, S-06, S-07, S-08, S-09, S-14
- **Blockers:** —
- **Unknowns:**
  - How are merged steps ordered within a session (by recipe, by equipment, by duration)? — Owner: user. Block: no.
- **Risk:** Second deterministic engine after the solver; it depends only on the plan and step metadata, so it can be built in parallel with S-04.
- **Status:** proposed

### S-11: Step-by-step cook mode

- **Outcome:** user can open a scheduled session and follow it step by step, with portions computed for A and B.
- **Change ID:** step-by-step-cook-mode
- **PRD refs:** US-03, FR-023
- **Prerequisites:** S-10, S-04
- **Parallel with:** S-06, S-07, S-08, S-09, S-12, S-13, S-14
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Joins the schedule with solver output; placed after both so it shows real portions instead of placeholders.
- **Status:** proposed

### S-12: Import a recipe by talking to the AI agent

- **Outcome:** user can share a photo and a description with the external AI agent, which drafts the recipe, splits it into steps, discusses gaps, adds missing products, and saves it as "system" only after the user accepts — the recipe then appears in the app.
- **Change ID:** agent-recipe-import
- **PRD refs:** US-04, FR-024, FR-011
- **Prerequisites:** S-05, F-03
- **Parallel with:** S-04, S-06, S-07, S-08, S-09, S-10, S-11, S-14
- **Blockers:** —
- **Unknowns:**
  - Which authorization flow does the chat agent's connector support for a household member to grant access, and how is the "system" identity attributed? — Owner: team. Block: no.
- **Risk:** Hand-built connection to an external agent with an unfamiliar auth flow; the only paid-AI path, so it is kept out of the critical path to the first solved day.
- **Status:** proposed

### S-13: Agent edits recipes and builds plans

- **Outcome:** user can ask the AI agent to edit an existing recipe or build a meal plan, and the changes appear in the app attributed to "system".
- **Change ID:** agent-edits-recipes-and-plans
- **PRD refs:** US-04, FR-025
- **Prerequisites:** S-12, S-03
- **Parallel with:** S-08, S-09, S-10, S-11, S-14
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Reuses the connection from S-12; extends it to plan writes, which must leave plans saveable without solving (FR-020).
- **Status:** proposed

### S-14: Switch language and theme

- **Outcome:** user can switch the UI between Polish and English (recipe content stays Polish) and between light and dark mode.
- **Change ID:** language-and-theme-switch
- **PRD refs:** FR-026, FR-027
- **Prerequisites:** —
- **Parallel with:** F-01, F-02, F-03, S-01–S-13
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Independent of everything; doing it early avoids retrofitting UI strings across every later slice.
- **Status:** ready

## Backlog Handoff

| Roadmap ID | Change ID                     | Suggested issue title                                   | Ready for `/10x-plan` | Notes                                      |
| ---------- | ----------------------------- | ------------------------------------------------------- | --------------------- | ------------------------------------------ |
| F-01       | household-data-scope          | Household-scoped data access for all accounts           | yes                   | Run `/10x-plan household-data-scope`       |
| F-02       | seed-products-and-recipes     | Seed product database and 5–10 test recipes             | no                    | Waits on F-01                              |
| F-03       | deploy-and-install-skeleton   | Auto-deploy from main and make the app installable      | yes                   | Run `/10x-plan deploy-and-install-skeleton` |
| S-01       | link-partner-household        | Invite partner and link accounts into one household     | no                    | Waits on F-01                              |
| S-02       | set-daily-macro-targets       | Enter daily macro targets per person                    | no                    | Waits on F-01                              |
| S-03       | plan-three-day-grid           | Build and save a 3-day meal plan for A/B                | no                    | Waits on F-01, F-02                        |
| S-04       | solve-daily-macros            | Solve a day's macros and split quantities for A and B   | no                    | North star; waits on S-01, S-02, S-03      |
| S-05       | browse-recipe-library         | Browse recipe cards and view recipe details             | no                    | Waits on F-02                              |
| S-06       | rate-and-filter-recipes       | Rate, filter and sort recipes                           | no                    | Waits on S-05, S-01                        |
| S-07       | add-missing-product           | Add a product with nutrition and store aisle            | no                    | Waits on F-02                              |
| S-08       | shared-dish-across-days       | Cover meals on several days with one cooked dish        | no                    | Waits on S-04                              |
| S-09       | shopping-list-from-plan       | Aisle-grouped shopping list with check-off              | no                    | Waits on S-03                              |
| S-10       | cooking-session-schedule      | Arrange plan into evening/morning cooking sessions      | no                    | Waits on S-03                              |
| S-11       | step-by-step-cook-mode        | Step-by-step cook mode with A/B portions                | no                    | Waits on S-10, S-04                        |
| S-12       | agent-recipe-import           | Import recipes through the AI agent conversation        | no                    | Waits on S-05, F-03                        |
| S-13       | agent-edits-recipes-and-plans | Let the AI agent edit recipes and build plans           | no                    | Waits on S-12, S-03                        |
| S-14       | language-and-theme-switch     | PL/EN language switch and light/dark mode               | yes                   | Run `/10x-plan language-and-theme-switch`  |

## Open Roadmap Questions

1. **If the 1-week budget runs short, which must-haves may slip past the first real cycle?** Candidates by distance from the Success Criteria: S-06 (rating/filters), S-13 (agent edits and plans), S-14 (language/theme). — Owner: user. Block: roadmap-wide (sequencing only; no slice is blocked).
2. **Is the product database a shared repo-maintained seed, per-household data, or a seed plus household extensions?** — Owner: user. Block: F-02, S-07, S-12 (planning detail; not blocking).

(PRD `## Open Questions`: none open — all resolved on 2026-10-06.)

## Parked

- **BMR/TDEE calorie-need calculators** — Why parked: PRD §Non-Goals; targets are entered manually.
- **Pantry, stock and spice-blend inventory tracking** — Why parked: PRD §Non-Goals; the user crosses off what they have.
- **Shelf-life / expiry tracking** — Why parked: PRD §Non-Goals; the 3-day cycle covers this.
- **Macros for spice blends** — Why parked: PRD §Non-Goals.
- **Autonomous AI-agent actions without a user's command** — Why parked: PRD §Non-Goals and Guardrails.
- **Syncing un-checks on the shopping list** — Why parked: PRD §Non-Goals.
- **Offline shopping-list check-off + "Synchronizuj" button** — Why parked: PRD §Deferred (v2).
- **Onboarding guide** — Why parked: PRD §Deferred (v2).
- **Spice blends section** — Why parked: PRD §Deferred (v2).
- **Broth option per recipe (cube vs. homemade)** — Why parked: PRD §Deferred (v2).
- **English recipe content, dietary filters, opening the app to other couples** — Why parked: PRD §Non-Goals ("later, not now").
- **Error tracking beyond Cloudflare's built-in observability** — Why parked: not required by any PRD NFR; time is the top blocker.

## Done

(Empty on first generation. `/10x-archive` appends entries here.)
