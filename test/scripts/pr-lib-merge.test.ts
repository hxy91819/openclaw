import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const mergeScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "merge.sh");
const { createTempDir } = createScriptTestHarness();

function runMergeShell(body: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_MERGE_SH"
${body}
`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PR_MERGE_SH: mergeScriptPath,
        ...env,
      },
    },
  );
}

describe("scripts/pr-lib/merge.sh", () => {
  it("requires prepare-stage gates output before merge", () => {
    const repo = createTempDir("openclaw-pr-lib-merge-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    writeFileSync(path.join(repo, ".local", "review.md"), "review\n", "utf8");
    writeFileSync(path.join(repo, ".local", "review.json"), "{}\n", "utf8");
    writeFileSync(path.join(repo, ".local", "prep.md"), "prep\n", "utf8");
    writeFileSync(path.join(repo, ".local", "prep.env"), "PREP_HEAD_SHA=deadbeef\n", "utf8");

    const result = runMergeShell(
      `
enter_worktree() { cd "$OPENCLAW_TEST_REPO"; }
require_artifact() { [ -s "$1" ] || { echo "Missing required artifact: $1"; exit 1; }; }
merge_run 123
`,
      { OPENCLAW_TEST_REPO: repo },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Missing required artifact: .local/gates.env");
  });

  it("does not expose a merge-stage changelog writer", () => {
    const result = runMergeShell(`
type run_merge_changelog_with_diagnostics >/dev/null 2>&1
`);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
