---
project: "Duo Kitchen"
version: 1
status: draft
created: 2026-10-06
context_type: greenfield
product_type: web-app            # installable PWA (desktop browser, Android, iOS)
target_scale:
  users: small                   # one couple at launch
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 1
  hard_deadline: null
  after_hours_only: false        # day-job / full-time pace
---

# PRD — Duo Kitchen

## Vision & Problem Statement

Two people who cook together and eat the same dishes but have different daily macro targets (calories, protein, fat, carbs) currently plan ad hoc: what to eat, what to buy and in what order to prep are improvised each time, and one shared batch has to be split by hand between two different targets. They cook in bulk in the morning and evening, and during the day they only reheat or eat from a box.

Insight: one large batch can be split deterministically between two people so that each one's **daily** total (not each meal) lands on target. A short 3-day planning cycle removes the need to track spoilage or expiry dates. Macro calculation and the cooking schedule are deterministic and predictable. AI is used only where it is genuinely needed (the user talks to an AI agent that imports and edits recipes), which keeps running costs low.

## User & Persona

**Primary persona:** a couple (person A and person B) who cook together, each with their own manually set daily macro targets. They reach for the app when deciding what to eat over the next 3 days, when shopping, and during the evening/morning bulk-cooking sessions.

At launch the app serves one couple. Support for other couples is possible later, but the architecture does not need to solve it now.

### Secondary persona
**AI agent (an external chat agent the user talks to)** acts as a separate user, **only on explicit command**: it imports recipes from a photo and description, edits recipes, and builds meal plans.

## Success Criteria

### Primary
- The couple plans, shops for and cooks one complete 3-day cycle using only the app.
- On that real plan, the solver lands both people within ±10% of each daily macro target without manual math.

### Secondary
- Recipes imported through the AI agent (photo + description → dialogue → accepted recipe) show up in the app and can be planned without manual fixes.

### Guardrails
- The app never blocks the user: a plan can always be saved and used without solving, including when the solver fails.
- Quantities are practical to weigh: rounded to each ingredient's step (e.g. 10 g for bulk goods, exactly 1 g for salt/baking powder/spices/yeast, whole or half pieces). Small amounts are never rounded up into a different quantity (6 g must not become 10 g).
- The AI agent never acts without a user's command.

## User Stories

### US-01: Plan and solve a 3-day cycle for two
- **Given** two linked accounts, each with daily macro targets, and a recipe library
- **When** a user fills a day with 5 meals (each marked for A, B or both) and accepts the "Przelicz makro" prompt
- **Then** each meal shows per-ingredient (or per-component / whole-dish) quantities to cook and how to split them between A and B, so that each person's daily totals are within ±10%

#### Acceptance Criteria
- If no solution exists at ±10%, the app offers ±15%, then ±20%. After that it shows an error naming the recipe that most prevents a fit (e.g. too much fat relative to targets).
- The plan stays saveable and usable at every step, whether or not it has been solved.
- Quantities respect each ingredient's rounding step, its minimum sensible amount, and whole/half-piece rules.
- One cooked dish can cover meals across several days.

### US-02: Shop from the plan
- **Given** a solved (or unsolved) 3-day plan
- **When** a user opens the shopping list
- **Then** they see every product with combined quantities for both people, grouped by store aisle, and can check off what they already have or have put in the basket

### US-03: Cook a session step by step
- **Given** a plan for the next days
- **When** a user opens a scheduled cooking session (e.g. "Monday evening")
- **Then** they see the merged steps from several recipes for that session, with portions computed for A and B. Everything that can be cooked ahead is scheduled for the evening, and the morning holds only what must be fresh.

### US-04: Import a recipe by talking to the AI agent
- **Given** a user chatting with the AI agent, which is connected to their household
- **When** they share a photo and a description of a dish
- **Then** the agent drafts the recipe, splits it into steps, discusses gaps and changes with the user, and saves it only after the user accepts. The recipe then appears in the app.

## Functional Requirements

### Accounts & household
- FR-001: Person can create an account and sign in with email + password. Priority: must-have
- FR-002: Person can generate an invite code/link that their partner redeems to link both accounts into one household. Priority: must-have
  > Socrates: For a single couple, linking the two accounts by hand once (no invite flow) was the cheaper option. Resolution: invite code/link chosen (user decision).
- FR-003: Linked persons can see the same recipes, plans and shopping lists. Priority: must-have
- FR-004: Person can manually enter their daily targets for calories, protein, fat and carbs. Priority: must-have
  > Socrates: Rationale from the concept doc: no BMR/TDEE calculator; manual entry is deliberate.

### Recipes
- FR-005: Person can browse recipe cards showing photo, name, cuisine and both partners' thumbs up/down. Priority: must-have
- FR-006: Person can rate a recipe thumbs up/down and see their partner's rating. Priority: must-have
- FR-007: Person can filter recipes by cuisine, meal type, prep-time bucket and minimum sensible calories. Priority: must-have
- FR-008: Recipes rated thumbs-down by either person are sorted to the end of the list by default. Priority: must-have
- FR-009: Person can view a recipe's ingredients (with quantities, macros and rounding step), its steps split into make-ahead and fresh, its divisible components (or a whole-dish-only flag), raw and cooked weights where relevant, 0–2 suggested meal types, cuisine and prep time. Priority: must-have
- FR-010: Recipe macros are computed from products in the product database. Priority: must-have
- FR-011: Person or the AI agent can extend the product database (nutrition values). Priority: must-have
- FR-012: The app ships with a few seeded test recipes together with test data. Priority: must-have

