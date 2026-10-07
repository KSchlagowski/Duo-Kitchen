<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Link Partner Into One Shared Household

- **Plan**: `context/changes/link-partner-household/plan.md`
- **Mode**: Deep
- **Date**: 2026-10-07
- **Verdict**: REVISE
- **Findings**: 1 critical, 4 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | WARNING |
| Architectural Fitness | PASS |
| Blind Spots | FAIL |
| Plan Completeness | WARNING |

## Grounding

21/21 paths ✓, 17/17 symbol and line-reference claims ✓, brief↔plan ✓.

Spot-checked and confirmed: `household_members.user_id unique` (`20261006120000:29`); the reserved-join-point and definer/revoke patterns (`:41-54`, `:56-62`, `:66-69`, `:71-83`); the four-policy template (`20261007120000:167-179`); F-02's revoke style and its reliance on Supabase default privileges for `select` (no explicit grants anywhere); **no `create function public.*` exists in any migration** (this slice is genuinely the first); the catch-all's `pg_policies`-only inspection and its `household_members` exemption (`household_isolation.sql:439-484`); the write-denial idiom (`:179-237`); the GUC stash (`:36-53`); both per-table loops bound by `array_length(tables, 1)` — so the plan's "add as element 6" works without touching the loop bound — and the `…<a|b>00%s` single-digit fixture-id format (`:246`, `:279`); the anon sweep's `foreach` (`:427`); `PROTECTED_ROUTES = ["/dashboard"]` only, so `/api/*` is indeed anonymously reachable (`middleware.ts:4,18`); the `scripts/**/*.mjs` globals allowlist of exactly `console, process, fetch, URLSearchParams` (`eslint.config.js:73-78`); `config.toml:13` schemas; smoke's module-level `jar`, `libraryLine` and the `signin → "/"` assertion (`smoke.mjs:7,42-45,63`); `zod` absent from `dependencies`; and `.github/workflows/ci.yml` running `test:rls`/`test:seed` with **no** `npx supabase db push` (`:36-47`).

Two stale details, neither load-bearing:

- Current State Analysis says nothing exists in `src/components/ui/` "beyond `button.tsx`" — `LibBadge.astro` is also there. Harmless: the slice adds no components.
- "the **eight** new steps that prove FR-002 and FR-003" (plan `:116`) contradicts "**ten** new steps" (plan `:608`, and the brief) and the ten listed in Phase 3 change 2. Folded into F3's fix.

## Findings

### F1 — Redeemer's old household keeps a live invite, so anyone holding that code can be moved into the orphan

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1 change 4 (`public.redeem_household_invite`); Decisions 1 and 4
- **Detail**: `redeem_household_invite` moves the membership row and stamps the invite, but never touches invites belonging to the **redeemer's** household. That household is now memberless with its ~170 seed rows intact — and if the redeemer had ever pressed "Generate invite code", it still has an unredeemed, unexpired bearer code pointing at it. None of the seven validations rejects that code afterwards: `KD005` counts members of the *invite's* household and the orphan has 0 (not ≥ 2), `KD004` only rejects your own household, and `KD006` only inspects the caller's own data. The reachable path is the ordinary one, not an exotic one: both partners click "Generate invite code" and swap links, B redeems A's link, and A's inbox still holds B's link. If A then clicks it, A is moved out of the shared household into B's empty orphan — splitting the couple, leaving B alone in the shared household, and handing A B's pre-redemption kitchen. Redemption is irreversible by any application path ("What We're NOT Doing": no leave/unlink), so recovery requires `postgres`. A third party who was ever sent the stale link gets the same access. The plan's Phase 1 redemption assertions check the orphan "still **exists** and has **0** members" but never that it has no live invite, so the test suite would ship green.
- **Fix A ⭐ Recommended**: Inside `redeem_household_invite`, after resolving the caller's origin household and before/with the membership update, add `delete from public.household_invites where household_id = v_origin_household and redeemed_at is null;` — symmetric with the delete `create_household_invite` already performs. Extend Phase 1 change 6 step 4 to assert the old household has **0** `household_invites` rows, and add a negative case to the negative-case block: a code minted by the redeemer before joining is rejected with `KD001` afterwards.
  - Strength: Removes the cause rather than the symptom, leaves no dangling row that a future reader has to reason about, needs no new SQLSTATE and no change to the error table or `inviteErrorMessage`, and reuses a statement the plan already specifies for the create path.
  - Tradeoff: Only closes the memberless-household route that this slice creates; it is not a general invariant, so a future slice that can empty a household another way must remember the same rule.
  - Confidence: HIGH — the deletion is in the same function body and the same transaction as the membership update, and `KD001` already covers the resulting "no row with that code" case with a correct user-facing message.
  - Blind spot: Not verified whether the inviter's dashboard needs any change when its own invite row disappears mid-session; `getActiveInvite` returning null plus `memberCount >= 2` should already render "Linked with your partner", but that combination is not among the Phase 2 manual checks.
