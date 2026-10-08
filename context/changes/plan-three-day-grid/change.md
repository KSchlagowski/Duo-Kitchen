---
change_id: plan-three-day-grid
title: Household three-day meal plan grid with recipe picker (S-03)
status: impl_reviewed
created: 2026-10-08
updated: 2026-10-08
archived_at: null
---

## Notes

S-03 (plan-three-day-grid) from context/foundation/roadmap.md. Pick the best recommended options instead of asking.

Coordination: S-05 (browse-recipe-library) is being built at the same time in a separate worktree. S-03 merges to main first. Rules for this chain:
- S-03 owns the recipe list query: add listRecipes() to src/lib/services/recipes.ts (id, name, cuisine, prep_minutes, meal_types — the minimum the picker needs) with its type in src/types.ts. Keep it small; S-05 will build on it after rebasing.
- Do not change the library tables (products, recipes, recipe_components, recipe_ingredients, recipe_steps) or supabase/tests/seed_integrity.sql. No recipe browsing/detail UI — that's S-05.
- The plan tables are household-scoped and must follow the CLAUDE.md hard rules, including extending supabase/tests/household_isolation.sql. The plan shape must allow S-08 (one dish across several days) without rework.
- In shared files (middleware PROTECTED_ROUTES, dashboard navigation, scripts/smoke.mjs, README route table, CLAUDE.md, roadmap) add only S-03's own lines in separate blocks, so the merge with S-05 stays trivial.
- Before npx supabase db push, check that the migration timestamp is later than every migration already applied to the cloud project; if not, rename it. Then run npm run test:rls.
