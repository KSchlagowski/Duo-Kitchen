# Rules for AI

## Hard rules

- **Supabase RLS**: every new table must enable RLS with granular per-operation, per-role policies. Migrations go in `supabase/migrations/` named `YYYYMMDDHHmmss_short_description.sql`.
- **Household-scoped tables**: every household-owned table has `household_id uuid not null references public.households on delete cascade` (indexed) and per-operation RLS policies `to authenticated` with `using` / `with check (household_id in (select private.user_household_ids()))`. No `anon` policies. Never query `household_members` directly inside a policy — always go through `private.user_household_ids()`. Extend the isolation test (`supabase/tests/household_isolation.sql`) for each new table. CI runs that test against the already-deployed schema, not the branch's migrations — so before merging any migration, run `npx supabase db push` and then `npm run test:rls`.
- **Secrets**: `SUPABASE_URL` / `SUPABASE_KEY` are server-only — read them via `astro:env/server` (declared in `astro.config.mjs` `env.schema`), never `import.meta.env` in client code. Local Cloudflare secrets go in `.dev.vars` (gitignored).
- **Supabase is cloud-only**: always work against the hosted Supabase project, ref `tvmfkhnxxsnmvogplknz` (`SUPABASE_URL=https://tvmfkhnxxsnmvogplknz.supabase.co`; link with `npx supabase link --project-ref tvmfkhnxxsnmvogplknz`). Do not run a local Supabase stack — no `npx supabase start` / `stop` / `db reset`, no Docker. Apply migrations to the cloud project with `npx supabase db push`; run SQL with `npx supabase db query --linked`. This applies to CI too.
- **Client-callable Postgres functions live in `public`**: the `private` schema is deliberately not API-exposed, so a definer helper there is unreachable as an RPC endpoint — `private` is for internals only (`private.user_household_ids()`, `private.seed_household()`, the sign-up trigger). Anything a client calls through `supabase.rpc(...)` must be `create function public.<name>` with `security definer`, `set search_path = ''`, **every** name fully qualified (`public.household_members`, `auth.uid()`), followed by `revoke execute on function … from public, anon;` then `grant execute on function … to authenticated;`. The revoke is mandatory, not cosmetic: Supabase's default privileges grant `execute` on new `public` functions to `anon`. Validation errors are raised with distinct SQLSTATEs in class `KD` (see `supabase/migrations/20261007120200_household_invites.sql`), never a bare `P0001`, so tests can assert the precise reason and the UI can map each to its own message. The isolation catch-all inspects **tables only**, so every new function's grants need their own assertion.
- **Write-revoked tables**: `households`, `household_members` and `household_invites` are read-only for clients — all writes go through security-definer functions. `household_invites` nonetheless carries all four per-operation policies, because the catch-all in `supabase/tests/household_isolation.sql` reads `pg_policies` and would reject the table without them; the `revoke insert, update, delete, truncate … from authenticated` is what actually makes three of those policies unreachable. **Policies and grants are independent levers, and both halves are load-bearing — do not "simplify" by dropping either.** The isolation test asserts the revokes directly so this cannot be undone silently.
- **Tailwind class merging**: use the `cn()` helper from `@/lib/utils` for conditional/merged class names. Do not concatenate class strings manually.

## Commands

Scripts: @package.json. Project-specific notes:

- `npm run smoke` — dependency-free auth-flow smoke test (`scripts/smoke.mjs`) against a running server, `BASE_URL` env (default `http://localhost:4321`). Run after dependency upgrades; CI runs it against the production preview backed by the hosted Supabase project.
- `npm run test:rls` — household isolation test (`supabase/tests/household_isolation.sql`) against the hosted Supabase project (`--linked`); runs in a rolled-back transaction so it commits nothing, fails with a descriptive error on any broken assertion. CI runs it in the smoke job.
- `npm run test:seed` — seed integrity test (`supabase/tests/seed_integrity.sql`) against the hosted project (`--linked`), rolled back: seed content covers every solver rule (rounding steps, pieces, raw/cooked, division modes, step timings, meal types, aisles, macro levers) and copies into a household faithfully. Run it after every seed content migration; CI runs it in the smoke job.
- Pre-commit hooks: husky + lint-staged runs `eslint --fix` on `*.{ts,tsx,astro}` and `prettier --write` on `*.{json,css,md}`.

## Architecture

**Astro 7 SSR app** (`output: "server"`) with React 19 islands, Tailwind 4, Supabase auth, and shadcn/ui components. Deployed to Cloudflare Workers.

### Auth flow

