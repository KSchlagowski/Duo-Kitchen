---
change_id: household-data-scope
title: Household-scoped data access for all accounts
status: implementing
created: 2026-10-06
updated: 2026-10-06
archived_at: null
---

## Notes

Roadmap F-01 (`context/foundation/roadmap.md`, "F-01: Household-scoped data access").

- **Outcome:** (foundation) every signed-up person belongs to a household (initially of one), and a household-scoped access policy pattern is in place for all household data.
- **PRD refs:** Access Control (linked accounts share data; flat roles), NFR "Each household's data is visible only to that household's linked accounts and to the AI agent acting on their command".
- **Unlocks:** S-01, S-02, S-03 — and the privacy rule every later table reuses.
- **Scope:** only the household concept and the access pattern, not domain tables (those arrive with the slices that use them).
