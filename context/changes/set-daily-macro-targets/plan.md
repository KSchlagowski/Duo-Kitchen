# Set Daily Macro Targets (S-02) — Implementation Plan

## Overview

Each person in a household can enter their own daily calorie, protein, fat and carb targets and see their partner's (roadmap S-02, PRD US-01 / FR-004). The work adds one per-person table, `public.macro_targets`. Its composite foreign key to `household_members` makes each row follow its owner through `redeem_household_invite()`. On top of the table the plan adds a service, a POST route, a server-rendered `/targets` page and a summary line on the dashboard. The isolation test and the smoke test are extended to cover them.

The session ran non-interactively. Every decision below is the option the research recommended. Each one is stated inline as **Decision** or **Assumption**, and nothing is left open.

## Current State Analysis

- Nothing for targets exists yet: no table, type, service, route or UI. There are four migrations (`supabase/migrations/2026100{6,7}*`), and none of them mentions targets.
- `redeem_household_invite()` moves a person with a single `update public.household_members set household_id = …` (`supabase/migrations/20261007120200_household_invites.sql:296-298`). Suppose a per-person row carried a plain `household_id`. After a redemption it would be stranded in the redeemer's old, memberless household. Neither partner could read it any more, and the owner's upsert would be blocked by RLS (research §3).
- `household_members` already has PK `(household_id, user_id)` and `user_id unique` (`20261006120000_household_data_scope.sql:26-32`). That PK is a valid composite-FK target.
- Precedent for a client-writable table: RLS enabled, `revoke all … from anon`, `revoke truncate, references, trigger … from authenticated`, and four per-operation policies through `private.user_household_ids()` (`20261007120000_products_and_recipes.sql:148-179`).
- The isolation catch-all (`supabase/tests/household_isolation.sql:484-522`) automatically picks up every `public` table that has a `household_id` column. It checks four policies, no anon policy, and the `user_household_ids` substring. It does **not** check an owner predicate or any FK.
- The app-layer templates are:
  - `src/pages/api/household/redeem.ts`: auth guard, `formData()` try/catch, zod `safeParse`, `?error=` redirect.
  - `src/pages/dashboard.astro`: `<p data-testid=…>` lines, plain form POSTs, no React islands.
  - `src/lib/services/household.ts`: thin DTO mapping, with RLS doing the scoping.
- `src/middleware.ts:4`: `PROTECTED_ROUTES = ["/dashboard"]`, matched by prefix.
- `scripts/smoke.mjs` drives two cookie jars (A, B) through invite → redeem and parses `data-testid` lines with `testIdText`.

## Desired End State

- `public.macro_targets` exists on the hosted project, with one row per person. The owner can insert and update their own row, and both household members can read it. The partner cannot write it, and anon sees nothing.
- When someone redeems an invite, their targets row moves to the shared household in the same statement. No change to the definer function is needed.
- `/targets` (protected) shows:
  - a form pre-filled with your targets, which saves through `POST /api/targets`;
  - a read-only "Your partner" section with the partner's values, "Not set yet", or "Not linked yet";
  - a soft, non-blocking note when your four numbers are mutually inconsistent by more than 10%.
- `/dashboard` shows a `Targets: …` line and a link to `/targets`.
- `npm run test:rls` proves isolation, owner-only writes, partner visibility and "targets follow the redeemer". `npm run smoke` proves the same over HTTP, including B's pre-redemption targets arriving in the shared household.
- CLAUDE.md records the per-person composite-FK convention, so S-06 ratings inherit it.

### Key Discoveries

- `20261007120200_household_invites.sql:296-298`: the single membership update a composite `on update cascade` FK hooks into.
- `20261007120200_household_invites.sql:271-272`: the KD006 count uses a literal table list that "no test catches". Option A avoids adding another literal list (a per-table move step inside the function).
- `household_isolation.sql:251-281`: the id-indexed fixture loops need an `id` column. `macro_targets` has none, so it gets its own blocks.
- `household_isolation.sql:459-475`: the anon read loop. Add `'macro_targets'` to it.
- `household_isolation.sql:524-531`: the redemption section uses fresh users C/D and must stay after every block that reads `rls_test.a_household` / `b_household`.
- `smoke.mjs:245`: the debug id list to extend.