- **Fix B**: Tighten the target-household check in `redeem_household_invite` to require **exactly one** member, raising a new SQLSTATE (e.g. `KD008`, "That invitation is no longer valid") when the count is 0, and keeping `KD005` for ≥ 2. Add the 0-member case to the negative-case block.
  - Strength: Closes the whole class — no caller can ever be moved into a household that is not exactly one person, however that household came to be empty, including routes future slices might open.
  - Tradeoff: Leaves the dangling unredeemed row in place (so `household_invites` accumulates rows that can never be redeemed, and the orphan still looks invitable in the table), adds an eighth SQLSTATE to the error table, the service mapping, CLAUDE.md and the test, and gives the user a message that cannot explain what actually happened.
  - Confidence: MEDIUM — the check itself is a one-line change to a count the function already computes, but it widens the surface touched in Phase 1 change 4, Phase 1 change 6, Phase 2 change 3 and Phase 4 change 1.
  - Blind spot: Interaction with account deletion is unverified — `created_by … on delete cascade` (see F2) removes invite rows when the inviter's account goes, which may already make the 0-member case unreachable by that route and leave Fix B guarding only the route Fix A removes.
- **Decision**: PENDING

### F2 — `created_by … on delete cascade` destroys the provenance the amended cleanup query depends on

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1 change 1 (column contract) and Phase 4 change 2 (README cleanup query)
- **Detail**: The column contract is `created_by uuid not null references auth.users on delete cascade`, while `redeemed_by` is deliberately `on delete set null`. The asymmetry defeats the whole point of Decision 10. Migration Notes call `redeemed_from_household_id` "the only record linking a memberless household to the partner who left it", and Phase 4's amended query spares exactly the households that record names. But deleting the **inviter's** account cascades the invite row away, taking `redeemed_from_household_id` with it — after which the amended query's `not exists (… i.redeemed_from_household_id = h.id)` clause matches nothing and the next cleanup run deletes the redeemer's preserved pre-redemption household, which is precisely the data-loss hazard F-02's impl-review flagged and this slice set out to close. Two concrete consequences: (a) for real users, one account deletion silently converts a protected household into collateral for a documented maintenance command; (b) for the smoke accounts, `delete from auth.users where email like 'smoke-%@example.com'` removes the invite rows first, so Phase 4 manual 4.4 ("confirm it … leaves no orphan whose provenance is still referenced") never exercises the sparing branch it is meant to verify — both households become deletable on pass 1 and the "run until it deletes 0 rows" note goes untested.
- **Fix A ⭐ Recommended**: Make `created_by uuid references auth.users on delete set null` (drop `not null`), matching `redeemed_by`. The invite row then outlives both accounts, the sparing clause keeps protecting the orphan, and the documented two-pass cleanup still terminates: the shared household is unreferenced as an origin, so pass 1 deletes it and cascades the invite via `household_id`, which releases the orphan for pass 2.
  - Strength: One-word schema change; preserves provenance across the only deletion the README actually documents; makes Phase 4 manual 4.4 exercise the branch it claims to, because the invite row survives the account delete and genuinely blocks the orphan on pass 1.
  - Tradeoff: `created_by` is no longer a guaranteed-present audit field, so anything later reading it must handle null; and the orphan is now only reclaimable in two passes rather than one.
  - Confidence: HIGH — the cascade chain is fully determined by the three FKs in the plan's own column contract, and `redeemed_by` already establishes the `on delete set null` precedent in the same table.
  - Blind spot: Whether any Phase 1 test assertion wants `created_by` non-null; the plan's fixture inserts set it explicitly, so dropping `not null` should not disturb them, but that was not checked against a running schema.
- **Fix B**: Keep `on delete cascade` and stop relying on the invite row for safety: drop the sparing clause from the README query and replace it with a two-step procedure — first list memberless households with their per-table row counts, then delete only the ones a human has confirmed are empty of real data.
  - Strength: Safe regardless of which rows survive an account deletion, and honest that "which orphan is real data" is a judgement call rather than a predicate.
  - Tradeoff: Turns a copy-pasteable maintenance command into a manual review step that someone under time pressure will skip, and discards Decision 10's automated protection entirely.
  - Confidence: MEDIUM — removes the failure mode but weakens the guarantee the change set was written to provide.
  - Blind spot: No check on whether CI's accumulating smoke households make the listing long enough that review becomes perfunctory.
- **Decision**: PENDING

