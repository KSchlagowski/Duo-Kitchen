---
change_id: shared-dish-across-days
title: Let one cooked dish cover meals on several days and still solve (S-08)
status: implemented
created: 2026-10-10
updated: 2026-10-12
archived_at: null
---

## Notes

S-08 from @context/foundation/roadmap.md

Research: @context/changes/shared-dish-across-days/research.md (2026-10-11). It answers the roadmap's
one Unknown — a shared dish **couples** the days into one solve; "days solved in order with the batch
fixed" fails a sizing paradox — and recommends the **solve group** (days connected by a shared dish;
a day sharing nothing is a group of one and behaves exactly as today) as the unit of work.

Plan: @context/changes/shared-dish-across-days/plan.md (2026-10-11), brief at
@context/changes/shared-dish-across-days/plan-brief.md. Four phases: the coupled solver (pure, gated
on a CPU budget), the migration + the two RPCs (`save_meal_plan` gains `share_with` with
KD015–KD017; `save_plan_day_solutions` replaces `save_day_solution`), the services/routes/pages, then
smoke and docs. Every decision the research left open is settled inline as D1–D11.

Plan review: @context/changes/shared-dish-across-days/reviews/plan-review.md (2026-10-11). Verdict
REVISE — 1 critical, 8 warnings, 1 observation, every finding at `Decision: PENDING`. The approach
holds; the fixes are targeted. Headline items: the coupled repair objective is missing from Phase 1
(F1), Phase 2's `db push` breaks production solve until the deploy (F2), and the CPU gate measures
vitest rather than workerd with no exit if its mitigation falls short (F3/F4).
