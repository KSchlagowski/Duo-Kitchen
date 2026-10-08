<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Link Partner Into One Shared Household

- **Plan**: `context/changes/link-partner-household/plan.md`
- **Scope**: Phases 0–4 of 4 (full plan review); commits `c694a85..ee8ef73`
- **Date**: 2026-10-07
- **Verdict**: REJECTED (pre-triage) → NEEDS ATTENTION after the fixes applied below; hosted verification still outstanding
- **Findings**: 1 critical, 6 warnings, 3 observations

## Verdicts

| Dimension           | Verdict | Note                                                                                                                                               |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan Adherence      | WARNING | One planned change never applied (F7); one half-applied (F10). Everything substantive matches the contract line for line.                          |
| Scope Discipline    | WARNING | Extras exist (4 smoke steps, `comment on function`, the `prosrc` assertion, a repo-hook Prettier pass on `plan.md`) — all benign and all declared. |
| Safety & Quality    | FAIL    | F1 is an irreversible data-safety defect reachable by one click.                                                                                   |
| Architecture        | PASS    | First `public` definer-RPC surface built exactly as designed; service/lib/route boundaries respected; no `supabase.from` in pages.                 |
| Pattern Consistency | WARNING | Three minor mismatches (F9, and the two noted under F8).                                                                                           |
| Success Criteria    | WARNING | Every criterion runnable here passes. 24 Progress rows — including Phase 1's central gate — have never run for want of credentials.                |

### Verification run in this container

| Check                                                                              | Result                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint`                                                                     | **pass** (after F6's fix was reworked for `prefer-nullish-coalescing`)                                                         |
| `npx astro check`                                                                  | **pass** — 0 errors, 0 warnings, 0 hints across 37 files                                                                       |
| `npm run build`                                                                    | **pass**                                                                                                                       |
| `npx prettier --check` on every file this slice touches                            | **pass** — the 71 repo-wide failures are all files this change never touches, confirming the Progress-note claim about row 4.2 |
| `npx supabase db push`, `test:rls`, `test:seed`, `smoke`, the Phase 1 `curl` probe | **not run** — no Supabase credentials in this container; CLAUDE.md forbids a local stack. Pending hosted verification.         |

### Pending hosted verification (unchanged by this review)

Phase 1's gate is the blocking item and is **not** a code defect: the migration has never been applied
to `tvmfkhnxxsnmvogplknz`, so `npm run test:rls` has never exercised `household_invites` against the
deployed schema, and the `curl` RPC-reachability probe — the only check that `public` is API-exposed and
that the anon revoke holds over the real transport — is unrun. CI tests the deployed schema, so
`npx supabase db push` must precede merge. This review **added** assertions to
`household_isolation.sql` (F1, F2), so that test has grown, not shrunk, while still unrun.

---

## Findings

### F1 — An already-linked user can be moved out of their household, abandoning their partner, with no warning and no undo

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20261007120200_household_invites.sql:205-217` (pre-fix); `src/pages/join.astro:50-67` (pre-fix)
- **Detail**: `redeem_household_invite()` capped only the **target** household at two members. A caller
  already linked with a partner who followed a third party's invite link was moved into the new
  household, leaving their partner alone in the shared one — and S-01 ships no leave/unlink path, so
  nothing in the application could put them back. Three aggravating details:
  - The origin-side delete at `:240-241` is `where household_id = v_origin_household and redeemed_at is null`.
    In this case the origin **still has a member**, so the remaining partner's own live invite code was
    destroyed as a side effect of someone else's redemption.
  - `/join` rendered the confirm form for such a caller under the text _"Joining moves your account into
    it."_ It queried nothing, so it could not know the caller was linked and could not warn that they
    were about to **leave** a shared household. One click, irreversible, affecting a third party who did
    nothing.
  - `KD006` is no substitute: it fires only once the couple has added a non-seed row, so a freshly
    linked couple was wholly unprotected, and its message ("data that would be left behind") describes
    the wrong problem.

  The implementer found this and recorded it (plan.md:878-886) as needing a product decision, on the
  grounds that it "needs a user-facing message, so it is scope the approved plan bounded out". That
  reasoning does not hold up: **refusing** an irreversible action is the conservative default, not a new
  feature, and `create_household_invite()` already caps the caller's own household at two members — so
  the asymmetry was internal to the slice, not a boundary the plan drew.

