import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const commonScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "common.sh");
const gatesScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "gates.sh");
const { createTempDir } = createScriptTestHarness();

function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function git(cwd: string, ...args: string[]): string {
  return run(cwd, "git", args);
}

function runGatesShell(cwd: string, body: string, env?: NodeJS.ProcessEnv): string {
  return run(
    cwd,
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_COMMON_SH"
source "$OPENCLAW_PR_GATES_SH"
${body}
`,
    ],
    {
      OPENCLAW_PR_COMMON_SH: commonScriptPath,
      OPENCLAW_PR_GATES_SH: gatesScriptPath,
      ...env,
    },
  );
}

describe("scripts/pr-lib/gates.sh", () => {
  it("reuses prior gates when a code PR only adds changelog after verification", () => {
    const repo = createTempDir("openclaw-pr-lib-gates-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    writeFileSync(path.join(repo, "src.ts"), "export const value = 1;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "add code");
    const verifiedHead = git(repo, "rev-parse", "HEAD");

    writeFileSync(
      path.join(repo, "CHANGELOG.md"),
      "## Unreleased\n\n### Fixes\n\n- Fix behavior.\n",
      "utf8",
    );
    git(repo, "add", "CHANGELOG.md");
    git(repo, "commit", "-qm", "add changelog");

    expect(
      runGatesShell(
        repo,
        `
if prepare_should_reuse_gates_for_docsish_delta "$OPENCLAW_VERIFIED_HEAD"; then
  printf true
else
  printf false
fi
`,
        {
          OPENCLAW_VERIFIED_HEAD: verifiedHead,
        },
      ),
    ).toBe("true");

    expect(verifiedHead).not.toBe(git(repo, "rev-parse", "HEAD"));
  });

  it("does not reuse prior gates when code changes after verification", () => {
    const repo = createTempDir("openclaw-pr-lib-gates-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    writeFileSync(path.join(repo, "src.ts"), "export const value = 1;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "add code");
    const verifiedHead = git(repo, "rev-parse", "HEAD");

    writeFileSync(path.join(repo, "src.ts"), "export const value = 2;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "change code");

    expect(
      runGatesShell(
        repo,
        `
if prepare_should_reuse_gates_for_docsish_delta "$OPENCLAW_VERIFIED_HEAD"; then
  printf true
else
  printf false
fi
`,
        {
          OPENCLAW_VERIFIED_HEAD: verifiedHead,
        },
      ),
    ).toBe("false");

    expect(verifiedHead).not.toBe(git(repo, "rev-parse", "HEAD"));
  });
});
