import { execFileSync, spawnSync } from "node:child_process";
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

function runReviewShellResult(cwd: string, body: string) {
  return spawnSync(
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
  );
}

function reviewMarkdown(): string {
  return [
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
  ].join("\n");
}

function validReviewJson() {
  return {
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
  };
}

function writeReviewHarnessFiles(
  repo: string,
  reviewJson: unknown = validReviewJson(),
  prFiles: Array<{ path: string }> = [{ path: "docs/help.md" }],
) {
  mkdirSync(path.join(repo, ".local"), { recursive: true });
  writeFileSync(path.join(repo, ".local", "review.md"), reviewMarkdown(), "utf8");
  writeFileSync(
    path.join(repo, ".local", "review.json"),
    JSON.stringify(reviewJson, null, 2),
    "utf8",
  );
  writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_HEAD_SHA=dummy\n", "utf8");
  writeFileSync(
    path.join(repo, ".local", "pr-meta.json"),
    JSON.stringify({ files: prFiles }, null, 2),
    "utf8",
  );
}

const validationHarness = `
enter_worktree() { :; }
require_artifact() { [ -s "$1" ] || { echo "Missing required artifact: $1"; exit 1; }; }
review_guard() { :; }
print_review_stdout_summary() { echo "summary"; }
`;

describe("scripts/pr-lib/review.sh", () => {
  it("accepts review.json artifacts without a changelog decision", () => {
    const repo = createTempDir("openclaw-pr-lib-review-");
    writeReviewHarnessFiles(repo);

    const output = runReviewShell(
      repo,
      `
${validationHarness}
review_validate_artifacts 123
`,
    );

    expect(output).toContain("review artifacts validated");
    expect(output).toContain("summary");
  });

  it("initializes review artifacts with a template that validates", () => {
    const repo = createTempDir("openclaw-pr-lib-review-init-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_HEAD_SHA=dummy\n", "utf8");
    writeFileSync(
      path.join(repo, ".local", "pr-meta.json"),
      JSON.stringify({ files: [{ path: "docs/help.md" }] }, null, 2),
      "utf8",
    );

    const output = runReviewShell(
      repo,
      `
${validationHarness}
review_artifacts_init 123
review_validate_artifacts 123
`,
    );

    expect(output).toContain("review artifact templates are ready");
    expect(output).toContain(
      "review_json_schema=recommendation findings nitSweep issueValidation behavioralSweep docs",
    );
    expect(output).toContain(
      "changelog_handoff=.local/review.md section H; prepare records CHANGELOG_REQUIRED in .local/gates.env",
    );
    expect(output).toContain("review artifacts validated");
  });

  it("reports all missing required review.json sections together", () => {
    const repo = createTempDir("openclaw-pr-lib-review-missing-fields-");
    writeReviewHarnessFiles(repo, {
      recommendation: "NEEDS WORK",
    });

    const result = runReviewShellResult(
      repo,
      `
${validationHarness}
review_validate_artifacts 123
`,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("review artifact validation failed:");
    expect(result.stdout).toContain(
      "Invalid findings in .local/review.json: findings must be an array",
    );
    expect(result.stdout).toContain(
      "Invalid nit sweep in .local/review.json: nitSweep must be an object",
    );
    expect(result.stdout).toContain(
      "Invalid issue validation in .local/review.json: issueValidation must be an object",
    );
    expect(result.stdout).toContain(
      "Invalid behavioral sweep in .local/review.json: behavioralSweep must be an object",
    );
    expect(result.stdout).toContain("Invalid docs status in .local/review.json:");
  });

  it("reports multiple invalid enum values together", () => {
    const repo = createTempDir("openclaw-pr-lib-review-invalid-enums-");
    writeReviewHarnessFiles(repo, {
      ...validReviewJson(),
      recommendation: "READY",
      findings: [
        {
          id: "F1",
          severity: "SUGGESTION",
          title: "Title",
          area: "src/foo.ts",
          fix: "Fix it.",
        },
      ],
      nitSweep: {
        performed: true,
        status: "maybe",
        summary: "Checked nits.",
      },
      issueValidation: {
        performed: true,
        source: "ticket",
        status: "maybe",
        summary: "Checked issue.",
      },
      behavioralSweep: {
        performed: true,
        status: "maybe",
        summary: "Checked behavior.",
        silentDropRisk: "maybe",
        branches: [],
      },
      docs: "maybe",
    });

    const result = runReviewShellResult(
      repo,
      `
${validationHarness}
review_validate_artifacts 123
`,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Invalid recommendation in .local/review.json: READY");
    expect(result.stdout).toContain(
      "Invalid finding severity in .local/review.json: severity must be BLOCKER|IMPORTANT|NIT",
    );
    expect(result.stdout).toContain("Invalid nit sweep status in .local/review.json: maybe");
    expect(result.stdout).toContain(
      "Invalid issue validation source in .local/review.json: ticket",
    );
    expect(result.stdout).toContain("Invalid issue validation status in .local/review.json: maybe");
    expect(result.stdout).toContain("Invalid behavioral sweep status in .local/review.json: maybe");
    expect(result.stdout).toContain("Invalid behavioral sweep risk in .local/review.json: maybe");
    expect(result.stdout).toContain("Invalid docs status in .local/review.json: maybe");
  });
});