## What We're NOT Doing

- Target history or versioning. S-04 should snapshot the targets it solved against (research Open Question 1).
- Display names, A/B labels, partner email. The UI says "You" / "Your partner". S-03 should store meal eaters as `user_id`s (research §8).
- BMR/TDEE calculators, suggestions or onboarding prompts (PRD Non-Goals / Deferred).
- Any "clear my targets" UI. A DELETE policy exists for the catch-all and is harmless, but nothing in the UI exposes it.
- Partner editing of the other person's targets.
- An RPC or definer function. The write path is a direct RLS-guarded upsert.
- React islands, and i18n (strings stay English until S-14).
- Changes to `redeem_household_invite()`, the KD006 guard, the seed migrations or `test:seed`.

## Implementation Approach

The work follows S-01's order: schema and isolation proof first, then the app layer, then the HTTP smoke, then docs.

The one load-bearing design choice is **Option A** from the research. The table has a composite foreign key `(household_id, user_id) → public.household_members (household_id, user_id) on update cascade on delete cascade`. Referential-integrity actions run as the table owner and are not subject to RLS. So when `redeem_household_invite()` updates the membership row, the cascade rewrites `macro_targets.household_id` atomically. The same FK proves, at the schema level, that a targets row can exist only for a member of the household it names.

