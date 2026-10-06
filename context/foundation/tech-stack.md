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

## Why this stack

Duo Kitchen is an installable web app for one couple with a one-week, full-time MVP budget, so the deciding factors were speed to first deploy and a starter that already includes accounts, a database and edge hosting. The 10x Astro Starter is the default recommendation for a web app in JavaScript/TypeScript, passes all four agent-friendly checks, and matches the earlier concept decisions (Astro front end, Supabase for Postgres and email + password auth). Supabase row-level security will enforce household-scoped data access, and should be set up from the first migration. Deployment uses the starter's default, Cloudflare Pages, instead of the Vercel option in the concept doc. Because of the edge runtime, the deterministic LP macro solver and the scheduler must stay fast, using pure JS or WASM. The AI flag covers the external Claude agent, which connects through an MCP endpoint that has to be added by hand. The app itself makes no LLM calls for solving or scheduling. There are no payments, realtime features or background jobs. CI runs on GitHub Actions and deploys automatically on merge to main.
