# App concept: meal planning and meal prep

This document describes the idea and the decisions made so far. It is the starting point for Claude Code when building the app.

---

## 1. Goal

An app for two people who cook together. It:
- helps decide what to eat,
- automatically recalculates portions to match each person's macros,
- generates shopping lists,
- builds a cooking schedule (meal prep) and guides through cooking step by step.

Core idea: cook in bulk in the morning and evening; during the day, only reheat in the microwave or eat straight from the container.

---

## 2. Technology

- **PWA**: runs in the browser on a computer, installable on Android and iOS.
- **Frontend**: Astro (JavaScript).
- **Backend / database / auth**: Supabase.
- **Hosting**: Vercel.
- **AI**: accessed through OpenRouter, used only where strictly necessary.
  - Macro recalculation and the cooking schedule are deterministic, with no LLM.
  - Goal: low running costs and predictable results.
- **Claude integration**: via an MCP connector, so the user can talk to an agent that imports recipes into the app (details in section 12).
- The code is built by Claude Code.

---

## 3. Interface

- Bilingual UI, **Polish and English**, with a switch in settings. From the first version.
- **Light and dark** mode, with a switch. From the first version.
- Recipe content is in Polish only (English version is planned for later).
- Instructions or onboarding for new users, explaining the basic flow:
  1. account,
  2. linking with a partner,
  3. macro goals,
  4. choosing meals,
  5. recalculating macros,
  6. shopping,
  7. cooking.

---

## 4. Users and accounts

- Each person creates their own account.
- Two accounts can be **linked** into a shared household. Linked accounts see the same recipes, plans and shopping lists.
- Each user manually enters their **daily goals**: calories, protein, fat, carbohydrates.
  - There is no requirement calculator (BMR, TDEE, etc.).
- At launch the app serves a single couple. Supporting other couples may come later, but the architecture doesn't need to force a solution for it now.

---

## 5. Meal planning

- A plan covers **the next 3 days, 5 meals per day** (usually 15 meals).
- The short 3-day cycle is deliberate: food doesn't have time to spoil. The app does not track food shelf life or expiry dates.
- Both people eat **the same dishes**, in different amounts.
- For each meal or a whole day, the user chooses who they cook for: **user A only, user B only, or both**.
- Fewer meals can be planned, e.g. when eating out is expected.
- One cooked dish can cover meals across several days (e.g. lunch for 2–3 days).

### Meal types
- Types: breakfast, second breakfast, lunch, afternoon snack, dinner.
- Each recipe has **0 to 2** suggested types, e.g. protein cookie: second breakfast or afternoon snack; shrimp: lunch or dinner.
- The type is only a hint and a filter. The user can place any recipe anywhere in the plan.

---

## 6. Macro recalculation (solver)

### How it works
- Calculation is **deterministic**, using **linear programming** (LP), with no AI.
- One large batch is cooked and the solver splits it between the two people.
- The solver determines:
  - how much of each ingredient or component to cook,
  - how to split it between user A and user B.
- Splitting can happen at the level of:
  - **components** (e.g. A gets 60% of the rice and 70% of the sauce),
  - **the whole dish**, when components can't be separated.
  - The recipe defines which option is possible.
- The optimization target is each person's **daily goals**, i.e. the sum of all meals in a given day. Individual meals don't need to hit the macros.

### Tolerance
- Default **±10%** for each macro: calories, protein, fat, carbohydrates.

### When and how it runs
- When the user fills a day with 5 meals, a popup suggests recalculating, with a **"Recalculate macros"** button. The user decides whether to recalculate. The button is also available manually.
- If the solver finds no solution within ±10%, the app shows a popup suggesting recalculation with **±15%** tolerance.
- If there's still no solution, the next suggestion is **±20%**.
- If there's still no solution, the app shows an **error message** identifying which recipe interferes most with the fit (e.g. it has too much fat relative to the goals).
- The app **never blocks** the user. A plan can always be saved and used without recalculation.

### Solver constraints
- **Minimum sensible amount** of an ingredient or dish (e.g. fried eggs require at least 1 egg).
- Ingredients counted in **pieces** are split into whole pieces (or halves, if the recipe allows it).

### Rounding results
- Results must be practical to weigh: "add 150 g", not "add 147.5 g".
- Each ingredient has its own **rounding step**:
  - bulk goods, meat, vegetables, etc.: e.g. every 10 g,
  - baking powder, salt, spices, yeast, etc.: exact, every 1 g (6 g must not become 10 g),
  - pieces: whole pieces or halves.