Decisions taken (all are the research's recommendations):

1. **Table shape.** PK `user_id`, one current row per person. Columns: `household_id`; `kcal int 1–9999`; `protein_g`, `fat_g`, `carbs_g int 0–999`, all `not null`; `updated_at timestamptz not null default now()`. "Not set" means the row does not exist.
2. **FKs.** The plain `household_id … references public.households on delete cascade` FK and its index are kept, as CLAUDE.md requires literally. The composite FK is added alongside them. `user_id` also references `auth.users on delete cascade`.
3. **RLS.**
   - Select is household-wide.
   - Insert, update and delete add `and user_id = (select auth.uid())` to the helper predicate.
   - Partners cannot write each other's row, because FR-004 says "**their** targets".
4. **Write path.** A direct upsert `onConflict: "user_id"` from a service. The service resolves the caller's `household_id` from their own `household_members` row. `updated_at` is set explicitly by the service, not by a trigger.
5. **Validation.** zod with a digits-only string regex before the number conversion, so an empty field can never coerce to `0`. Bounds are identical to the CHECK constraints.
6. **Response convention.** Redirect `/targets?saved=1` on success and `/targets?error=<msg>` on failure, the same as S-01.
7. **UI.** `.astro` only, with no island. The consistency hint is computed in the page with 4/4/9 factors and a 10% threshold. It never blocks saving.
8. **Assumption.** Deleting an account cascades its targets away through both FKs. The README smoke cleanup (`delete from auth.users …`) therefore covers targets with no change.
9. **Assumption.** On a validation error the redirect loses what the user typed, and the form re-fills from the saved row. HTML `required`/`min`/`max`/`step` catch almost all of these cases before submit, so the cost is acceptable without a stateful island.

## Critical Implementation Details

- **The cascade assertion must not be cut.** Postgres semantics say the `on update cascade` fires inside the definer function and bypasses RLS. The only proof on the hosted project is the isolation test's "D's targets follow D into C's household" block (Phase 1 §3). If it fails, do not work around it by editing `redeem_household_invite()`. Stop and revisit the design.
- **Order in the isolation test.** A/B targets fixtures and their assertions go in the pre-S-01 region, before the catch-all. D's targets row must be inserted (as postgres) **before** D's redemption call in the S-01 section, and checked in the "As postgres: the membership moved" block after it.
- **Empty-string pitfall.** `Number("") === 0` and `z.coerce.number()` accept `""`. A blank fat or carbs field would silently save `0`, which is valid. The schema must reject empty and non-digit strings before converting. Phase 3's smoke step proves it over HTTP.

## Phase 1: Schema, RLS and isolation coverage

### Overview

Create `public.macro_targets` with its policies and grants. Push it to the hosted project. Extend `household_isolation.sql` until it proves isolation, owner-only writes, partner visibility and the redemption cascade.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/20261008120000_macro_targets.sql`

**Intent**: Create the per-person targets table with the household and membership FKs, CHECK bounds, index, RLS, revokes and four policies. Include header comments explaining why the composite FK exists: it is what makes rows travel through `redeem_household_invite()`. The header also states: "Membership moves must stay a single `update … set household_id` of the `household_members` row; deleting and re-inserting a membership cascades away every per-person row for that user."

**Contract**:

```sql
create table public.macro_targets (
  user_id uuid primary key references auth.users on delete cascade,
  household_id uuid not null references public.households on delete cascade,
  kcal int not null check (kcal between 1 and 9999),
  protein_g int not null check (protein_g between 0 and 999),
  fat_g int not null check (fat_g between 0 and 999),
  carbs_g int not null check (carbs_g between 0 and 999),
  updated_at timestamptz not null default now(),
  constraint macro_targets_membership_fkey foreign key (household_id, user_id)
    references public.household_members (household_id, user_id)
    on update cascade on delete cascade
);
create index macro_targets_household_id_idx on public.macro_targets (household_id);
```

Then, following the products precedent:

- `enable row level security`;
- `revoke all … from anon`;
- `revoke truncate, references, trigger … from authenticated`;
- four policies `macro_targets_{select,insert,update,delete}_authenticated`, all `to authenticated`:
  - select `using (household_id in (select private.user_household_ids()))`;
  - insert `with check (household_id in (select private.user_household_ids()) and user_id = (select auth.uid()))`;
  - update with that same predicate in both `using` and `with check`;
  - delete `using` with the same predicate.

#### 2. Isolation test: A/B fixtures and per-user assertions

**File**: `supabase/tests/household_isolation.sql`

**Intent**: Seed one targets row each for A and B as postgres, in the F-02 setup region. Then assert, as user A, in the "products, recipe and invite tables are scoped" region:

- A sees exactly its own row and 0 of B's.
- A cannot update or delete B's row (0 rows affected).
- A cannot insert a row with `user_id = B`, neither with A's `household_id` nor with B's. Both probes must raise exactly `insufficient_privilege`; any other outcome (success, `unique_violation`, `foreign_key_violation`) raises. `foreign_key_violation` is acceptable only for an extra probe using a non-member `user_id`, if one is added.
- A can update its own row.

Add `'macro_targets'` to the anon read loop (`:464-465`). Do **not** add it to the id-indexed loops.

**Contract**: new `do $$ … $$` blocks in the file's existing idioms. Use a `when insufficient_privilege then null` handler (no other handler on the A→B insert probes, so any other SQLSTATE propagates) and a descriptive `raise exception` on failure. The B symmetric-read block gains a `macro_targets` count check.

#### 3. Isolation test: redemption carries targets

**File**: `supabase/tests/household_isolation.sql` (S-01 section)

**Intent**: Prove the composite cascade on the hosted project, plus partner read without partner write.

**Contract**:

- **Setup, as postgres, before D redeems:** insert D's targets row with `household_id = d_household`.
- **In the "As postgres: the membership moved" block after redemption**, assert:
  - D's row now has `household_id = c_household`, otherwise `raise exception 'redeem: targets did not follow the redeemer: D''s row is in household %, expected %', …`;
  - `d_household` holds 0 `macro_targets` rows.
- **New block, as C:** C sees D's row (count 1 for `user_id = D`), and C's update and delete on it affect 0 rows.
- **New block, as D:**
  - D's update of its own row affects 1 row.
  - D inserts `(user_id = C, household_id = c_household, …valid numbers…)` while C has no targets row. The composite FK allows that pair, so the owner predicate is the only defence: the insert must raise `insufficient_privilege` and nothing else. Catch only `when insufficient_privilege then null`; if the insert succeeds, `raise exception 'partner could insert targets for the other member'`. Any other SQLSTATE propagates.
- Update the final "Done" notice to mention macro targets.

### Success Criteria:

#### Automated Verification:

- Migration applies to the hosted project: `npx supabase db push`
- Isolation test passes against the pushed schema, including the catch-all and the redemption-cascade block: `npm run test:rls`
- Seed integrity is unaffected: `npm run test:seed`

#### Manual Verification:

- Temporarily insert `alter table public.macro_targets drop constraint macro_targets_membership_fkey;` directly after `begin;` in `household_isolation.sql`, run `npm run test:rls`, and confirm it fails with `redeem: targets did not follow the redeemer: …`. The plain `household_id` FK keeps D's row valid in `d_household`, so the row is stranded rather than erroring. Then revert the line. The file runs in a rolled-back transaction, so nothing persists on the hosted project; the DDL holds an `ACCESS EXCLUSIVE` lock on the new, still-empty table only for the test's duration. This confirms the assertion is not vacuous. (No scratch migration copy: the hosted project is the only database.)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: App layer — types, service, route, pages

### Overview

Add the DTOs, the service (read, save and pure helpers), `POST /api/targets`, the `/targets` page, route protection, and the dashboard summary line.

### Changes Required:

#### 1. Shared types

**File**: `src/types.ts`

**Intent**: Add the entity and input DTOs.

**Contract**:

- `MacroTargets { userId: string; kcal: number; proteinG: number; fatG: number; carbsG: number; updatedAt: string }`
- `MacroTargetsInput = Omit<MacroTargets, "userId" | "updatedAt">`

#### 2. Service

**File**: `src/lib/services/macro-targets.ts`

**Intent**: The single home for the targets queries, plus the pure display and consistency helpers that both pages use.

**Contract**:

- `getHouseholdMacroTargets(supabase): Promise<MacroTargets[]>` selects `user_id, kcal, protein_g, fat_g, carbs_g, updated_at` with no filter, because RLS scopes it. It throws on error and maps snake_case to camelCase at the boundary.
- `saveMyMacroTargets(supabase, userId, input: MacroTargetsInput): Promise<void>`:
  1. Reads `household_id` from `household_members` with `.eq("user_id", userId).single()`.
  2. Calls `upsert({ user_id, household_id, kcal, protein_g, fat_g, carbs_g, updated_at: new Date().toISOString() }, { onConflict: "user_id" })`.
  3. Throws on any error, including a `42501` (RLS `WITH CHECK`, the usual outcome) or `23503` from a redemption race.
- `formatMacroTargets(t: MacroTargetsInput): string` returns exactly `"2200 kcal · P 160 g · F 70 g · C 230 g"`. The smoke test matches this string.
- `macroKcalMismatch(t: MacroTargetsInput): number | null` returns the macro-derived kcal (`4·P + 4·C + 9·F`) when `|derived − kcal| / kcal > 0.10`, and `null` otherwise.

#### 3. API route

**File**: `src/pages/api/targets.ts`

**Intent**: Validate and save the caller's targets, cloned from `redeem.ts`'s structure: auth guard → `formData()` try/catch → `safeParse` → `createClient` null check → service call in try/catch with `console.error` → redirect.

**Contract**:

- `POST` only.
- Anonymous callers get `redirect("/auth/signin")`.
- Each field is `z.string().trim().regex(/^\d{1,4}$/)` piped to an integer with bounds matching the CHECKs: kcal 1–9999, others 0–999. The regex runs **before** any number conversion.
- Success redirects to `/targets?saved=1`.
- Both messages are named constants, and both are URL-encoded, matching `redeem.ts` (the en-dashes would otherwise make `Headers` throw and turn the redirect into a 500):
  - `INVALID_TARGETS = "Enter whole numbers: calories 1–9999, protein, fat and carbs 0–999."`
  - `SAVE_FAILED = "Your targets could not be saved. Please try again."`
- Validation or body failure: ``context.redirect(`/targets?error=${encodeURIComponent(INVALID_TARGETS)}`)``.
- Save failure: ``context.redirect(`/targets?error=${encodeURIComponent(SAVE_FAILED)}`)``.

#### 4. Route protection

**File**: `src/middleware.ts`

**Intent**: Add `"/targets"` to `PROTECTED_ROUTES`.

**Contract**: `PROTECTED_ROUTES = ["/dashboard", "/targets"]`.

#### 5. Targets page

**File**: `src/pages/targets.astro`

**Intent**: Server-rendered page, in the dashboard's visual style, with these parts:

- **"Your targets" form**: four `<input type="number" name="kcal|protein_g|fat_g|carbs_g" required min max step="1">` fields, pre-filled from your row, posting to `/api/targets`.
- **Read-only "Your partner" section.**
- **Status banners**: `saved=1` (emerald) and `error` (red), as on the dashboard.
- **Mismatch hint**: shown under the form when `macroKcalMismatch` is non-null for your saved row.
- **Back link** to `/dashboard`.

Your row and the partner's row are told apart with `Astro.locals.user.id` and `getCurrentHousehold()` members. Each service call is wrapped in try/catch with `console.error`. The two reads can fail independently:

- **Targets read fails:** `targets-mine` and `targets-partner` both read "Targets are unavailable right now.", and the form renders empty.
- **Household read fails but targets succeed:**
  - `targets-mine` renders normally.
  - `targets-partner` shows the partner's values if any visible row has `user_id ≠ Astro.locals.user.id`.
  - Otherwise `targets-partner` reads "Partner information is unavailable right now." It never shows "Not linked yet" or "Not set yet" in this case, so do not default `memberCount` to 0 the way `dashboard.astro:39` does.
- **Both reads succeed:** the behaviour in the contract below.

**Contract**:

- `<p data-testid="targets-mine">` shows `formatMacroTargets(mine)` or `Not set yet`.
- `<p data-testid="targets-partner">` shows:
  - `formatMacroTargets(partner)` when the partner has a row;
  - `Not set yet` when there are 2 members but the partner has no row;
  - `Not linked yet` when there is 1 member.
- Hint text: `Your macros add up to N kcal, which differs from your calorie target by more than 10%. The solver may not be able to hit all four.`
- Conditional classes go through `cn()`.

#### 6. Dashboard line

**File**: `src/pages/dashboard.astro`

**Intent**: Show your own targets summary and a link to edit it. Fetch it with `getHouseholdMacroTargets` in its own try/catch, matching the existing three.

**Contract**: add `<p data-testid="targets">`, placed after `library`. It shows one of:

- `Targets: ${formatMacroTargets(mine)}`
- `Targets: not set`
- `Targets are unavailable right now.`

Add an `<a href="/targets">` next to it ("Set targets" or "Edit targets").

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Type check passes: `npx astro check`
- Build succeeds: `npm run build`
- Existing smoke still passes against the dev server: `npm run smoke`

#### Manual Verification:

- Signed in alone, `/dashboard` shows "Targets: not set". Saving 2200/160/70/230 on `/targets` shows the green banner, the values in "Your targets", and "Not linked yet" for the partner.
- Saving 2000/50/10/50 shows the mismatch hint, and the save still succeeds.
- A blank fat field submitted with browser validation bypassed (devtools: remove `required`) shows the red error, and the saved values are unchanged.
- In a linked household, each partner sees the other's values read-only.
- `/targets` while signed out redirects to `/auth/signin`.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Smoke test — targets end to end, across a redemption

### Overview

Extend `scripts/smoke.mjs` so CI proves the HTTP flow, including B's pre-redemption targets arriving in the shared household. That is the cascade, seen over HTTP.

### Changes Required:

#### 1. New steps

**File**: `scripts/smoke.mjs`

**Intent**: Insert steps at the points below, reusing the existing `[name, run, expected]` tuple shape. Use RegExp `location` for exact redirects and string prefix for `?error=`.

**Contract** (A targets = 2200/160/70/230; B targets = 1800/120/60/180):

- **Early, B still anonymous:**
  - `GET /targets` → `302 /auth/signin`;
  - `POST /api/targets` → `302 /auth/signin`.
- **After A's sign-in:**
  - A's dashboard `targets` line reads `Targets: not set`.
  - A posts its values → `302` with location matching `/^\/targets\?saved=1$/`.
  - A's `/targets` shows `targets-mine` = `2200 kcal · P 160 g · F 70 g · C 230 g` and `targets-partner` = `Not linked yet`.
  - A posts with `fat_g: ""` → `302 /targets?error=` (the empty-string pitfall).
  - A posts with `kcal: "0"` → `302 /targets?error=`.
  - A's `/targets` still shows the original values.
  - A's dashboard `targets` line reads `Targets: 2200 kcal · …`.
- **After B signs in (lands on `/join`) and before B redeems:**
  - B posts its values → `302 /targets?saved=1`.
- **After redemption:**
  - A's `/targets` shows `targets-partner` = B's formatted values.
  - B's `/targets` shows `targets-mine` = B's values and `targets-partner` = A's values.
- Add `"targets"`, `"targets-mine"` and `"targets-partner"` to the debug id list (`smoke.mjs:245`).
- Update the header comment to mention S-02.

### Success Criteria:

#### Automated Verification:

- Smoke passes against the dev server: `npm run smoke`
- Smoke passes against the production preview: `npm run build && npm run preview`, then `BASE_URL=http://localhost:4321 npm run smoke`
- Lint passes: `npm run lint`

#### Manual Verification:

- Temporarily break the API's regex (for example, allow empty strings) and confirm the `fat_g: ""` step fails. Then revert.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Documentation and conventions

### Overview

Record the new per-person convention and route, and close the change identity.

### Changes Required:

#### 1. Project rules

**File**: `CLAUDE.md`

**Intent**: In §Auth flow, extend the per-person data bullet as follows:

- Per-person tables carry PK/unique `user_id` plus a composite FK `(household_id, user_id) → public.household_members (household_id, user_id) on update cascade on delete cascade`. That FK is what makes them travel through `redeem_household_invite()`, so never add a per-table move step to the function. Membership moves must stay a single `update … set household_id` of the `household_members` row; deleting and re-inserting a membership cascades away every per-person row for that user.
- Write policies add `user_id = (select auth.uid())` to the helper predicate, so the partner can read but not write.
- `macro_targets` is the first such table.

Also add `/targets` and `POST /api/targets` to the auth-flow file list.

**Contract**: one edited bullet and one added bullet in §Auth flow. No hard-rule changes.

#### 2. README

**File**: `README.md`

**Intent**:

- Add a `/targets` row to the Auth routes table: "Your own daily macro targets (editable) and your partner's (read-only)".
- Mention the targets steps in the Smoke test paragraph.
- Note in the cleanup section that `delete from auth.users …` also removes smoke targets. No query changes.

**Contract**: table row plus two sentence-level edits.

#### 3. Change identity

**File**: `context/changes/set-daily-macro-targets/change.md`

**Intent**: Set `status: planned` (done at plan time). `/10x-implement` advances it afterwards.

### Success Criteria:

#### Automated Verification:

- Prettier formatting holds: `npx prettier --check CLAUDE.md README.md`

#### Manual Verification:

- A reader of CLAUDE.md alone could build S-06 ratings without rediscovering the stranding bug.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### SQL (`supabase/tests/household_isolation.sql`, rolled back)

- A/B isolation: own row visible, other household's row invisible.
- Owner-only writes: no update or delete on others' rows; no insert with a foreign `user_id` or a foreign household. The composite FK also rejects a non-member `(household_id, user_id)` pair.
- Anon sees 0 rows.
- The catch-all automatically checks the four policies and the helper substring.
- Redemption cascade: D's row follows D, the origin household is left with 0 rows, partner C reads but cannot write, and D can still write.

### HTTP (`scripts/smoke.mjs`)

- Anonymous access is redirected for both the page and the API.
- Valid save, then pre-filled display, then dashboard summary.
- Invalid inputs (empty string, out of range) are rejected without changing the stored values.
- Pre-redemption targets are visible to the partner after redemption.

### Manual Testing Steps

1. Sign up, open `/targets`, save values, and confirm the banner, the form pre-fill and the dashboard line.
2. Enter inconsistent values and confirm the hint appears and the save still works.
3. Link a second account that had already set targets. Confirm each partner sees the other's values read-only, and that the second account's values survived the link.

## Performance Considerations

There are at most two rows per household. `/targets` and `/dashboard` each add one indexed select. The cascade adds one indexed row update to an already-rare, irreversible operation. Nothing to optimise.

## Migration Notes

The migration is additive, with no backfill. Existing accounts simply have no row ("Not set yet"). Per CLAUDE.md, run `npx supabase db push` and then `npm run test:rls` **before merging**, because CI tests the already-deployed schema. Rollback is `drop table public.macro_targets` (postgres), which loses only targets data.

## References

- Research: `context/changes/set-daily-macro-targets/research.md`
- Roadmap S-02: `context/foundation/roadmap.md:130-140`; PRD FR-004 `context/foundation/prd.md:84`, access control `:150-151`
- Membership move: `supabase/migrations/20261007120200_household_invites.sql:296-298`
- Policy and grant template: `supabase/migrations/20261007120000_products_and_recipes.sql:148-179`
- Route template: `src/pages/api/household/redeem.ts:7-53`
- Page template: `src/pages/dashboard.astro:39-103`
- Prior plan (structure, conventions): `context/archive/2026-10-07-link-partner-household/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema, RLS and isolation coverage

#### Automated

- [x] 1.1 Migration applies to the hosted project: `npx supabase db push`
- [x] 1.2 Isolation test passes against the pushed schema, including the catch-all and the redemption-cascade block: `npm run test:rls`
- [x] 1.3 Seed integrity is unaffected: `npm run test:seed`

#### Manual

- [x] 1.4 Cascade assertion proven non-vacuous (fails when `macro_targets_membership_fkey` is dropped in-transaction, passes after revert)

> Implementation note (1.4, performed by the agent, 2026-10-08): run on a scratch copy of `household_isolation.sql` rather than editing the tracked file, with the `drop constraint` line inserted after `begin;`. The first failure was the extra composite-FK probe added in the S-01 setup block (C's row in D's household, `foreign_key_violation` expected), so that probe is non-vacuous too. With that probe neutralised in the scratch copy, the run failed with `redeem: targets did not follow the redeemer: D's row is in household …, expected …`. The tracked file passes unchanged, and `macro_targets_membership_fkey` is still present on the hosted project (the transaction rolled back).
>
> Assumption (Phase 1): the plan names "a non-member `user_id` probe" as optional. It was added as postgres in the S-01 setup block (C has no row yet, so no unique violation can mask the FK), not as user A.

### Phase 2: App layer — types, service, route, pages

#### Automated

- [ ] 2.1 Lint passes: `npm run lint`
- [ ] 2.2 Type check passes: `npx astro check`
- [ ] 2.3 Build succeeds: `npm run build`
- [ ] 2.4 Existing smoke still passes against the dev server: `npm run smoke`

#### Manual

- [ ] 2.5 Solo account: not set → save → banner, values, "Not linked yet"
- [ ] 2.6 Inconsistent values show the mismatch hint and still save
- [ ] 2.7 Blank field with browser validation bypassed shows the error and keeps saved values
- [ ] 2.8 Linked partners see each other's values read-only
- [ ] 2.9 `/targets` signed out redirects to `/auth/signin`

### Phase 3: Smoke test — targets end to end, across a redemption

#### Automated

- [ ] 3.1 Smoke passes against the dev server: `npm run smoke`
- [ ] 3.2 Smoke passes against the production preview
- [ ] 3.3 Lint passes: `npm run lint`

#### Manual

- [ ] 3.4 Empty-string smoke step proven non-vacuous

### Phase 4: Documentation and conventions

#### Automated

- [ ] 4.1 Prettier formatting holds: `npx prettier --check CLAUDE.md README.md`

#### Manual

- [ ] 4.2 CLAUDE.md per-person convention is sufficient for S-06 on its own
