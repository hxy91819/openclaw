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
  it("reports same-head coverage without reading the diff", () => {
    expect(
      runGatesShell(
        process.cwd(),
        'prepare_gates_coverage_status "$OPENCLAW_VERIFIED_HEAD" "$OPENCLAW_VERIFIED_HEAD"',
        {
          OPENCLAW_VERIFIED_HEAD: "abc123",
        },
      ),
    ).toBe("same_head");
  });

  it("covers the current head when only docs/changelog files were added after verification", () => {
    const repo = createTempDir("openclaw-pr-lib-gates-coverage-docs-");
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
    const currentHead = git(repo, "rev-parse", "HEAD");

    expect(
      runGatesShell(
        repo,
        'prepare_gates_coverage_status "$OPENCLAW_VERIFIED_HEAD" "$OPENCLAW_CURRENT_HEAD"',
        {
          OPENCLAW_VERIFIED_HEAD: verifiedHead,
          OPENCLAW_CURRENT_HEAD: currentHead,
        },
      ),
    ).toBe("docsish_delta");
  });

  it("does not cover the current head when code changed after verification", () => {
    const repo = createTempDir("openclaw-pr-lib-gates-coverage-code-");
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
    const currentHead = git(repo, "rev-parse", "HEAD");

    expect(
      runGatesShell(
        repo,
        `
if prepare_gates_coverage_status "$OPENCLAW_VERIFIED_HEAD" "$OPENCLAW_CURRENT_HEAD"; then
  printf covered
else
  printf not_covered
fi
`,
        {
          OPENCLAW_VERIFIED_HEAD: verifiedHead,
          OPENCLAW_CURRENT_HEAD: currentHead,
        },
      ),
    ).toBe("non_docs_delta\nnot_covered");
  });

  it("covers a rebased head when non-docs file content matches the verified head", () => {
    const repo = createTempDir("openclaw-pr-lib-gates-rebased-docs-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    writeFileSync(path.join(repo, "src.ts"), "export const value = 1;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "seed");
    const verifiedBase = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-qb", "feature");
    writeFileSync(path.join(repo, "src.ts"), "export const value = 2;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "feature code");
    const verifiedHead = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-q", "main");
    writeFileSync(
      path.join(repo, "CHANGELOG.md"),
      "## Unreleased\n\n### Fixes\n\n- Main changelog entry.\n",
      "utf8",
    );
    git(repo, "add", "CHANGELOG.md");
    git(repo, "commit", "-qm", "main changelog");
    const currentBase = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", currentBase);

    git(repo, "checkout", "-qb", "rebased");
    writeFileSync(path.join(repo, "src.ts"), "export const value = 2;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "rebased feature code");
    const currentHead = git(repo, "rev-parse", "HEAD");

    expect(
      runGatesShell(
        repo,
        'prepare_gates_coverage_status "$OPENCLAW_VERIFIED_HEAD" "$OPENCLAW_CURRENT_HEAD" "$OPENCLAW_VERIFIED_BASE" "$OPENCLAW_CURRENT_BASE"',
        {
          OPENCLAW_VERIFIED_BASE: verifiedBase,
          OPENCLAW_VERIFIED_HEAD: verifiedHead,
          OPENCLAW_CURRENT_BASE: currentBase,
          OPENCLAW_CURRENT_HEAD: currentHead,
        },
      ),
    ).toBe("rebased_docsish_delta");
  });

  it("does not cover a rebased head when non-docs file content changed", () => {
    const repo = createTempDir("openclaw-pr-lib-gates-rebased-code-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    writeFileSync(path.join(repo, "src.ts"), "export const value = 1;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "seed");
    const verifiedBase = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-qb", "feature");
    writeFileSync(path.join(repo, "src.ts"), "export const value = 2;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "feature code");
    const verifiedHead = git(repo, "rev-parse", "HEAD");

    git(repo, "checkout", "-q", "main");
    writeFileSync(path.join(repo, "docs.md"), "main docs\n", "utf8");
    git(repo, "add", "docs.md");
    git(repo, "commit", "-qm", "main docs");
    const currentBase = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", currentBase);

    git(repo, "checkout", "-qb", "rebased");
    writeFileSync(path.join(repo, "src.ts"), "export const value = 3;\n", "utf8");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-qm", "rebased changed code");
    const currentHead = git(repo, "rev-parse", "HEAD");

    expect(
      runGatesShell(
        repo,
        `
if prepare_gates_coverage_status "$OPENCLAW_VERIFIED_HEAD" "$OPENCLAW_CURRENT_HEAD" "$OPENCLAW_VERIFIED_BASE" "$OPENCLAW_CURRENT_BASE"; then
  printf covered
else
  printf not_covered
fi
`,
        {
          OPENCLAW_VERIFIED_BASE: verifiedBase,
          OPENCLAW_VERIFIED_HEAD: verifiedHead,
          OPENCLAW_CURRENT_BASE: currentBase,
          OPENCLAW_CURRENT_HEAD: currentHead,
        },
      ),
    ).toBe("verified_head_not_ancestor\nnot_covered");
  });

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
