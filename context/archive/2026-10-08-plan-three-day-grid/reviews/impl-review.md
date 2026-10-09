<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Plan a 3-Day Grid (S-03)

- **Plan**: context/changes/plan-three-day-grid/plan.md
- **Scope**: Full plan (Phases 1–3 of 3), branch `feat/plan-three-day-grid` vs `main`
- **Date**: 2026-10-08
- **Verdict**: NEEDS ATTENTION (before triage) — the one actionable finding is now FIXED
- **Findings**: 0 critical, 1 warning, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

### Evidence summary

- **Plan adherence**: every file named in Changes Required is in the diff, and nothing else is apart from the context docs. The migration matches the contract. That covers the named constraints, `plan_meals_dish_id_key` marked S-03-only, no membership FK (with a header WARNING), RLS with four policies per table, revokes including `maintain`, and the `save_meal_plan` definer with `search_path = ''`, the revoke/grant pair, text-first validation in its own KD010 sub-block, and the diff order of delete → eater update → insert → orphan-dish delete. The services, the API, the page, the middleware, the dashboard, the types, the smoke steps, CLAUDE.md and the README all match their contracts. The one deviation, a separate `S03_TEST_IDS` dump loop in `smoke.mjs`, is documented and justified in the Phase 3 notes.
- **Scope**: no library-table or `seed_integrity.sql` change. No browse or detail UI. No roadmap edit. Edits to shared files are additive S-03 blocks.
- **Automated checks (re-run by the reviewer)**: `npx supabase migration list --linked` shows `20261008170000` as the latest migration, local and remote in sync. `npm run test:rls` printed "all assertions passed (… and meal plans)". `npm run test:seed` passed. `npm run lint` passed. `npx astro check` reported 0 errors. `npm run build` succeeded. `npm run smoke` against the production preview printed "All smoke steps passed".

## Findings

### F1 — Changing the start date on the save form overwrites another date's plan

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/pages/plan.astro:116-127 (pre-fix)
- **Detail**: `start_date` was an editable `<input type="date">` inside the POST form, and it was the only way the UI offered to reach another date. A user viewing the 2031-01-06 plan who changed the field to 2031-01-09 to "open" that plan, then pressed Save, sent the 01-06 grid as the 01-09 plan. `save_meal_plan` upserts on `(household_id, start_date)`, so the stored 01-09 plan was silently replaced and its meal ids were lost. The day headers also kept showing the old dates, because the page has no client script. This is reachable through normal use, not just by tampering.
- **Fix A ⭐ Recommended**: Move date switching to its own `GET /plan?start=` form ("Plan starting … Open"), and carry the save form's date as a hidden `start_date` equal to the grid being shown.
  - Strength: The saved date is always the date the grid shows, so an accidental overwrite is impossible. Uses the `?start=` read path that already exists, needs no API or DB change, and the smoke contract is unchanged.
  - Tradeoff: There is no one-step "copy this grid to a new date". Creating a second plan is now Open (blank grid) → fill → Save. Manual step 2.9 still holds with that flow.
  - Confidence: HIGH — no API change; the full smoke run passes.
  - Blind spot: Not checked in a real browser; checked over HTTP only.
- **Fix B**: Keep the editable date, and reject in the API when the date differs from the loaded one and a plan already exists there.
  - Strength: Keeps copy-forward.
  - Tradeoff: Needs an extra read and a new error message, and the headers still show stale dates.
  - Confidence: MEDIUM.
  - Blind spot: Race between the read and the save.
- **Decision**: FIXED via Fix A. `plan.astro` gains a GET "Open" date form, and the save form carries a hidden `start_date`. Re-verified with lint, prettier, astro check, build and the full smoke run against the preview (all passed).

### F2 — Manual two-browser check (3.5) not performed

- **Severity**: 💬 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: context/changes/plan-three-day-grid/plan.md (Progress 3.5)
- **Detail**: Progress row 3.5 is still `[ ]`, and the Phase 3 notes say so honestly. Its HTTP equivalent passes in the smoke run: B edits, then A sees 3 meals with the partner meal shown as "me". The other manual rows (2.5–2.11) were scripted over HTTP rather than checked in a browser, which the Phase 2 notes also disclose. That is not rubber-stamping.
- **Fix**: A human opens two browsers, A and B linked, B edits a slot on `/plan`, and A reloads and sees the change.
- **Decision**: FIXED. Manual two-browser check performed by the user on 2026-10-09: the partner's edit was visible after a reload (plan.md Progress 3.5).
