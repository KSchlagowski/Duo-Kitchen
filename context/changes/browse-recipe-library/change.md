---
change_id: browse-recipe-library
title: Browse the shared recipe library (S-05) with recipe cards and detail view
status: plan_reviewed
created: 2026-10-08
updated: 2026-10-08
archived_at: null
---

## Notes

S-05 (browse-recipe-library) from context/foundation/roadmap.md.

Coordination: S-03 (plan-three-day-grid) is being built at the same time in another worktree and merges to main FIRST. Rules for this chain:

- Do not create plan tables or touch any plan-related files — that's S-03.
- S-03 adds listRecipes() to src/lib/services/recipes.ts. Use distinct names for S-05's functions (e.g. getRecipeCards(), getRecipeDetail(id)) and put shared DTOs in src/types.ts under S-05-specific names. Dedupe with S-03's function when rebasing.
- Ratings belong to S-06: do NOT create a ratings table. Leave a slot for ratings on the card but don't display or store any ratings.
- recipes has no photo column. If you add one (nullable), follow the "Public library tables" hard rule in CLAUDE.md: keep both the grant revokes and the select-only policy, update the library assertions in supabase/tests/household_isolation.sql, and update supabase/tests/seed_integrity.sql if seed data or pinned counts change.
- In shared files (middleware PROTECTED_ROUTES, dashboard navigation, scripts/smoke.mjs, README route table, CLAUDE.md, roadmap) add only S-05's own lines in separate blocks. Never change S-03's roadmap status.
- Before npx supabase db push, check that the migration timestamp is later than every migration already applied to the cloud project (S-03 may have pushed first); if not, rename it. Then run npm run test:rls and npm run test:seed.
- Don't merge to main until S-03 is on main. Then rebase onto main, resolve the shared-file conflicts, and rerun lint, astro check, build, npm run test:rls, npm run test:seed and npm run smoke before merging.
