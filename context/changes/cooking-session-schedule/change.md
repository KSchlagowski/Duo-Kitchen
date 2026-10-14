---
change_id: cooking-session-schedule
title: Arrange the plan into evening/morning cooking sessions with merged steps
status: impl_reviewed
created: 2026-10-13
updated: 2026-10-14
archived_at: 2026-10-14T09:12:41Z
---

## Notes

Roadmap item S-10 from context/foundation/roadmap.md: see the plan arranged into evening/morning cooking sessions with merged steps (PRD refs US-03, FR-022, prerequisite S-03). Build on top of S-09 (shopping list, context/changes/shopping-list-from-plan/), which is on the base branch but not yet merged to main. Respect the CLAUDE.md S-08 rule: downstream consumers must deduplicate a shared batch by meals[].batch.dishId and never re-derive quantities. Where a decision would normally go to the user (e.g. the roadmap open question on how merged steps are ordered within a session), pick the recommended option and note it.

### Decisions taken without the user (non-interactive session)

- **Ordering of merged steps within a session** (roadmap S-10 unknown, owner: user): pick the recommended option, **by duration** — each recipe's own step order is preserved as a hard constraint, and across recipes the step with the longest remaining chain (longest-first, so long-running/passive steps start early and overlap) goes first; ties are broken deterministically by recipe, then step position. Not by equipment: the library has no equipment metadata. To be confirmed or revised by `/10x-plan` once it has looked at the step timing columns in the seed.
- **Dedup**: a dish shared across days (S-08) is cooked once, in the session before its `batch.cookDayIndex`, deduplicated by the plan's `dishId`; amounts, if shown, come from the stored solve and are never re-derived (portions per A/B are S-11's job).
- **Scope**: schedule view only (deterministic, derived on read, not stored) — the step-by-step cook mode is S-11.
