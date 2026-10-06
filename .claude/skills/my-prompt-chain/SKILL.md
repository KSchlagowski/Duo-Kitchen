---
name: my-prompt-chain
description: >
  Run the research → plan → review → apply-fixes chain for one change as four
  isolated `claude -p` subprocesses, orchestrated from the current session. Each step
  is a fresh model with zero reasoning context; state moves only through files on disk.
  Use when the user says "/my-prompt-chain", "chain the planning", "run the
  research-plan-review chain", "plan <change-id> end to end".
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - AskUserQuestion
  - TaskCreate
  - TaskUpdate
  - TaskList
---

# My Prompt Chain

Produce four artifacts for one change, in order:

1. `context/changes/<change-id>/research.md`
2. `context/changes/<change-id>/plan.md`
3. `context/changes/<change-id>/reviews/plan-review.md` — findings, all `Decision: PENDING`
4. an improved `plan.md`, with every finding triaged and the report's `Decision:` fields closed

You are the **orchestrator**. You do not research, plan, review, or apply fixes. You
launch four independent `claude -p` subprocesses, gate on their artifacts, and report.

Steps 3 and 4 are deliberately separate sessions: the model that found the problems is
not the model that edits the plan. Step 4 reads the report cold, which is the same
isolation the rest of the chain buys — and it means a finding must be written clearly
enough to act on, or it does not survive.

## The hard rule: context isolation

The entire point of this skill is that no reasoning crosses a step boundary.

- **Never** use `--continue`, `--resume`, or `--fork-session`. Every step is a cold session.
- **Never** put your own analysis, summary, hypothesis, or paraphrase of a previous
  step's output into the next step's prompt. Prompts may contain only: the change-id,
  literal file paths, and the user's own words from the invocation.
- **Between steps you may not read the artifacts.** Gate on existence, byte size, and
  required headings only (`test -s`, `wc -c`, `grep -c`). Reading `research.md` to
  "help" step 2 defeats the isolation and is a bug, not a courtesy. This binds hardest
  at the 3 → 4 boundary: do not read a finding and pre-decide it for step 4.
- You may read the artifacts **only after step 4 finishes**, to write the final report.

If you catch yourself wanting to explain the codebase to the next step, stop. The
next step reads the file. That is the handoff.

## Arguments

```
/my-prompt-chain <change-id> [free-text focus for the research step]
/my-prompt-chain <change-id> --from 3        # resume at step 2, 3, or 4
```

- No `<change-id>` → list `context/changes/*/change.md` newest-first by the `updated`
  frontmatter field and pick via `AskUserQuestion`.
- Refuse if the folder resolves under `context/archive/`: print
  "This change is archived — open a new one with `/10x-new`." and STOP.
- Refuse if `change.md` is missing: point at `/10x-new <change-id>` and STOP.

The **focus text** is optional. If given, it is pasted verbatim into step 1's prompt
as the grounding question. If absent, step 1 is told to derive scope from `change.md`.

## Step 0 — preflight

Run these before launching anything. All are cheap; a failure here saves ~20 minutes.

1. **Change folder**: `ls context/changes/<change-id>/` — confirm `change.md`.
2. **Auth**, the failure that bit us before. A subprocess reads the on-disk OAuth
   credential, which can be revoked while the host session still works:

   ```
   claude -p "Reply with exactly: OK" --model claude-opus-5 --allowedTools "Read" --output-format json
   ```

   If the JSON has `"is_error":true` with `api_error_status: 401`, STOP and tell the
   user to run `claude auth login` in an interactive terminal. Do not attempt the login
   yourself — it is an interactive credential flow.
3. **Log dir**: `mkdir -p "<scratchpad>/chain-logs/<change-id>"` using the scratchpad
   directory named in your system prompt.

Create four tasks via `TaskCreate` (`research`, `plan`, `review`, `apply-fixes`) so the
user sees progress; flip each with `TaskUpdate`.

## Common flags

Every step uses exactly these:

```
--model claude-opus-5
--effort high
--settings '{"fastMode":true}'
--permission-mode acceptEdits
--allowedTools "Read,Grep,Glob,Write,Edit,Bash,Task,Agent,Skill,WebFetch,WebSearch,TodoWrite,TaskCreate,TaskUpdate,TaskList,TaskGet"
```

Notes that are easy to get wrong:

- Fast mode has **no CLI flag** — it is a settings key. `--settings '{"fastMode":true}'`
  is the only way to get it. Confirm it took: the JSON result carries `"fast_mode_state":"on"`.
- `--permission-mode acceptEdits` is required. Under `-p`, a permission prompt is an
  automatic denial, so without it every `Write` in the child silently fails.
- This allowlist includes unrestricted `Bash`. Say so in your opening message the first
  time you run the chain in a session.

## Running a step

One Bash call per step, `run_in_background: true`, and wait for the completion
notification before the next. Steps routinely exceed the 10-minute foreground timeout;
backgrounding avoids killing a healthy run.