- Weighing can happen **before and/or after** cooking. The recipe must know the raw weight and the cooked weight where it matters (e.g. rice, pasta).
- When something is split in half, the app can say "split in half" without a gram amount.

---

## 7. Spice blends and broth

### Spice blends
- A separate section in the UI with **blend recipes** (e.g. chicken seasoning), prepared by the user every so often.
- For a recipe, the user chooses: **the original individual spices** or **one of the blends**.
- Blends **have no macros** and the app **does not track their stock**.
- On the shopping list, a blend appears as a **main item with sub-items**, which are its ingredients. This lets the user buy the ingredients if they want to make more.

### Broth
- For a recipe, the user chooses: **bouillon cube broth** or **homemade broth**.
- This is only an option. Homemade broth is not a separate recipe and does not enter the schedule.

---

## 8. Cooking schedule (meal prep)

- Cooking happens **in the morning and evening**. During the day, only reheating or eating from the container.
- The app builds **cooking sessions** on its own, combining steps from multiple recipes, e.g. "Monday evening: cook rice, sauce and eggs for Tuesday".
- Scheduling rules:
  - whatever possible is cooked **in the evening** (ahead of time),
  - **in the morning**, only what must be fresh (e.g. scrambled eggs).
- The logic is deterministic. An LLM only if it turns out to be essential.
- **Step-by-step cooking mode**: shows the session's steps one by one, with portions calculated for A and B.

---

## 9. Shopping list

- Generated automatically from the plan, with amounts for both people.
- Products are **grouped by store section**.
- The list shows everything. The user crosses off what they already have at home. No pantry tracking.
- Spice blends: main item with sub-items (see section 7).
- **Works offline**: checking off products without a connection. This is the only feature that must work offline.

### Syncing between users
- The list has a **"Sync"** button.
- When user A presses it, their list receives the check-offs made by user B (and vice versa).
- Sync applies **only to checking**, never to unchecking. Assumption: while shopping, products only go into the cart; nobody takes them out.
- Sync does not need to be real-time.

---

## 10. Recipes

### Display
- A recipe card shows:
  - photo,
  - name,
  - cuisine type (e.g. Polish),
  - both users' ratings: thumbs up or down. Each user sees their own rating and their partner's.

### Filtering and sorting
- Filters:
  - cuisine type,
  - meal type,
  - preparation time (in ranges),
  - minimum sensible calorie amount (e.g. at least 1 egg for fried eggs).
- By default, recipes with a **thumbs down from either person** go to the end of the list.

### Recipe contents
- Ingredient list with amounts, macros and rounding step.
- Preparation steps, divided into those that can be done ahead (in the evening) and those that must be done fresh.
- Components that can be split separately (e.g. rice, sauce, meat), or a note that the dish can only be split as a whole.
- Raw and cooked weight where relevant.
- 0 to 2 suggested meal types.
- Cuisine type and preparation time.
- Optional: spices replaceable by a blend, use of broth.

### Seed data
- A few test recipes (generated or taken from the internet) together with test code and data.

---

## 11. Product database and macros

- The product database with nutritional values is **kept in the repository**.
- Products are added **manually or by Claude**.
- A recipe's macros are calculated from the products in the database.

---

## 12. Claude as a user (MCP connector)

Purpose: the user talks to an agent (Claude in Claude.ai), and the agent imports recipes into the app. The same agent can also edit recipes and build meal plans on command.

- Claude has access to the app via an MCP connector added in Claude.ai and acts as a separate user.
- It can:
  - **add recipes** from a photo and description,
  - **edit** existing recipes,
  - **build a meal plan**.
- Claude acts **only on the user's command**. It never does anything on its own.

### Recipe-adding flow
1. The user uploads a photo and a description.
2. Claude edits the text and splits the recipe into steps (if needed).
3. Claude talks with the user about what's missing, what to add, what to change and what to keep.
4. After the user approves, Claude saves the recipe to the database and it appears in the app.

### Order of product data sources (instruction for Claude)
1. Products entered manually by the user.
2. The product database in the repository.
3. The internet.
4. The model's own knowledge.

---

## 13. What we deliberately DO NOT do

- Calorie requirement calculators.
- Tracking pantry, stock, or spice blend supplies.
- Tracking food shelf life or expiry dates (the 3-day cycle solves this).
- Macros for spice blends.
- Blocking the user when macros don't fit.
- Claude acting on its own without a command.
- Syncing unchecks on the shopping list.

---

## 14. For later

- English versions of recipes.
- Dietary filters: vegetarian, vegan, gluten-free, allergens.
- Opening the app to other couples and users.
