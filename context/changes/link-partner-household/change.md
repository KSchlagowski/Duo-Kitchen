---
change_id: link-partner-household
title: Link partner into one shared household via invite and redemption
status: impl_reviewed
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
  - **Resolution: deferred, not answered.** The unknown stays open and its owner stays the user. S-01
    ships neither a merge nor a discard: `redeem_household_invite()` moves the membership row, leaves
    the old household intact and memberless, and records it in
    `household_invites.redeemed_from_household_id`. Nothing is destroyed, so both answers remain
    available later. A merge is in any case forbidden by the current schema, not merely expensive —
    `unique (household_id, seed_id)` makes re-pointing the ~170 seed rows collide on every row, and
    the composite FKs `(recipe_id, household_id)` / `(component_id, household_id)` are
    `on update no action`, so changing a parent's `household_id` raises `foreign_key_violation`
    before any policy is consulted.
  - **What makes the deferral forward-safe:** the `KD006` guard. Redemption refuses outright if the
    redeemer's household holds any row with `seed_id is null`. Today nothing can create such a row
    (every slice that writes user data is still `proposed`), so the guard never fires; once one
    ships, redemption fails loudly with "Your kitchen has data that would be left behind" instead of
    silently orphaning it. The guard catches **additions only**, and the implementation review
    (`reviews/impl-review.md` F3) corrected the caveat as first written here: it is already incomplete
    **today**, not merely once S-05 ships. `20261007120000_products_and_recipes.sql` revokes only
    `truncate/references/trigger` from `authenticated` and grants full per-operation
    `insert/update/delete` policies, so a client can already delete _and edit_ its own seed rows
    through PostgREST — a deleted row leaves nothing to count, an edited one still has
    `seed_id is not null`, and both pass. Such a caller keeps those changes in the household they
    leave (the origin survives intact, so nothing is destroyed) but sees the target's untouched seed
    set afterwards: user intent is silently discarded. Closing it needs a per-row "customised" marker
    on the five tables, which belongs with the slice that owns seed editing. The corrected reasoning
    is recorded as a comment in the RPC body.

Assumptions stated for this non-interactive bootstrap (to be confirmed or revised during research/planning):

- The existing one-household-per-account model from `private.handle_new_user()` stays; redeeming an invite moves the redeemer into the inviter's household rather than creating a new shared one.
- Pre-redemption data in the redeemer's single-person household is out of scope for this slice until the unknown above is resolved; the slice should at minimum not silently destroy it.
- Because `seed_household()` must never re-run on an existing household, redemption must not trigger re-seeding.
- Invite storage will need a new household-scoped table, so the hard rules in CLAUDE.md apply: `household_id` FK + index, per-operation RLS `to authenticated` through `private.user_household_ids()`, a timestamped migration in `supabase/migrations/`, and an extension of `supabase/tests/household_isolation.sql`. Redemption by a user who is _not yet_ a member means the lookup path for an unredeemed invite cannot rely on `user_household_ids()` alone — that tension is the main design question for planning.
