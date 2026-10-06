import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// PostToolUse hook (Write|Edit|MultiEdit): lint the edited file, then run
// related tests when the file sits in a test-plan §2 risk area. Failure
// feedback must go to stderr with exit 2 — that is what Claude Code feeds
// back into the agent's context (PostToolUse cannot block, only inform).

const input = JSON.parse(readFileSync(0, "utf8"));
const file = input.tool_input?.file_path;
if (!file || !/\.(ts|tsx|jsx|js|astro)$/.test(file)) process.exit(0);

function run(command, extraEnv = {}) {
  return spawnSync(command, {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

const lint = run(`npx eslint --fix --no-warn-ignored "${file}"`);
if (lint.status !== 0) {
  process.stderr.write(lint.stdout + lint.stderr);
  process.exit(2);
}

// Risk areas per context/foundation/test-plan.md §2: src/lib/ and src/pages/api/
const risk = /src[\\/](lib|pages[\\/]api)[\\/]/.test(file) && /\.tsx?$/.test(file);
if (risk) {
  const test = run(`npx vitest related "${file}" --run --passWithNoTests`, { AI_AGENT: "1" });
  if (test.status !== 0) {
    process.stderr.write(test.stdout + test.stderr);
    process.exit(2);
  }
}
process.exit(0);
