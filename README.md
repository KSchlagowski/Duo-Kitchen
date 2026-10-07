# 10x Astro Starter

![](./public/template.png)

A modern, opinionated starter template for building fast, accessible web applications.

**Live app:** https://duo-kitchen.mediewilnp.workers.dev

## Tech Stack

- [Astro](https://astro.build/) v7 - Modern web framework with server-first rendering
- [React](https://react.dev/) v19 - UI library for interactive components
- [TypeScript](https://www.typescriptlang.org/) v6 - Type-safe JavaScript
- [Tailwind CSS](https://tailwindcss.com/) v4 - Utility-first CSS framework
- [Supabase](https://supabase.com/) - Authentication and backend-as-a-service
- [Cloudflare Workers](https://workers.cloudflare.com/) - Edge deployment runtime

## Prerequisites

- Node.js v22.14.0 (as specified in `.nvmrc`)
- npm (comes with Node.js)

## Getting Started

1. Clone the repository:

```bash
git clone https://github.com/przeprogramowani/10x-astro-starter.git
cd 10x-astro-starter
```

2. Install dependencies:

```bash
npm install
```

3. Set up Supabase and configure environment variables — see [Supabase Configuration](#supabase-configuration) below.

4. Create a `.dev.vars` file for local Cloudflare dev secrets:

```bash
cp .env.example .dev.vars
```

5. Run the development server:

```bash
npm run dev
```

## Available Scripts

- `npm run dev` - Start development server (Cloudflare workerd runtime)
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint with type-checked rules
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Run Prettier
- `npm run smoke` - Smoke test the auth flow against a running server (`BASE_URL`, defaults to `http://localhost:4321`)
- `npm run test:rls` - Run the household isolation (RLS) test against the linked Supabase project (`supabase/tests/household_isolation.sql`); it runs in a rolled-back transaction, so it leaves no data behind
- `npm run test:seed` - Run the seed integrity test against the linked Supabase project (`supabase/tests/seed_integrity.sql`): checks that the seeded products and recipes cover every solver rule and copy correctly into a household; also rolled back

## Project Structure

```md
.
├── src/
│ ├── layouts/ # Astro layouts
│ ├── pages/ # Astro pages
│ │ └── api/ # API endpoints
│ ├── components/ # UI components (Astro & React)
│ └── assets/ # Static assets
├── public/ # Public assets
├── wrangler.jsonc # Cloudflare Workers config
```

## Supabase Configuration

This project uses [Supabase](https://supabase.com/) for authentication. Environment variables are declared via Astro's `astro:env` schema and are treated as **server-only secrets** — they are never exposed to the client.

### Setup (hosted project)

This project uses a hosted Supabase project only.

1. Create your `.env` file:

```bash
cp .env.example .env
```

2. Add these variables to your `.env` and `.dev.vars` files:

| Variable       | Description                                                |
| -------------- | ---------------------------------------------------------- |
| `SUPABASE_URL` | Project URL from Supabase dashboard → Settings → API       |
| `SUPABASE_KEY` | `anon` public key from Supabase dashboard → Settings → API |

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_KEY=<anon-key>
```

3. Link the Supabase CLI to the project (once):

```bash
npx supabase link --project-ref <project-ref>
```

Database migrations live in `supabase/migrations/`. Apply new ones to the hosted project with:

```bash
npx supabase db push
```

### Email confirmation

By default Supabase requires email confirmation before a user can sign in. To skip this during development:

1. Open the Supabase dashboard for your project
2. Go to **Authentication → Email → Confirm email**
3. Toggle it **off**

Users can then sign in immediately after sign-up without clicking a confirmation link.

### Auth routes

| Route                 | Description                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| `/auth/signin`        | Email/password sign-in form                                             |
| `/auth/signup`        | Email/password sign-up form                                             |
| `/auth/confirm-email` | Post-signup "check your inbox" page                                     |
| `/join`               | Invite redemption — intentionally **unprotected** (see below)           |
| `/dashboard`          | Example protected page (redirects to `/auth/signin` if unauthenticated) |

Route protection is handled in `src/middleware.ts`. Add paths to the `PROTECTED_ROUTES` array there to require authentication.

`/join` is deliberately left out of `PROTECTED_ROUTES`: an invited partner has to be able to open the link before they have an account. It takes the code from `?code=` or from the `httpOnly` `dk_invite` cookie it sets, and that cookie is what survives the sign-up → confirm-email → sign-in round trip — while it is present, `/api/auth/signin` redirects to `/join` instead of `/`. Redemption itself always takes an explicit POST, because no application path can undo it.

## Deployment

This project deploys to [Cloudflare Workers](https://workers.cloudflare.com/). The production app is live at https://duo-kitchen.mediewilnp.workers.dev.

1. Build the project:

```bash
npm run build
```

2. Deploy with Wrangler:

```bash
npx wrangler deploy
```

Set `SUPABASE_URL` and `SUPABASE_KEY` as secrets in your Cloudflare dashboard or via `npx wrangler secret put`.

## Smoke test

`scripts/smoke.mjs` is a dependency-free Node script that walks the whole auth flow (sign-up, sign-in, protected page, sign-out) over HTTP. Run it against the dev server or the production preview after dependency upgrades:

```bash
npm run dev            # or: npm run build && npm run preview
BASE_URL=http://localhost:4321 npm run smoke
```

It needs the hosted Supabase project with email confirmation disabled. It drives two independent
sessions (one cookie jar each) so it can prove the S-01 flow end to end: the first account generates
an invite code, the second opens the link while signed out, signs up, signs in (landing on `/join`
rather than `/`, from the `dk_invite` cookie), redeems, and both dashboards then show the same
household with `2 members` and the same library counts.

> **Note:** this script exists primarily to guard the development of the starter itself — it is a fast sanity check that dependency upgrades did not break the build, the Cloudflare adapter or the Supabase auth flow. It is **not** a substitute for a real test suite. Once you build your own product on top of this starter, add proper tests (unit, integration, end-to-end) suited to your application.

## CI

GitHub Actions runs two jobs on every push and PR to `main`:

- **ci** — lint, `astro check` and build. Configure `SUPABASE_URL` and `SUPABASE_KEY` as repository secrets for the build step.
- **smoke** — links the Supabase CLI to the hosted project, runs the household isolation test and the seed integrity test, builds, serves the production preview on the Cloudflare runtime and runs `npm run smoke` against it (including a check that the new account's dashboard shows the seeded recipe library, and that two accounts can be linked into one household). Requires the `SUPABASE_URL` and `SUPABASE_KEY` secrets plus `SUPABASE_ACCESS_TOKEN` (a Supabase personal access token) and `SUPABASE_PROJECT_REF`.

### Cleaning up after smoke runs

Each run signs up **two** accounts, `smoke-<timestamp>@example.com` and `smoke-b-<timestamp>@example.com`, and leaves **two** households behind: the shared one both accounts end up in, and the second account's pre-redemption household, which S-01 preserves memberless with its ~170 seeded rows intact. So each run adds roughly 340 rows, not 170.

> **⚠️ Do not use the obvious memberless-household cleanup query.** Since S-01, a memberless household is no longer necessarily garbage: `redeem_household_invite()` deliberately leaves the redeemer's old household intact so their pre-redemption data is never silently destroyed, and `household_invites.redeemed_from_household_id` is the only record of which household that was. A bare `delete … where not exists (… household_members …)` deletes exactly those preserved households, cascading away a real partner's products and recipes.

Delete the accounts first:

```sql
delete from auth.users where email like 'smoke-%@example.com';
```

That removes the accounts and their memberships but leaves the households orphaned. Then remove the memberless households, **sparing any that are still referenced as a redemption origin**:

```sql
delete from public.households h
where not exists (select 1 from public.household_members m where m.household_id = h.id)
  and not exists (select 1 from public.household_invites i where i.redeemed_from_household_id = h.id);
```

Run that **until it deletes 0 rows**. It needs more than one pass by design: deleting a shared household cascades its `household_invites` rows, and only then is the pre-redemption household it pointed at released for the next pass.

## License

MIT
