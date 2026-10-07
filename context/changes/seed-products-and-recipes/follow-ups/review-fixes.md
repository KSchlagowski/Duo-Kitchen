# Review fixes — follow-ups

Deferred items from `reviews/impl-review.md` (2026-10-07).

- [ ] **F1**: run the hosted verification before merging. The order is `npx supabase link --project-ref <ref>` → `npx supabase db push` → `npm run test:rls` → `npm run test:seed` → backfill query (plan 2.5) → `npm run build && npm run preview` + `npm run smoke`. Then tick Progress 1.1–1.3, 1.5, 2.1, 2.2, 2.4–2.6 and 3.4, do the manual rows, and set `change.md` to `implemented`.
- [ ] **F2**: add `"Bash(npm run test:seed)"` and `"Bash(npx supabase db query --linked -f supabase/tests/seed_integrity.sql)"` to `.claude/settings.json` → `permissions.allow`. Both the implementation session and the review session were denied write permission to that file.
