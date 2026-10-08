# Set Daily Macro Targets (S-02) — Plan Brief

> Full plan: `context/changes/set-daily-macro-targets/plan.md`
> Research: `context/changes/set-daily-macro-targets/research.md`

## What & Why

Each person can enter their own daily calorie, protein, fat and carb targets and see their partner's (roadmap S-02, FR-004). These targets are what S-04's solver will aim at, landing each daily total within ±10%. So they must exist per person, survive partner linking, and be readable by both partners.

## Starting Point

Nothing for targets exists today. F-01 and S-01 supplied the household RLS helper, the isolation test with its catch-all, and the form → zod → redirect pattern. S-01 also supplied the trap: `redeem_household_invite()` moves a person by updating one `household_members` row. Any per-person row with a plain `household_id` would be stranded in the old, memberless household.

## Desired End State

`/targets` shows your editable targets and your partner's read-only targets ("Not set yet" / "Not linked yet" when absent). It also shows a soft hint when your four numbers disagree with each other by more than 10%. The dashboard shows a one-line summary. Targets set before linking arrive intact in the shared household. Both the SQL isolation test and the HTTP smoke test prove all of this.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Surviving redemption | Composite FK `(household_id, user_id) → household_members on update cascade on delete cascade` | The move happens atomically in the same statement, the delicate definer function is untouched, and the FK also proves membership. | Research |
| Table shape | One row per person (PK `user_id`), four `not null` ints, CHECK bounds, no history | FR-004 needs only the current target; S-04 owns any snapshotting. | Research |
| Who may write | Owner only (`user_id = auth.uid()` in write policies); household-wide read | "Their own targets"; the flat role model is not shared ownership. | Research |
| Write path | Direct RLS upsert from a service, no RPC | RLS, CHECKs and the FK already enforce every invariant. | Research |
| Validation | Digits-only regex before number conversion; bounds equal to the CHECKs | `Number("") === 0` would otherwise save a blank fat or carbs field as 0. | Research |
| UI | Server-rendered `.astro` page plus dashboard line, no React island | No client state is needed; this matches S-01. | Research |
| Consistency hint | 4/4/9 vs kcal, >10% gives a soft note, never blocks | Warns before solve time without becoming a calculator. | Research |
| Prove the cascade over HTTP too | B saves targets before redeeming; A then sees them | Gives CI an end-to-end proof alongside the SQL assertion. | Plan |
| Labels / names | "You" / "Your partner"; no A/B labels or display names | Out of the S-02 outcome; S-03 keys eaters on `user_id`. | Research |

## Scope

**In scope:**

- `public.macro_targets`: migration, RLS and revokes.
- Isolation test blocks, including the redemption cascade.
- Types, service, `POST /api/targets`, the `/targets` page, `PROTECTED_ROUTES`, the dashboard line.
- Smoke steps.
- CLAUDE.md and README updates.

**Out of scope:**

- Target history.
- Display names and A/B labels.
- Calculators and onboarding.
- A "clear targets" UI.
- Partner editing.
- RPCs.
- Islands and i18n.
- Any change to `redeem_household_invite()`.

## Architecture / Approach

The form posts to `POST /api/targets`. The route validates with zod and calls `saveMyMacroTargets`, which resolves the caller's `household_id` and upserts on `user_id`. RLS restricts writes to the owner within their household. Pages read every household row with `getHouseholdMacroTargets`, and RLS scopes that to the household. The composite FK keeps each row glued to its owner's membership row, so the existing redemption update carries it automatically.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema, RLS & isolation | Table on the hosted project, plus SQL proof of isolation, owner-only writes and the cascade | The cascade assertion is the only hosted proof; it must stay and be shown non-vacuous |
| 2. App layer | Types, service, route, `/targets`, dashboard line | Empty-string coercion slipping through as 0 |
| 3. Smoke | HTTP flow incl. B's pre-link targets surviving redemption | Step ordering around B's `/join` sign-in |
| 4. Docs | CLAUDE.md per-person FK convention, README route and smoke notes | — |

**Prerequisites:** the CLI is linked to `tvmfkhnxxsnmvogplknz`; email confirmation is off for smoke; `db push` runs before merge.

**Estimated effort:** about 1–2 sessions across 4 small phases.

## Open Risks & Assumptions

- **Assumption:** the RI cascade fires inside the security-definer redemption and bypasses RLS, as Postgres semantics say. The Phase 1 assertion verifies it, and if it fails, stop and redesign rather than patch the function.
- **Assumption:** account deletion cascades targets away, so the README cleanup needs no query change.
- **Assumption:** a validation error loses what the user typed (the form re-fills from the saved row). This is acceptable given the HTML constraints.
- S-04 must snapshot targets for determinism, and S-03 must key eaters on `user_id`. Both are hand-offs, not work in this plan.

## Success Criteria (Summary)

- Each person can set and edit only their own targets and can see their partner's.
- Targets set before linking are still there, and visible to the partner, after linking.
- `npm run test:rls` and `npm run smoke` pass on the hosted project.
