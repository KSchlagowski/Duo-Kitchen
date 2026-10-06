# Rules for AI

## Hard rules

- **Supabase RLS**: every new table must enable RLS with granular per-operation, per-role policies. Migrations go in `supabase/migrations/` named `YYYYMMDDHHmmss_short_description.sql`.
- **Secrets**: `SUPABASE_URL` / `SUPABASE_KEY` are server-only — read them via `astro:env/server` (declared in `astro.config.mjs` `env.schema`), never `import.meta.env` in client code. Local Cloudflare secrets go in `.dev.vars` (gitignored).
- **Tailwind class merging**: use the `cn()` helper from `@/lib/utils` for conditional/merged class names. Do not concatenate class strings manually.

## Commands

Scripts: @package.json. Project-specific notes:

- `npm run smoke` — dependency-free auth-flow smoke test (`scripts/smoke.mjs`) against a running server, `BASE_URL` env (default `http://localhost:4321`). Run after dependency upgrades; CI runs it against the production preview with a local Supabase.
- Pre-commit hooks: husky + lint-staged runs `eslint --fix` on `*.{ts,tsx,astro}` and `prettier --write` on `*.{json,css,md}`.

## Architecture

**Astro 7 SSR app** (`output: "server"`) with React 19 islands, Tailwind 4, Supabase auth, and shadcn/ui components. Deployed to Cloudflare Workers.

### Auth flow

- `src/lib/supabase.ts` — creates a Supabase SSR client using `@supabase/ssr` with cookie-based sessions.
- `src/middleware.ts` — runs on every request, resolves the current user, attaches to `context.locals.user`. Redirects unauthenticated users away from routes listed in `PROTECTED_ROUTES`.
- API endpoints: `src/pages/api/auth/{signin,signup,signout}.ts`
- Auth pages: `src/pages/auth/{signin,signup,confirm-email}.astro`
- Protected page example: `src/pages/dashboard.astro`

### Key conventions

- **Astro vs React**: use a `.tsx` island only if the component uses state, effects, or browser event handlers; hydrate with the narrowest `client:*` directive (prefer `client:visible`/`client:idle` over `client:load`). Everything else is `.astro`.
- **shadcn/ui**: components live in `src/components/ui/`, "new-york" style variant. Install new ones with `npx shadcn@latest add [name]`.
- **API routes**: use uppercase `GET`, `POST` exports; validate input with zod.
- **React**: no Next.js directives ("use client" etc.). Extract hooks to `src/components/hooks/`.
- **Services/helpers**: any Supabase query or domain logic used by more than one page or API route goes in `src/lib/services/`. Pages and API routes must not call `supabase.from(...)` directly. Generic helpers go in `src/lib/`.
- **Shared types** (entities, DTOs) go in `src/types.ts`.

### Environment

Setup, local Supabase, and deploy: @README.md

## CI

`.github/workflows/ci.yml` runs on every push and PR to `main`:

- **ci** — lint, `astro check`, build. Requires `SUPABASE_URL` and `SUPABASE_KEY` repository secrets.
- **smoke** — local Supabase + production preview + `npm run smoke`. No secrets required.
