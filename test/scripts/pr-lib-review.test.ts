import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const reviewScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "review.sh");
const { createTempDir } = createScriptTestHarness();

function runReviewShell(cwd: string, body: string): string {
  return execFileSync(
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_REVIEW_SH"
${body}
`,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PR_REVIEW_SH: reviewScriptPath,
      },
    },
  ).trim();
}

describe("scripts/pr-lib/review.sh", () => {
  it("accepts review.json artifacts without a changelog decision", () => {
    const repo = createTempDir("openclaw-pr-lib-review-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });

    writeFileSync(
      path.join(repo, ".local", "review.md"),
      [
        "A) TL;DR recommendation",
        "",
        "NEEDS WORK",
        "",
        "B) What changed and what is good?",
        "",
        "Pending review.",
        "",
        "C) Security findings",
        "",
        "None yet.",
        "",
        "D) What is the PR intent? Is this the most optimal implementation?",
        "",
        "Pending review.",
        "",
        "E) Concerns or questions (actionable)",
        "",
        "None yet.",
        "",
        "F) Tests",
        "",
        "Not run.",
        "",
        "G) Docs status",
        "",
        "not_applicable",
        "",
        "H) Prepare-stage changelog handoff",
        "",
        "Prepare owns the authoritative changelog-required decision.",
        "",
        "I) Follow ups (optional)",
        "",
        "None.",
        "",
        "J) Suggested PR comment (optional)",
        "",
        "Pending review.",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(repo, ".local", "review.json"),
      JSON.stringify(
        {
          recommendation: "NEEDS WORK",
          findings: [],
          nitSweep: {
            performed: true,
            status: "none",
            summary: "No optional nits identified.",
          },
          behavioralSweep: {
            performed: true,
            status: "not_applicable",
            summary: "No runtime branch-level behavior changes require sweep evidence.",
            silentDropRisk: "none",
            branches: [],
          },
          issueValidation: {
            performed: true,
            source: "pr_body",
            status: "unclear",
            summary: "Review not completed yet.",
          },
          tests: {
            ran: [],
            gaps: [],
            result: "pass",
          },
          docs: "not_applicable",
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_HEAD_SHA=dummy\n", "utf8");
    writeFileSync(
      path.join(repo, ".local", "pr-meta.json"),
      JSON.stringify({ files: [{ path: "docs/help.md" }] }, null, 2),
      "utf8",
    );

    const output = runReviewShell(
      repo,
      `
enter_worktree() { :; }
require_artifact() { [ -s "$1" ] || { echo "Missing required artifact: $1"; exit 1; }; }
review_guard() { :; }
print_review_stdout_summary() { echo "summary"; }
review_validate_artifacts 123
`,
    );

    expect(output).toContain("review artifacts validated");
    expect(output).toContain("summary");
  });
});