- **Fix** (applied): add the symmetric origin-side cap as `KD008`, placed after `KD004` and before the
  target checks; map it in `INVITE_ERRORS`; have `/join` call `getCurrentHousehold` and render an
  explanatory state instead of the form when `memberCount >= 2`; add a `KD008` case to the isolation
  test using C (two-member household) against B's fixture invite.
  - Strength: Closes an irreversible path at the only cheap moment — the migration is still unpushed, so
    this is an in-place edit rather than a follow-up migration. Makes `redeem` symmetric with `create`.
  - Tradeoff: Two new SQLSTATEs' worth of surface, and a deliberate "move to a different household"
    flow now needs its own slice (it did anyway).
  - Confidence: HIGH — I traced every existing negative case to confirm the new check cannot pre-empt
    one: `KD003`/`KD001` are checked before `KD008`, which is what keeps the D-re-redeems and
    F-stale-origin cases reporting their own codes.
  - Blind spot: The `/join` guard adds a query to a page that previously made none; its latency and its
    behaviour when `createClient()` returns null are covered by the same try/catch idiom as
    `dashboard.astro`, but neither path has run against the hosted project.
- **Decision**: FIXED

### F2 — An invite for a household nobody is left in stays redeemable for 7 days

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20261007120200_household_invites.sql:212-217` (pre-fix)
- **Detail**: `created_by` is `on delete set null` (deliberately, per plan-review F2) while
  `household_members.user_id` is `on delete cascade`. So if the inviter deletes their account inside the
  7-day TTL, the invite row survives with `redeemed_at is null`, a future `expires_at`, and a
  `household_id` pointing at a now-memberless household. No validation rejected it: `KD005` tested
  `>= 2` (it is 0), `KD004` only rejects the caller's own household, `KD001`/`KD002`/`KD003` all pass.
  The redeemer therefore abandoned their own kitchen to land **alone** in a deleted stranger's
  household, irreversibly. Narrow — there is no in-app account-deletion path, and CI's cleanup only
  deletes accounts whose invites are already redeemed — but the guard is three lines.
- **Fix** (applied): add `if v_members < 1 then raise … using errcode = 'KD009'` alongside the existing
  target cap, map the message, and add a `KD009` case to the isolation test pointing at D's former
  household (memberless after the redemption block, with its unredeemed slot free).
- **Decision**: FIXED

### F3 — The KD006 guard's stated premise is false: clients can already delete and edit seed rows today

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20261007120200_household_invites.sql:219-221` (pre-fix); the same claim in `plan.md:127` and `change.md`
- **Detail**: The guard counts only `seed_id is null` rows and justified that with _"Nothing can delete
  seed rows today (S-05 is proposed); the slice that enables it must revisit this guard."_ That premise
  is wrong. `20261007120000_products_and_recipes.sql:160-164` revokes only `truncate, references,
trigger` from `authenticated` and `:167-179` et al. create full per-operation `insert/update/delete`
  policies on all five tables — the isolation test itself exercises a product delete at `:313-334`. So a
  client can already delete **and edit** its own household's seed rows through PostgREST. Both pass
  KD006: a deleted row leaves nothing to count, and an edited row still has `seed_id is not null`.
  Consequence: a caller who pruned or corrected seed rows keeps those changes in the household they
  leave (the origin survives intact, so Decision 1's "at minimum not silently destroy it" still holds)
  but sees the target's untouched seed set afterwards. Nothing is destroyed; user intent is silently
  discarded — and the comment tells the S-05 implementer the guard is intact when it is not.
  This is a **plan flaw faithfully implemented**, not implementation drift.
  Compounding it, the five-table list is literal with no exhaustiveness assertion: the catch-all in
  `household_isolation.sql` iterates every `household_id`-bearing table for RLS, but nothing checks that
  KD006 probes them all, so the first household-scoped table S-02 onward forgets here is silently
  unguarded.
- **Fix** (applied): correct the comment to state the guard is already incomplete for deletions **and**
  edits, name the grant that makes it so, say what is lost versus what is safe, point at a per-row
  "customised" marker as the real fix and whose slice owns it, and record the table list's maintenance
  obligation. Add the same correction to `change.md`'s forward-safety paragraph.
  - Strength: Fixes the actual defect — a false claim a future slice will rely on — without touching
    KD006's logic, which would be real scope.
  - Tradeoff: The incompleteness remains; only its documentation is now honest.
  - Confidence: HIGH — I read the grants and policies directly rather than taking the claim on trust.
  - Blind spot: Whether the hosted project's grants match the migration (they should, but see the
    pending `db push`).
- **Decision**: FIXED (documentation); the structural fix is recorded for the seed-editing slice

