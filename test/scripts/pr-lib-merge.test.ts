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

  it("requires sync when a changelog PR is behind main even without merge conflicts", () => {
    const repo = createTempDir("openclaw-pr-lib-merge-changelog-drift-");
    const result = runMergeShell(
      `
set -euo pipefail
cd "$OPENCLAW_TEST_REPO"
git init -q
git config user.email test@example.com
git config user.name "Test User"
mkdir -p .local
cat > CHANGELOG.md <<'EOF_CHANGELOG'
# Changelog

## Unreleased

### Fixes

- Existing fix.
EOF_CHANGELOG
git add CHANGELOG.md
git commit -qm "seed changelog"
base=$(git rev-parse HEAD)

git checkout -qb pr
perl -0pi -e 's/- Existing fix\\./- PR fix. (#123) Thanks @alice.\\n- Existing fix./' CHANGELOG.md
git add CHANGELOG.md
git commit -qm "add pr changelog"
prep=$(git rev-parse HEAD)

git checkout -q "$base"
git checkout -qb main
perl -0pi -e 's/- Existing fix\\./- Main fix.\\n- Existing fix./' CHANGELOG.md
git add CHANGELOG.md
git commit -qm "main changelog drift"
git update-ref refs/remotes/origin/main HEAD

git checkout -q pr
cat > .local/pr-meta.json <<'EOF_META'
{"files":[{"path":"CHANGELOG.md"}]}
EOF_META
require_artifact() { [ -s "$1" ] || { echo "Missing required artifact: $1"; exit 1; }; }
if mainline_drift_requires_sync "$prep"; then
  echo "requires_sync"
else
  echo "no_sync"
fi
`,
      { OPENCLAW_TEST_REPO: repo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR touches CHANGELOG.md and main advanced");
    expect(result.stdout).toContain("requires_sync");
  });

  it("allows changelog drift when the GitHub patch is scoped to the PR entry", () => {
    const repo = createTempDir("openclaw-pr-lib-merge-changelog-scoped-");
    const result = runMergeShell(
      `
set -euo pipefail
cd "$OPENCLAW_TEST_REPO"
git init -q
git config user.email test@example.com
git config user.name "Test User"
mkdir -p .local
cat > CHANGELOG.md <<'EOF_CHANGELOG'
# Changelog

## Unreleased

### Fixes

- Existing fix.
EOF_CHANGELOG
git add CHANGELOG.md
git commit -qm "seed changelog"
base=$(git rev-parse HEAD)

git checkout -qb pr
perl -0pi -e 's/- Existing fix\\./- PR fix. (#123) Thanks @alice.\\n- Existing fix./' CHANGELOG.md
git add CHANGELOG.md
git commit -qm "add pr changelog"
prep=$(git rev-parse HEAD)

git checkout -q "$base"
git checkout -qb main
perl -0pi -e 's/- Existing fix\\./- Main fix.\\n- Existing fix./' CHANGELOG.md
git add CHANGELOG.md
git commit -qm "main changelog drift"
git update-ref refs/remotes/origin/main HEAD

git checkout -q pr
cat > .local/pr-meta.json <<'EOF_META'
{"files":[{"path":"CHANGELOG.md"}]}
EOF_META
require_artifact() { [ -s "$1" ] || { echo "Missing required artifact: $1"; exit 1; }; }
gh() {
  cat <<'EOF_GH'
@@ -1,5 +1,6 @@
 ### Fixes
 
+- PR fix. (#123) Thanks @alice.
 - Existing fix.
EOF_GH
}
if mainline_drift_requires_sync "$prep" 123; then
  echo "requires_sync"
else
  echo "no_sync"
fi
`,
      { OPENCLAW_TEST_REPO: repo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GitHub changelog patch is scoped to PR #123");
    expect(result.stdout).toContain("no_sync");
  });

  it("does not treat longer PR numbers as scoped changelog entries", () => {
    const repo = createTempDir("openclaw-pr-lib-merge-changelog-pr-prefix-");
    const result = runMergeShell(
      `
set -euo pipefail
cd "$OPENCLAW_TEST_REPO"
git init -q
git config user.email test@example.com
git config user.name "Test User"
mkdir -p .local
cat > CHANGELOG.md <<'EOF_CHANGELOG'
# Changelog

## Unreleased

### Fixes

- Existing fix.
EOF_CHANGELOG
git add CHANGELOG.md
git commit -qm "seed changelog"
base=$(git rev-parse HEAD)

git checkout -qb pr
perl -0pi -e 's/- Existing fix\\./- PR fix. (#123) Thanks @alice.\\n- Existing fix./' CHANGELOG.md
git add CHANGELOG.md
git commit -qm "add pr changelog"
prep=$(git rev-parse HEAD)

git checkout -q "$base"
git checkout -qb main
perl -0pi -e 's/- Existing fix\\./- Main fix.\\n- Existing fix./' CHANGELOG.md
git add CHANGELOG.md
git commit -qm "main changelog drift"
git update-ref refs/remotes/origin/main HEAD

git checkout -q pr
cat > .local/pr-meta.json <<'EOF_META'
{"files":[{"path":"CHANGELOG.md"}]}
EOF_META
require_artifact() { [ -s "$1" ] || { echo "Missing required artifact: $1"; exit 1; }; }
gh() {
  cat <<'EOF_GH'
@@ -1,5 +1,6 @@
 ### Fixes
 
+- PR fix. (#123) Thanks @alice.
 - Existing fix.
EOF_GH
}
if mainline_drift_requires_sync "$prep" 12; then
  echo "requires_sync"
else
  echo "no_sync"
fi
`,
      { OPENCLAW_TEST_REPO: repo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PR touches CHANGELOG.md and main advanced");
    expect(result.stdout).toContain("requires_sync");
  });

  it("does not skip normal overlap checks when changelog is not the only overlap", () => {
    const repo = createTempDir("openclaw-pr-lib-merge-changelog-and-code-drift-");
    const result = runMergeShell(
      `
set -euo pipefail
cd "$OPENCLAW_TEST_REPO"
git init -q
git config user.email test@example.com
git config user.name "Test User"
mkdir -p .local
cat > CHANGELOG.md <<'EOF_CHANGELOG'
# Changelog

## Unreleased

### Fixes

- Existing fix.
EOF_CHANGELOG
printf 'base\\n' > app.txt
git add CHANGELOG.md app.txt
git commit -qm "seed"
base=$(git rev-parse HEAD)

git checkout -qb pr
perl -0pi -e 's/- Existing fix\\./- PR fix. (#123) Thanks @alice.\\n- Existing fix./' CHANGELOG.md
printf 'pr change\\n' > app.txt
git add CHANGELOG.md app.txt
git commit -qm "pr changes"
prep=$(git rev-parse HEAD)

git checkout -q "$base"
git checkout -qb main
printf 'main change\\n' > app.txt
git add app.txt
git commit -qm "main app drift"
git update-ref refs/remotes/origin/main HEAD

git checkout -q pr
cat > .local/pr-meta.json <<'EOF_META'
{"files":[{"path":"CHANGELOG.md"},{"path":"app.txt"}]}
EOF_META
require_artifact() { [ -s "$1" ] || { echo "Missing required artifact: $1"; exit 1; }; }
gh() {
  cat <<'EOF_GH'
@@ -1,5 +1,6 @@
 ### Fixes
 
+- PR fix. (#123) Thanks @alice.
 - Existing fix.
EOF_GH
}
if mainline_drift_requires_sync "$prep" 123; then
  echo "requires_sync"
else
  echo "no_sync"
fi
`,
      { OPENCLAW_TEST_REPO: repo },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("overlapping files detected but no merge conflicts");
    expect(result.stdout).toContain("no_sync");
    expect(result.stdout).not.toContain("GitHub changelog patch is scoped");
  });
});
