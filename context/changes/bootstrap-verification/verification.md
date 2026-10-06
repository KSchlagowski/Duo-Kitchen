---
bootstrapped_at: 2026-10-06T16:44:27Z
starter_id: 10x-astro-starter
starter_name: 10x Astro Starter (Astro + Supabase + Cloudflare)
project_name: duo-kitchen
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: npm audit --json
---

# Bootstrap verification — duo-kitchen

## Hand-off

```yaml
---
starter_id: 10x-astro-starter
package_manager: npm
project_name: duo-kitchen
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: true
  has_background_jobs: false
---
```

**Why this stack**

Duo Kitchen is an installable web app for one couple with a one-week, full-time MVP budget, so the deciding factors were speed to first deploy and a starter that already includes accounts, a database and edge hosting. The 10x Astro Starter is the default recommendation for a web app in JavaScript/TypeScript, passes all four agent-friendly checks, and matches the earlier concept decisions (Astro front end, Supabase for Postgres and email + password auth). Supabase row-level security will enforce household-scoped data access, and should be set up from the first migration. Deployment uses the starter's default, Cloudflare Pages, instead of the Vercel option in the concept doc. Because of the edge runtime, the deterministic LP macro solver and the scheduler must stay fast, using pure JS or WASM. The AI flag covers the external Claude agent, which connects through an MCP endpoint that has to be added by hand. The app itself makes no LLM calls for solving or scheduling. There are no payments, realtime features or background jobs. CI runs on GitHub Actions and deploys automatically on merge to main.

## Pre-scaffold verification

| Signal      | Value                                                       | Severity | Notes                                              |
| ----------- | ----------------------------------------------------------- | -------- | -------------------------------------------------- |
| npm package | not run                                                     | —        | cmd_template starts with `git clone`; no npm CLI    |
| GitHub repo | przeprogramowani/10x-astro-starter last pushed 2026-09-12   | fresh    | from card.docs_url                                 |

Local toolchain at scaffold time: node v24.14.0, npm 11.18.0 (card pins node 22; `.nvmrc` shipped by the starter).

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone
**Exit code**: 0
**Files moved**: 51 (plus `node_modules/`)
**Conflicts (.scaffold siblings)**: none
**.gitignore handling**: moved silently (absent in cwd)
**.bootstrap-scaffold cleanup**: deleted (cloned `.git/` removed before move-up; existing cwd `.git/`, `context/`, `docs/`, `.claude/` untouched)

Install notes:
- npm 11 `allow-scripts` skipped postinstall scripts for `esbuild@0.28.1`, `esbuild@0.28.2`, `workerd@1.20260911.1`. If `astro dev` / `wrangler` complain about missing binaries, run `npm install-scripts approve <pkg>` then reinstall.
- The starter ships its own `AGENTS.md`, `CLAUDE.md` and `.github/workflows/ci.yml` — these came from upstream, not from bootstrapper.

Files moved:

```
.env.example
.github/workflows/ci.yml
.gitignore
.husky/pre-commit
.nvmrc
.prettierrc.json
.vscode/extensions.json
.vscode/launch.json
.vscode/settings.json
AGENTS.md
astro.config.mjs
CLAUDE.md
components.json
eslint.config.js
package-lock.json
package.json
public/.assetsignore
public/favicon.png
public/template.png
README.md
scripts/smoke.mjs
src/components/auth/FormField.tsx
src/components/auth/PasswordToggle.tsx
src/components/auth/ServerError.tsx
src/components/auth/SignInForm.tsx
src/components/auth/SignUpForm.tsx
src/components/auth/SubmitButton.tsx
src/components/Banner.astro
src/components/Topbar.astro
src/components/ui/button.tsx
src/components/ui/LibBadge.astro
src/components/Welcome.astro
src/env.d.ts
src/layouts/Layout.astro
src/lib/config-status.ts
src/lib/supabase.ts
src/lib/utils.ts
src/middleware.ts
src/pages/api/auth/signin.ts
src/pages/api/auth/signout.ts
src/pages/api/auth/signup.ts
src/pages/auth/confirm-email.astro
src/pages/auth/signin.astro
src/pages/auth/signup.astro
src/pages/dashboard.astro
src/pages/index.astro
src/styles/global.css
supabase/.gitignore
supabase/config.toml
tsconfig.json
wrangler.jsonc
```

## Post-scaffold audit

**Tool**: npm audit --json (exit 1 — informational)
**Summary**: 0 CRITICAL, 10 HIGH, 2 MODERATE, 0 LOW
**Direct vs transitive**: 0/2/0/0 direct of total 0/10/2/0 — the two direct entries (`wrangler`, `@astrojs/cloudflare`) are flagged only through their own dependencies (miniflare → undici/sharp, @cloudflare/vite-plugin).

> Note: npm's suggested fix for the wrangler / @astrojs/cloudflare chain is a semver-major **downgrade** (wrangler@4.15.2, @astrojs/cloudflare@12.6.13) from the installed wrangler ^4.131.1 / @astrojs/cloudflare ^14.3.1. Do not apply `npm audit fix --force`; wait for upstream releases or use `overrides` for undici/sharp. Most of these are dev/build-time tooling (wrangler, miniflare, vite plugin, source-map-js).

#### CRITICAL findings

None.

#### HIGH findings

- **@astrojs/cloudflare** (direct) >=12.6.8 — via @cloudflare/vite-plugin, wrangler. npm fix: 12.6.13 (major downgrade).
- **wrangler** (direct) >=4.16.0 — via miniflare. npm fix: 4.15.2 (major downgrade).
- **@cloudflare/vite-plugin** (transitive) — via miniflare, wrangler.
- **miniflare** (transitive) — via sharp, undici.
- **undici** 7.0.0–7.29.0 (transitive) — multiple advisories: WebSocket/decompression DoS, response splitting via retry interceptor, Set-Cookie cache disclosure, TLS validation bypass in BalancedPool, and others.
- **sharp** <0.35.5 (transitive) — librsvg dependency CVE-2026-96889.
- **brace-expansion** <=1.1.20 \|\| 4.0.0–5.0.11 (transitive) — CPU / stack-exhaustion DoS. Fix available (non-breaking).
- **devalue** <=5.9.2 (transitive) — uneval/stringify amplification and `__proto__` rejection bypass. Fix available (non-breaking).
- **http-cache-semantics** <=4.2.0 (transitive) — max-stale handling may disclose cross-user cached responses. Fix available (non-breaking).
- **source-map-js** 1.0.0–1.2.1 (transitive) — event-loop DoS via indexed source-map offsets. Fix available (non-breaking).

#### MODERATE findings

- **fast-uri** 3.0.0–3.1.7 (transitive) — inconsistent host case normalization. Fix available (non-breaking).
- **smol-toml** <=1.8.0 (transitive) — quadratic-time parse(). Fix available (non-breaking).

#### LOW / INFO findings

None.

## Hints recorded but not acted on

| Hint                    | Value                 |
| ----------------------- | --------------------- |
| bootstrapper_confidence | first-class           |
| quality_override        | false                 |
| path_taken              | standard              |
| self_check_answers      | null                  |
| team_size               | solo                  |
| deployment_target       | cloudflare-pages      |
| ci_provider             | github-actions        |
| ci_default_flow         | auto-deploy-on-merge  |
| has_auth                | true                  |
| has_payments            | false                 |
| has_realtime            | false                 |
| has_ai                  | true                  |
| has_background_jobs     | false                 |

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- `git init` (if you have not already) to start your own repo history.
- Review any `.scaffold` siblings the conflict policy created and decide which version of each file to keep.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log.