Shape (single line, prompt last):

```
claude -p <common flags> "<prompt>" > "<log>/step<N>.log" 2>&1
```

Keep prompt text free of backticks and `$` so bash does not expand it. Do not run two
steps concurrently — the chain is strictly sequential.

If a step exits non-zero: read the tail of its log, report the real error, and STOP.
Do not retry a failed step with a different prompt unless the user asks.

## Step 1 — research

```
/10x-research <focus text, or: Ground the work described in context/changes/<change-id>/change.md>.
Read context/changes/<change-id>/change.md first and in full; it carries the intent,
the constraints, and any scoping caveat. Write findings to
context/changes/<change-id>/research.md, then STOP.
Non-interactive session: do not ask the user questions — state assumptions inline in
the document and proceed. Do not run any downstream command yourself.
```

**Gate**: `research.md` exists, is over 500 bytes, and contains a `## ` heading.

## Step 2 — plan

```
/10x-plan <change-id> — read context/changes/<change-id>/research.md in full as the
grounding research, and context/changes/<change-id>/change.md as the change identity.
Write the plan to context/changes/<change-id>/plan.md, then STOP.
Non-interactive session with no prior context: do not ask the user questions — state
assumptions inline in the plan and proceed.
```

**Gate**: `plan.md` exists, is over 1000 bytes, and contains exactly one `## Progress`.

## Step 3 — review only

This step diagnoses. It must **not** touch `plan.md` — that is step 4's job, in a
different session. The stock skill ends by offering interactive triage, which cannot
happen under `-p`, so the prompt takes the "save report & triage later" branch:

```
/10x-plan-review context/changes/<change-id>/plan.md — grounding research is
context/changes/<change-id>/research.md.
Non-interactive session: run the fresh review, save the report to
context/changes/<change-id>/reviews/plan-review.md, then STOP.
Do not ask the user questions and do not run triage. Do not edit plan.md — leave every
finding at Decision: PENDING. Every finding must carry a concrete Fix; where there is a
genuine tradeoff give Fix A and Fix B and mark exactly one of them Recommended, so a
later session can act on the report without you.
```

**Gate**: `reviews/plan-review.md` exists, contains the `<!-- PLAN-REVIEW-REPORT -->`
marker, and `plan.md`'s sha256 is **unchanged** from before the step. Count
`grep -c '^### F'` and `grep -c 'Decision: PENDING'` — they must match. Zero findings is
a valid outcome (verdict SOUND); if so, skip step 4 and say why in the final report.

## Step 4 — apply all fixes, the recommended way

A fresh model that never saw the plan being written or the review being formed. It
enters the review skill's **resume-triage** mode, which is what the report's
`<!-- PLAN-REVIEW-REPORT -->` marker and `Decision: PENDING` fields exist for.

```
/10x-plan-review context/changes/<change-id>/reviews/plan-review.md
Non-interactive session with no prior context: this is resume triage. Do not ask the
user questions and do not re-run the review.
Apply every PENDING finding in the recommended way — the fix marked Recommended where a
finding offers Fix A and Fix B, the single Fix otherwise. Work in severity order:
CRITICAL, then WARNING, then OBSERVATION. Make minimal targeted edits to
context/changes/<change-id>/plan.md; do not restructure the plan for one finding.
Update each finding's Decision: field to FIXED and name the fix applied.
If a finding genuinely cannot be applied mechanically — it needs a product decision, or
its fix contradicts another finding you already applied — set Decision: DEFERRED with a
one-line reason instead. Never leave a finding at PENDING and never claim a fix you did
not make.
Leave plan.md internally consistent: phases renumbered, and the single ## Progress block
still matching the phase list. Print the triage summary, then STOP.
```

**Gate**, in this order:

1. `grep -c 'Decision: PENDING'` on the report is `0`.
2. FIXED + DEFERRED counts sum to the `### F` finding count.
3. `plan.md` sha256 **changed** — unless every finding is DEFERRED, which needs a
   reason in the report and a callout in your final message.
4. `plan.md` still has exactly one `## Progress`.

A DEFERRED-heavy result is a signal, not a failure: it usually means step 3 wrote
findings that need a human. Surface them rather than burying them in the summary.

## Final report

Only now read the artifacts. Give the user:

- The three paths, with byte sizes and the plan's phase count.
- The review verdict, and the FIXED / DEFERRED tally from step 4 — name every DEFERRED
  finding and its reason. Those are the ones needing the user, so they lead.
- `"fast_mode_state"` and total cost per step if the logs carry them.
- One line on what is genuinely uncertain in the plan — not a recap of the plan.
- The next command: `/10x-implement <change-id>` or `/10x-tdd <change-id>`.

Do not paste the plan back. The user can read the file.

## What this skill does not do

- Does not implement anything. The chain stops at a reviewed plan.
- Does not open the change folder — run `/10x-new <change-id>` first.
- Does not commit. Leave the artifacts in the working tree.