### F3 — Nothing automated covers the signin→`/join` redirect, the slice's one novel auth mechanism

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 2 change 7 and Phase 3 change 2 (step 5)
- **Detail**: Phase 2 change 7 modifies `src/pages/api/auth/signin.ts` to redirect to `/join` when `dk_invite` is present — Decision 3 calls this "what makes the code survive the email round-trip", i.e. the only genuinely new behaviour in the auth flow. Phase 3 then orders B's steps so that B signs in (step 5) **before** ever visiting `/join` (step 7), and asserts `302 /`, explicitly describing that as "the regression guard on the change 7 redirect". It is the opposite: with no cookie set, the new branch is never entered, so `npm run smoke` and CI exercise only the unchanged path. The cookie branch's sole coverage is manual 2.8, which is also the one manual step that cannot be run against the hosted project as configured (see F4). A future edit that drops the branch — or gets the cookie name, `path` or `sameSite` wrong so the cookie is never sent back — ships fully green through both CI jobs.
- **Fix ⭐**: Reorder B's steps in Phase 3 change 2 so the cookie path is the one under test: (4) B GET `/join?code=<captured>` → 200, invite message, **no** confirm form, `Set-Cookie: dk_invite`; (5) B sign-up → 302 `/auth/confirm-email`; (6) B sign-in → **302 `/join`** (the new branch); (7) B GET `/join` with no query string → 200, confirm form rendered from the cookie alone (this also proves the cookie fallback, which no step currently touches); (8) B POST `/api/household/redeem` → 302 `/dashboard?joined=1` plus `dk_invite` cleared. The no-cookie `302 /` guard is preserved for free by A's pre-existing "signin accepts correct password → /" step, which Phase 3's automated criteria already require to keep passing — A never visits `/join`, so A's jar never holds the cookie. While editing, reconcile the step count: plan `:116` says "eight new steps", `:608` and the brief say "ten", and change 2 lists ten.
  - Strength: Covers both halves of Decision 3 (the redirect and the cookie-only read of `/join`) at zero extra cost, keeps the existing regression guard intact on a different account, and asserts the `Set-Cookie`/clear round trip that the current ordering skips entirely.
  - Tradeoff: B's sign-in assertion is no longer a second copy of the `/` guard, so a regression that redirects *everyone* to `/join` would be caught only by A's step rather than by two.
  - Confidence: HIGH — `smoke.mjs`'s `storeCookies` already keeps arbitrary cookies per jar and already honours `max-age=0` deletion (`:13-21`), and the plan's own `makeClient()` refactor gives B an independent jar, so no further script machinery is needed.
  - Blind spot: Not verified whether `/join` sets `dk_invite` on a GET from an unauthenticated visitor in Astro's SSR response path for a 200 (as opposed to a redirect); the plan specifies it, but no phase asserts the `Set-Cookie` header itself.
- **Decision**: PENDING

### F4 — The manual steps that prove the email-round-trip need a Supabase setting that smoke and CI need switched off

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 Manual Verification (Progress 2.8) and Testing Strategy → Manual testing steps 5
- **Detail**: Phase 2 manual verification reads "Signing up in that profile, **confirming the email**, then signing in lands on `/join`", and manual testing step 5 says "confirm the email from the inbox". But README's smoke-test section states the script "needs the hosted Supabase project with **email confirmation disabled**", and there is exactly one hosted project (`tvmfkhnxxsnmvogplknz`) shared by local work, smoke and both CI jobs. With confirmation off there is no email to click, so the tester either silently skips the slice's trickiest mechanism or flips the dashboard toggle and leaves it flipped, breaking the next `npm run smoke` and every CI run until someone notices. The plan never mentions the toggle, and because Phase 3 immediately runs smoke, the ordering makes the collision likely rather than hypothetical.
- **Fix**: In Phase 2's Manual Verification, say explicitly that 2.8 and manual step 5 are performed with **Authentication → Email → Confirm email temporarily enabled** on the hosted project, and add an instruction to turn it back off before Phase 3 or any `npm run smoke` run; also record the equivalent check for the default (confirmation-off) configuration — sign-up → `/auth/confirm-email` → sign-in → lands on `/join` — so the redirect is still verified when nobody wants to touch project settings. Add the toggle-back-off step to the Progress rows for 2.8 so it cannot be forgotten.
- **Decision**: PENDING