- `src/lib/supabase.ts` — creates a Supabase SSR client using `@supabase/ssr` with cookie-based sessions.
- `src/middleware.ts` — runs on every request, resolves the current user, attaches to `context.locals.user`. Redirects unauthenticated users away from routes listed in `PROTECTED_ROUTES`.
- API endpoints: `src/pages/api/auth/{signin,signup,signout}.ts`
- Auth pages: `src/pages/auth/{signin,signup,confirm-email}.astro`
- Protected page example: `src/pages/dashboard.astro`
- Invite / redemption (S-01): `src/pages/api/household/{invite,redeem}.ts`, the unprotected `src/pages/join.astro`, and `src/lib/services/invites.ts` (the single home for both RPC calls and for mapping the `KD0xx` SQLSTATEs to user-facing messages). `/join` is intentionally **not** in `PROTECTED_ROUTES`: besides sign-in and sign-up it is the one page an unauthenticated visitor may reach. It stores the code in an `httpOnly` `dk_invite` cookie (`src/lib/invite-cookie.ts`, 7 days, matching the invite TTL, `sameSite: "lax"` because the link is followed from an email client), which is what carries the code across the sign-up → confirm-email → sign-in detour; `/api/auth/signin` redirects to `/join` instead of `/` while that cookie is present. Redemption is a deliberate **POST**, never a one-click GET, because no application path can undo it.
- Households: `public.households` / `public.household_members` (one household per account, enforced by `household_members.user_id unique`); the sign-up trigger `private.handle_new_user()` creates a household of one for every new account. Clients cannot write these tables directly. Linking a partner is therefore an **update** of one membership row, done by `public.redeem_household_invite()`; the old household is left intact and memberless and recorded in `household_invites.redeemed_from_household_id`, which the README cleanup query relies on to spare it. There is no leave/unlink path, so a redemption needs `postgres` to undo.
- Per-person data (macro targets, ratings — S-02 onward) must be keyed on `user_id` and scoped by `household_id` for RLS, so it travels with the person through a redemption and stays visible to the partner (PRD §Access Control). Per-person tables carry PK/unique `user_id` plus a composite FK `(household_id, user_id) → public.household_members (household_id, user_id) on update cascade on delete cascade` (alongside the plain `household_id` FK the hard rule requires). That FK is what makes the rows travel through `redeem_household_invite()` — referential actions run as the table owner, outside RLS — so never add a per-table move step to the function. Membership moves must stay a single `update … set household_id` of the `household_members` row; deleting and re-inserting a membership cascades away every per-person row for that user. Write policies (insert/update/delete) add `and user_id = (select auth.uid())` to the helper predicate, so the partner can read but not write; the isolation catch-all does not check that owner predicate, so each table needs its own strict `insufficient_privilege` insert probes. `macro_targets` (`supabase/migrations/20261008120000_macro_targets.sql`) is the first such table.
- Macro targets (S-02): the protected `src/pages/targets.astro` (your own targets as a form, your partner's read-only), `POST /api/targets` (`src/pages/api/targets.ts`, zod with a digits-only regex **before** number conversion so a blank field can never coerce to `0`), and `src/lib/services/macro-targets.ts` (reads, the upsert, `formatMacroTargets()` — whose output the smoke test matches — and the soft kcal-mismatch hint). The dashboard shows a `Targets:` summary line.
- Products and recipes (`products`, `recipes`, `recipe_components`, `recipe_ingredients`, `recipe_steps`) are household-scoped copies of the `private.seed_*` templates, made by `private.seed_household()` from the sign-up trigger; each copy keeps `seed_id` → its template row. Child tables carry `household_id` with composite FKs to their parent, so cross-household references are impossible. `seed_household()` is for new or empty households only: once households can edit or delete seed rows, never re-run it on existing households (it re-inserts deleted seed rows). Seed content changes go in a new data-only migration that inserts the new templates and copies only those new rows into existing households with targeted `insert … select` keyed on the new seed ids.

### Key conventions

- **Astro vs React**: use a `.tsx` island only if the component uses state, effects, or browser event handlers; hydrate with the narrowest `client:*` directive (prefer `client:visible`/`client:idle` over `client:load`). Everything else is `.astro`.
- **shadcn/ui**: components live in `src/components/ui/`, "new-york" style variant. Install new ones with `npx shadcn@latest add [name]`.
- **API routes**: use uppercase `GET`, `POST` exports; validate input with zod.
- **React**: no Next.js directives ("use client" etc.). Extract hooks to `src/components/hooks/`.
- **Services/helpers**: any Supabase query or domain logic used by more than one page or API route goes in `src/lib/services/`. Pages and API routes must not call `supabase.from(...)` directly. Generic helpers go in `src/lib/`.
- **Shared types** (entities, DTOs) go in `src/types.ts`.

### Environment

Setup and deploy: @README.md

## CI

`.github/workflows/ci.yml` runs on every push and PR to `main`:

- **ci** — lint, `astro check`, build. Requires `SUPABASE_URL` and `SUPABASE_KEY` repository secrets.
- **smoke** — household isolation test + production preview + `npm run smoke`, all against the hosted Supabase project. Requires `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` repository secrets.