### Meal planning
- FR-013: Person can build a plan of 3 consecutive days × up to 5 meals (breakfast, second breakfast, lunch, afternoon snack, dinner). Priority: must-have
  > Socrates: Rationale from the concept doc: the 3-day cycle is deliberate. Food does not spoil, so expiry tracking is not needed.
- FR-014: Person can mark each meal or a whole day as for A only, B only, or both. Priority: must-have
- FR-015: Person can plan fewer meals than the full grid (e.g. when eating out). Priority: must-have
- FR-016: Person can place any recipe in any slot; suggested meal types act only as a hint and filter. Priority: must-have
- FR-017: Person can make one cooked dish cover meals across several days. Priority: must-have

### Macro solver
- FR-018: When a day has 5 meals, the app prompts the user to solve macros; solving is also available manually at any time. Priority: must-have
- FR-019: The solver escalates tolerance ±10% → ±15% → ±20% on user confirmation, then reports the recipe that most hinders a fit. Priority: must-have
- FR-020: Person can always save and use a plan without solving. Priority: must-have

### Shopping list
- FR-021: Person can see a shopping list generated from the plan with quantities for both people, grouped by store aisle, and check items off (online). Priority: must-have
  > Socrates: Offline check-off and the A↔B Sync button are moved out of the MVP (user decision). They are the doc's only offline requirement, so they come back in v2.

### Meal-prep schedule & cooking
- FR-022: The app automatically arranges cooking sessions (morning/evening) by merging steps from several recipes. Everything possible goes to the evening; the morning holds only what must be fresh. Priority: must-have
- FR-023: Person can follow a session in a step-by-step cooking mode, with portions computed for A and B. Priority: must-have

### AI agent (recipe import through conversation)
- FR-024: The AI agent, acting as a separate user on explicit command, can add a recipe from a photo and description through a dialogue, and save it only after user acceptance. Priority: must-have
- FR-025: The AI agent can edit existing recipes and build meal plans on command. Priority: must-have
  > Socrates: Data source precedence for product nutrition (instruction for the agent): user-entered products → the app's product database → internet → the agent's own knowledge.

### Interface
- FR-026: Person can switch the UI between Polish and English (recipe content stays Polish only). Priority: must-have
- FR-027: Person can switch between light and dark mode. Priority: must-have

### Deferred (nice-to-have, post-MVP)
- Offline shopping-list check-off + "Synchronizuj" button (check-only sync, never uncheck, not live).
- Onboarding guide (account → link partner → macro targets → choose meals → solve → shop → cook).
- Spice blends section (blend recipes, blend vs. single spices per recipe, blend shown on the shopping list as a parent item with its ingredients as sub-items; no macros, no stock tracking).
- Broth option per recipe (cube vs. homemade; homemade is not a separate recipe and is not scheduled).

## Non-Functional Requirements
- The app is installable and usable on a desktop browser, Android and iOS.
- The same plan and targets always produce the same solver and schedule output (deterministic and reproducible).
- Macro calculation and scheduling incur no per-use paid AI cost. Paid AI usage is limited to agent-driven recipe and plan work.
- Every displayed quantity is weighable in practice: it follows the ingredient's rounding step, and a halved item may be shown as "podziel na pół" without a gram amount.
- Each household's data is visible only to that household's linked accounts and to the AI agent acting on their command.

## Business Logic

The app splits one cooked batch of each planned dish between two people, choosing how much of each ingredient or component to cook and how to divide it, so that each person's **daily** totals of calories, protein, fat and carbs fall within a tolerance of their own targets (default ±10%).

Inputs: each person's daily targets; the 3-day plan (which recipes go in which slots, and for whom: A, B or both); each recipe's ingredients with macros, rounding steps, minimum sensible amounts, piece/half-piece rules, raw vs. cooked weights, and whether it divides per component or only as a whole dish. Individual meals do not need to hit macros; only the daily sum does. If the default tolerance cannot be met, the user is offered ±15%, then ±20%, and finally an explanation naming the most obstructive recipe. The user is never blocked.

A second rule orders the cooking: steps from all planned recipes are merged into evening and morning sessions. Anything that can be made ahead goes to the evening before, and only what must be fresh goes to the morning. The user encounters it as the session list and the step-by-step cook mode with A/B portions.

## Access Control
- One account per person; sign-up and sign-in with email + password.
- Two accounts link into one household via an invite code/link. Linked accounts share recipes, plans and shopping lists; each person keeps their own macro targets and ratings (visible to the partner).
- Flat role model inside a household (no admin/member split).
- The AI agent connects as a separate user with access to the household's recipes and plans. It acts only on a user's explicit command.
- Unauthenticated users can reach only sign-in / sign-up / invite redemption.

## Non-Goals
- No calorie-need calculators (BMR, TDEE, etc.). Targets are entered manually.
- No pantry, stock or spice-blend inventory tracking. The user crosses off what they have.
- No food shelf-life or expiry tracking. The 3-day cycle covers this.
- No macros for spice blends.
- No blocking the user when macros don't fit.
- No autonomous AI-agent actions without a user's command.
- No syncing of un-checks on the shopping list.
- Not in MVP: offline shopping list and Sync, onboarding guide, spice blends, broth option (deferred to v2).
- Later, not now: English recipe content; dietary filters (vegetarian, vegan, gluten-free, allergens); opening the app to other couples and users.

## Open Questions
1. **How is the AI agent authenticated and bound to a household?** Owner: user. Resolve during planning.
2. **Store-aisle taxonomy:** which aisles exist, and who assigns a product to an aisle (the product database, or the AI agent)? Owner: user.
3. **What prep-time buckets does the filter use?** Owner: user.
4. **Seed recipes:** generated or taken from the internet, and how many? Owner: user. Must be resolved before the solver can be tested.