### F5 — Phase 1 never verifies the new RPCs are reachable through PostgREST, the assumption the whole design rests on

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 Success Criteria (Manual Verification); Key Discoveries ("The redemption function cannot live in `private`")
- **Detail**: The design's load-bearing premise is "`public` is API-exposed, `private` is not", and the cited evidence is `supabase/config.toml:13`. That file configures the **local** stack, which CLAUDE.md forbids running ("Supabase is cloud-only … Do not run a local Supabase stack"); the hosted project's exposed schemas live in its dashboard API settings, and a newly created function also has to be picked up by PostgREST's schema cache. The conclusion is almost certainly right (it matches the Supabase default), but Phase 1 — which the plan bills as "The whole security posture is provable here, before a line of TypeScript" and as independently verifiable — checks only `pg_proc` attributes and table grants. Nothing confirms that `POST /rest/v1/rpc/create_household_invite` resolves at all. If `public` were not exposed, or the cache were stale, Phase 1 goes fully green and the failure surfaces at the very last manual step of Phase 2, after the migration has already been pushed to the shared project.
- **Fix**: Add one automated Phase 1 criterion (and its Progress row) that calls the RPC over HTTPS with the anon key and asserts the status is **not 404** — e.g. `curl -s -o /dev/null -w '%{http_code}' -X POST "$SUPABASE_URL/rest/v1/rpc/create_household_invite" -H "apikey: $SUPABASE_KEY" -H "Content-Type: application/json" -d '{}'`, expecting 401/403 from the anon revoke. One command proves both that `public` is exposed on the hosted project and that the `revoke execute … from anon` holds over the real transport, which no other check in the plan covers. Reword the Key Discovery to cite the hosted project's API settings as the authority and `config.toml:13` only as corroboration.
- **Decision**: PENDING

### F6 — `create_household_invite` has no concurrency guard, while `redeem_household_invite` does

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 change 3; Critical Implementation Details → "Atomicity"
- **Detail**: The plan is explicit that redemption must `select … for update` the invite row before validating so two concurrent redemptions cannot both pass the `redeemed_at is null` check — but `create_household_invite` is specified as a bare `delete … where redeemed_at is null` followed by an `insert`, with no lock. Two concurrent calls (a double-clicked "Generate new code", or a double-submitted form) either both find nothing to delete or both re-insert after the first commits, and the second hits `household_invites_one_unredeemed_idx` with `unique_violation` (23505). That is not in the `KD0xx` table, so `inviteErrorMessage` can only render its neutral fallback and the inviter sees an unexplained failure on a button they pressed twice.
- **Fix**: Before the delete/insert, serialise on the caller's household row — `perform 1 from public.households where id = v_household for update;` — matching the locking discipline the plan already mandates for redemption. No new SQLSTATE is needed: the second caller then simply mints the next code.
- **Decision**: PENDING

### F7 — A fourth assertion mechanism in `smoke.mjs`, and the failure printout does not cover it

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 3 change 1, fourth bullet
- **Detail**: To work around the eagerly-evaluated `steps` literal, the plan adds a fourth assertion channel — `check: (actual) => boolean` — alongside `status`, `location` and `body`. The same blocker is solved by making the third tuple element optionally a thunk evaluated inside the loop, which reuses all three existing channels instead of adding one. More importantly, the plan leaves a gap either way: the failure printout at `smoke.mjs:84-87` prints extracted text only when `expected.body !== undefined`, so a failed `check` prints just status and location. Steps 9 and 10 — the FR-003 cross-account equality assertions, the whole point of the phase — are `check`-only, meaning the two most informative failures in the suite would be the least diagnosable, directly against manual 3.5 ("deliberately break one assertion and confirm the output … shows the extracted text").
- **Fix**: Make the third tuple element optionally a function (`const expected = typeof raw === "function" ? raw() : raw;` inside the loop) and drop `check`, so steps 9 and 10 express their assertions as `body` RegExps built from A's captured text and the existing `testIdText` printout fires automatically on failure. If `check` is kept instead (a plain string compare avoids RegExp-escaping the captured household line), then also extend the printout so a failed `check` prints `testIdText(actual.body, …)` for the relevant `data-testid`, and state which id each step diagnoses.
- **Decision**: PENDING

### F8 — `redeemed_from_household_id` is silently wrong if the caller's household is re-resolved after the membership update

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 change 4 (Contract, the two `update` statements)
- **Detail**: The Contract lists the membership `update` first and then the invite `update` with `redeemed_from_household_id = <caller's old household>`, without saying where that value comes from. `private.user_household_ids()` is declared `stable`, and inside a plpgsql body each statement runs with a fresh snapshot — so re-calling the helper after `update public.household_members set household_id = <target>` returns the **target**, not the origin. The obvious reading of the Contract therefore produces a row whose `redeemed_from_household_id` equals the shared household. Nothing in Phase 1 change 6 step 4 would catch it (it asserts the field is set, not that it differs from the target), and the downstream damage is exactly inverted from the intent: Phase 4's cleanup query would then permanently spare the live shared household while the orphan it was meant to protect becomes deletable on the first pass.
- **Fix**: State in the Contract that the caller's household id is resolved once into a local (`v_origin_household`) before any write and reused for the `KD004`/`KD006` checks and the provenance stamp; and strengthen Phase 1 change 6 step 4 to assert `redeemed_from_household_id` equals D's recorded old household **and** `<> ` C's household id, so the inverted value fails the test instead of passing it.
- **Decision**: PENDING