### F4 — A code minted concurrently with a redemption survives the move, defeating plan-review F1's accepted fix

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20261007120200_household_invites.sql:119-134` and `:240-241` (pre-fix)
- **Detail**: `create_household_invite()` serialises itself on the households row (`:131`);
  `redeem_household_invite()` took no such lock before its origin-side delete. Two interleavings both
  defeat that delete, which plan-review F1 rated CRITICAL:
  1. **Redeem first** — redeem deletes the old code and commits; `create`, whose member count was read
     from a pre-move snapshot, finds nothing to delete and inserts a new one.
  2. **Create first** — `create` deletes the old code and inserts a new one; redeem's DELETE blocks on
     the old row's lock, and when it resumes the new row is outside its statement snapshot (a blocked
     DELETE re-checks only the rows it blocked on; it does not re-scan), so the new code survives.

  Either way a live bearer code points at the household the caller just left — exactly the hazard
  `:233-239` exists to prevent, recoverable only with `postgres`. Needs a genuine double-submit across
  two tabs, so it is narrow, but it is a residual hole in an accepted CRITICAL fix rather than new scope.

- **Fix** (applied): take the same lock in `redeem` (`perform 1 from public.households where id = v_origin_household for update`)
  immediately after the KD007 check, and move `create`'s member count to **after** its lock with a
  `v_members < 1` → `KD007` branch. Case 2 is closed by the lock (redeem's delete then runs on a fresh
  snapshot); case 1 by the re-read (`create` now sees the caller is gone). Both functions lock
  `households` before `household_invites`, keeping the lock order consistent.
  - Strength: Two one-line additions plus moving six lines; completes a fix the plan review already
    accepted.
  - Tradeoff: Redemption now takes one more row lock.
  - Confidence: MEDIUM — the MVCC reasoning is sound and independently confirmed, but the interleaving
    cannot be reproduced without concurrency against the hosted project.
  - Blind spot: Not observable from any test in this repo. The pre-existing mutual-redemption deadlock
    (two users in two households redeeming each other's codes) is unchanged by this fix — it already
    existed via the invite-row locks and resolves as `40P01`.
- **Decision**: FIXED

### F5 — A same-origin POST with a non-form body 500s instead of redirecting

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/household/redeem.ts:24` (pre-fix)
- **Detail**: Astro's `checkOrigin` rejects only **cross**-origin form-like POSTs, so a same-origin
  `POST /api/household/redeem` with `Content-Type: application/json` reaches the handler;
  `Request.formData()` then rejects and the route's own `?error=` redirect never runs. This slice
  establishes the zod convention, so it is the right place to establish the surrounding guard. The three
  pre-existing auth routes share the shape but are explicitly out of scope ("No retrofit of the three
  auth routes").
- **Fix** (applied): wrap `formData()` in try/catch and fall through to the existing
  `/join?error=…` redirect; hoist the shared message to a constant.
- **Decision**: FIXED

### F6 — `/join` writes any `?code=` value into a 7-day cookie that hijacks post-sign-in routing, and an empty one shadows a good cookie

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/pages/join.astro:11-15` (pre-fix)
- **Detail**: Two defects in four lines.
  - No validation before `setInviteCookie`. `/api/auth/signin` diverts **every** sign-in to `/join` while
    `dk_invite` is present, so getting a victim to open one crafted link hijacks their post-sign-in
    landing page for seven days, and the stored value can be multi-KB and is sent on every request. A
    nuisance, not an escalation — but the 16-hex shape was already known.
  - `queryCode ?? readInviteCookie(...)` uses `??`, which falls through only on null/undefined. So
    `/join?code=` (empty value) yields `code === ""` and renders "This invite link is incomplete." even
    when the cookie holds a good code. The cookie itself survives, so only that render was wrong.
- **Fix** (applied): export `INVITE_CODE_PATTERN` from `src/lib/invite-cookie.ts` — the module whose
  stated job is that `/join`, the redeem route and the signin route "cannot disagree" — and use it in
  both the cookie write and the redeem route's zod schema; normalise an empty `?code=` to null so it
  falls through to the cookie. A malformed code still renders, so the plan's manual step 9 (zod rejects
  `?code=zzzz` with a readable message) still exercises what it was written to exercise.
  - Note: the first attempt used `||` for the fallback and `npm run lint` rejected it under
    `@typescript-eslint/prefer-nullish-coalescing`; reworked to an explicit empty-string normalisation.
- **Decision**: FIXED

### F7 — Phase 4 change 3 (`.claude/settings.json`) is the one planned change with no implementation

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `.claude/settings.json` — still only the two `test:rls` entries
- **Detail**: The plan asked for `Bash(npm run test:seed)` and
  `Bash(npx supabase db query --linked -f supabase/tests/seed_integrity.sql)` alongside the existing
  `test:rls` pair. The Progress notes say the write was denied; **I attempted it in this session and it
  was denied again**, so the claim is accurate and the blocker is the tool-permission layer, not an
  oversight. Worth noting the change has no Progress checkbox of its own, which is why it was easy to
  lose. It is inherited F-02 follow-up F2, so no S-01 behaviour depends on it.
- **Fix**: Add the two entries in a session granted write access to `.claude/settings.json`.
- **Decision**: SKIPPED — blocked by tool permissions in this environment, twice; re-attempting would
  not change the outcome. Left for a permitted session.

### F8 — Two misleading comments in the migration: entropy overstated, and a cross-reference pointing the wrong way

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `supabase/migrations/20261007120200_household_invites.sql:136-139` and `:56-59` (pre-fix)
- **Detail**: (a) The code-generation comment claims "64 bits". `substr(replace(gen_random_uuid()::text,'-',''),1,16)`
  takes bytes 0–7 of a UUIDv4, and hex character 13 is the version nibble — always `'4'`. So every code
  carries a constant at a fixed position and 60 random bits, not 64. Immaterial for a single-use 7-day
  code, but a future reader may lean on the figure. (b) The RLS banner says "the revokes **above**" while
  sitting at `:53-63`, above the revokes it describes at `:66-67` — correct relative to the policies that
  follow, confusing relative to itself.
- **Fix** (applied): correct both comments.
- **Decision**: FIXED

### F9 — Both API routes swallow unexpected errors with no logging, against the precedent set two files away

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/pages/api/household/invite.ts:18-20`, `src/pages/api/household/redeem.ts:37-40` (pre-fix)
- **Detail**: Anything that is not a mapped `KD0xx` became the neutral fallback message with no
  `console.error`, so in production a broken RPC is indistinguishable from a user mistyping a code.
  `dashboard.astro:19-36` sets the opposite precedent three times over, with the
  `// eslint-disable-next-line no-console -- surfaced in Cloudflare Workers observability logs` comment.
- **Fix** (applied): add the same logged-and-continue line to both catch blocks.
- **Decision**: FIXED

### F10 — Three assertion and diagnostic gaps in the two test harnesses

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `supabase/tests/household_isolation.sql:1000`; `scripts/smoke.mjs:191-195`, `:5`
- **Detail**:
  - Plan:308 asks to extend "the closing `raise notice` summary **and** the success `select`". The
    `raise notice` was extended; the `select` was left at the pre-change literal. Cosmetic, but
    half-applied.
  - The smoke step named _"A is linked, so no invite form is offered"_ asserted only the
    `data-testid="invite"` label, not the absence of `action="/api/household/invite"` — the name
    promised more than it checked. (The signed-out `/join` step does this correctly, via a negative
    lookahead.)
  - `BASE_URL` is sent verbatim as the `Origin` header and compared to `url.origin`, so
    `BASE_URL=http://localhost:4321/` would 403 every POST and fail the whole S-01 half of the script
    with a confusing error.
- **Fix** (applied): extend the success `select`; add the negative lookahead to the step; strip a
  trailing slash from `BASE_URL`. Also added a comment recording that the KD006 probe's position last in
  the negative-case array is load-bearing (it is the one case that mutates on regression).
- **Decision**: FIXED

---

## Recorded, not fixed

Judged genuine but out of a review's remit — each would change behaviour the plan deliberately specified,
or needs work belonging to another slice.

| Item                                                                                                                                                                                                                       | Why not fixed here                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A stale `dk_invite` cookie is never cleared on terminal rejections**, so a user who abandons a join is redirected to `/join` on every sign-in for 7 days.                                                                | The plan specifies keeping the cookie on failure so `/join` can re-render. Clearing it for `KD001`/`KD002`/`KD003`/`KD004`/`KD008` is a small, sensible follow-up. |
| **KD006's table list has no exhaustiveness assertion** — derive it from `pg_attribute`, or assert over `pg_proc.prosrc` as the file already does for `seed_household`.                                                     | Real work, and it belongs with the slice that adds the next household-scoped table. Obligation now recorded in the RPC body.                                       |
| **Per-row "customised" marker on the five seed tables**, so KD006 can detect edited and deleted seed rows (F3's structural half).                                                                                          | Owned by the seed-editing slice (S-05).                                                                                                                            |
| **KD007's message is wrong on the create path** — "You need an account to join a household." surfaces on the dashboard when an authenticated user has no household.                                                        | The plan pinned that wording; changing it is a product call.                                                                                                       |
| **`smoke.mjs` has no per-step try/catch**, so a network error aborts the loop with an unhandled rejection and no summary.                                                                                                  | Harness robustness, not S-01 behaviour.                                                                                                                            |
| **The invite code travels in a URL query string** and so reaches history, logs and `Referer`. Currently closed: `Layout.astro` loads no external subresources and its one external anchor has `rel="noopener noreferrer"`. | One Google Font away from leaking. Worth a `<meta name="referrer">` on `/join` or a comment in the layout.                                                         |
| **CSRF protection is implicit and removable** — `createOriginCheckMiddleware` is installed only because `src/middleware.ts` exists, so emptying that file would silently unprotect every POST route, redemption included.  | Worth a line in CLAUDE.md under the API-route convention.                                                                                                          |
| **`secure: true` on `dk_invite` with an HTTP preview** on a LAN IP would silently drop the cookie.                                                                                                                         | Correct for production; worth a note beside the existing `sameSite` comment.                                                                                       |
| **Distinct `KD0xx` codes form an enumeration oracle** (unknown vs expired vs used).                                                                                                                                        | A deliberate trade the plan made for test and UI precision; immaterial at 60 bits.                                                                                 |
| **`"private` is not API-exposed" rests on a dashboard setting** the repo cannot enforce; `config.toml` configures only the forbidden local stack.                                                                          | Defence in depth holds via the revokes. The new CLAUDE.md rule could say the premise is unenforceable from the repo.                                               |
| **`RpcResult<T>` is described as following `household.ts`**, which has no `rpc()` call and no result envelope — it is a genuinely new pattern.                                                                             | Comment-level nit; the next service would look for a precedent that is not there.                                                                                  |
| **Duplicated error-banner markup** in `join.astro` and `dashboard.astro`, while `ServerError.tsx` already encapsulates it for the auth pages.                                                                              | Two copies is the point at which extraction starts paying; the third will not be noticed.                                                                          |
| **`create_household_invite()`'s code-replacement path is untested** — the delete-then-insert behind "Generate new code" has no isolation assertion.                                                                        | Worth adding with the next test pass; plan manual row 2.6 covers it by hand.                                                                                       |

## Fixes applied — files touched

| File                                                       | Change                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase/migrations/20261007120200_household_invites.sql` | `KD008` origin cap, `KD009` memberless-target guard, origin-household lock in `redeem`, count-after-lock + `KD007` lower bound in `create`, corrected KD006/entropy/cross-reference comments, both `comment on function` texts |
| `supabase/tests/household_isolation.sql`                   | `KD008` block (C against B's invite), `KD009` case (D's former household), load-bearing-ordering comment, extended success `select`                                                                                            |
| `src/lib/services/invites.ts`                              | `KD008` / `KD009` messages                                                                                                                                                                                                     |
| `src/lib/invite-cookie.ts`                                 | exported `INVITE_CODE_PATTERN`                                                                                                                                                                                                 |
| `src/pages/join.astro`                                     | already-linked state, cookie written only for a well-formed code, empty `?code=` falls through                                                                                                                                 |
| `src/pages/api/household/redeem.ts`                        | shared pattern, `formData()` guard, error logging                                                                                                                                                                              |
| `src/pages/api/household/invite.ts`                        | error logging                                                                                                                                                                                                                  |
| `scripts/smoke.mjs`                                        | `BASE_URL` trailing-slash strip, negative lookahead on the no-invite-form step                                                                                                                                                 |
| `context/changes/link-partner-household/change.md`         | corrected the KD006 forward-safety claim; `status: impl_reviewed`                                                                                                                                                              |
| `context/changes/link-partner-household/plan.md`           | review-follow-up note superseding the "left unfixed" paragraph                                                                                                                                                                 |

Because the migration had never been pushed, every SQL fix is an in-place edit of
`20261007120200_household_invites.sql` rather than a follow-up migration. That window closes the moment
`npx supabase db push` runs.

## Next steps, in order

1. `npx supabase db push` — applies the amended migration to `tvmfkhnxxsnmvogplknz`.
2. `npm run test:rls` — now covers eight rejection SQLSTATEs including the two added here.
3. `npm run test:seed`.
4. The Phase 1 `curl` probe — expect 401/403, **stop on 404**.
5. `npm run build && npm run preview`, then `BASE_URL=http://localhost:4321 npm run smoke`, twice.
6. Settle the remaining manual Progress rows, add the `.claude/settings.json` entries (F7), and flip
   `change.md` to `implemented`.
