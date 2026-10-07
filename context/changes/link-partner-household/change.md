---
change_id: link-partner-household
title: Link partner into one shared household via invite and redemption
status: plan_reviewed
created: 2026-10-07
updated: 2026-10-07
archived_at: null
---

## Notes

Roadmap item S-01 from context/foundation/roadmap.md: invite their partner and share one household.

Roadmap detail (S-01):

- **Outcome:** user can generate an invite code/link that their partner redeems, after which both see the same recipes, plans and shopping lists.
- **PRD refs:** US-01, FR-001, FR-002, FR-003
- **Prerequisites:** F-01
- **Parallel with:** S-02, S-03, S-05, S-07, S-14, F-03
- **Risk:** needed before S-04 because the solver needs two people; sign-up/sign-in (FR-001) already exist, so this slice only adds invite and redemption.
- **Open unknown (owner: user, non-blocking):** what happens to data a person created in their single-person household before redeeming an invite — merge vs. discard?

Assumptions stated for this non-interactive bootstrap (to be confirmed or revised during research/planning):

- The existing one-household-per-account model from `private.handle_new_user()` stays; redeeming an invite moves the redeemer into the inviter's household rather than creating a new shared one.
- Pre-redemption data in the redeemer's single-person household is out of scope for this slice until the unknown above is resolved; the slice should at minimum not silently destroy it.
- Because `seed_household()` must never re-run on an existing household, redemption must not trigger re-seeding.
- Invite storage will need a new household-scoped table, so the hard rules in CLAUDE.md apply: `household_id` FK + index, per-operation RLS `to authenticated` through `private.user_household_ids()`, a timestamped migration in `supabase/migrations/`, and an extension of `supabase/tests/household_isolation.sql`. Redemption by a user who is *not yet* a member means the lookup path for an unredeemed invite cannot rely on `user_household_ids()` alone — that tension is the main design question for planning.
