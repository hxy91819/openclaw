import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const prepareCoreScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "prepare-core.sh");
const worktreeScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "worktree.sh");
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

function runPrepareCoreShell(cwd: string, body: string): string {
  return run(
    cwd,
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PREPARE_CORE_SH"
${body}
`,
    ],
    {
      OPENCLAW_PREPARE_CORE_SH: prepareCoreScriptPath,
    },
  );
}

function runWorktreeShell(cwd: string, body: string, env?: NodeJS.ProcessEnv): string {
  return run(
    cwd,
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_WORKTREE_SH"
${body}
`,
    ],
    {
      OPENCLAW_WORKTREE_SH: worktreeScriptPath,
      ...env,
    },
  );
}

describe("scripts/pr-lib/prepare-core.sh", () => {
  it("resets PREP_REBASE_COUNT during prepare-init", () => {
    const repo = createTempDir("openclaw-pr-lib-prepare-init-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    writeFileSync(path.join(repo, ".local", "review.md"), "# review\n", "utf8");
    writeFileSync(path.join(repo, ".local", "review.json"), "{}\n", "utf8");
    writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_HEAD=feature\n", "utf8");
    writeFileSync(
      path.join(repo, ".local", "prep-context.env"),
      "PREP_REBASE_COUNT=2\nPREP_BRANCH=pr-123-prep\n",
      "utf8",
    );

    runPrepareCoreShell(
      repo,
      `
enter_worktree() { :; }
require_artifact() { [ -e "$1" ] || exit 1; }
pr_meta_json() { printf '%s\\n' '{"headRefName":"feature","headRefOid":"deadbeef"}'; }
git() {
  case "$1" in
    fetch|checkout)
      return 0
      ;;
    branch)
      if [ "$2" = "--show-current" ]; then
        printf 'pr-123-prep\\n'
        return 0
      fi
      ;;
  esac
  echo "unexpected git invocation: $*" >&2
  exit 1
}
prepare_init 123 false
`,
    );

    const prepContext = readFileSync(path.join(repo, ".local", "prep-context.env"), "utf8");
    expect(prepContext).toContain("PREP_REBASE_COUNT=0");
  });

  it("allows an additional sync rebase only when --force is used", () => {
    expect(
      runPrepareCoreShell(
        process.cwd(),
        'if prepare_sync_rebase_allowed 1 false; then printf "allowed"; else printf "blocked"; fi',
      ),
    ).toBe("blocked");
    expect(
      runPrepareCoreShell(
        process.cwd(),
        'if prepare_sync_rebase_allowed 1 true; then printf "allowed"; else printf "blocked"; fi',
      ),
    ).toBe("allowed");
  });

  it("adds and commits a required changelog entry during prepare-push", () => {
    const repo = createTempDir("openclaw-pr-lib-prepare-push-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    writeFileSync(
      path.join(repo, ".local", "pr-meta.env"),
      "PR_HEAD=feature\nPR_AUTHOR=alice\nPR_URL=https://example.test/pr/123\nPR_NUMBER=123\n",
      "utf8",
    );
    writeFileSync(
      path.join(repo, ".local", "prep-context.env"),
      "PREP_BRANCH=pr-123-prep\n",
      "utf8",
    );
    writeFileSync(
      path.join(repo, ".local", "gates.env"),
      "CHANGELOG_REQUIRED=true\nDOCS_ONLY=false\nGATES_MODE=changed\nBUILD_GATE_STATUS=passed\nCHECK_GATE_STATUS=passed\nTEST_GATE_STATUS=passed\n",
      "utf8",
    );
    writeFileSync(path.join(repo, ".local", "prep.md"), "# prep\n", "utf8");
    writeFileSync(
      path.join(repo, "scripts", "committer"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > .local/committer.log\n",
      "utf8",
    );
    chmodSync(path.join(repo, "scripts", "committer"), 0o755);

    runPrepareCoreShell(
      repo,
      `
enter_worktree() { :; }
require_artifact() { [ -s "$1" ] || { echo "missing $1" >&2; exit 1; }; }
checkout_prep_branch() { :; }
verify_pr_head_branch_matches_expected() { :; }
changelog_entry_for_pr_exists() { return 1; }
resolve_pr_changelog_entry() { printf '%s\\n' 'Config: accept truncateAfterCompaction (#123). Thanks @alice'; }
resolve_pr_changelog_section() { printf 'Fixes\\n'; }
ensure_pr_changelog_entry() { printf 'Updated CHANGELOG.md (Fixes).\\npr_changelog_changed=true\\n'; }
pr_meta_json() { printf '%s\\n' '{"title":"Config: accept truncateAfterCompaction","author":{"login":"alice"},"labels":[{"name":"bug"}]}'; }
push_prep_head_to_pr_branch() {
  cat > "$7" <<'EOF_PUSH'
PUSH_PREP_HEAD_SHA=prep-after
PUSHED_FROM_SHA=remote-before
PR_HEAD_SHA_AFTER_PUSH=prep-after
PUSH_MAIN_STATUS=up_to_date
EOF_PUSH
}
gh() {
  if [ "$1" = "api" ] && [ "$2" = "users/alice" ] && [ "$3" = "--jq" ] && [ "$4" = ".id" ]; then
    printf '42\\n'
    return 0
  fi
  if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "123" ] && [ "$4" = "--json" ] && [ "$5" = "headRefOid" ] && [ "$6" = "--jq" ] && [ "$7" = ".headRefOid" ]; then
    printf 'prep-after\\n'
    return 0
  fi
  echo "unexpected gh invocation: $*" >&2
  exit 1
}
git() {
  case "$1" in
    rev-parse)
      if [ "$2" = "HEAD" ]; then
        printf 'prep-after\\n'
        return 0
      fi
      ;;
    branch)
      if [ "$2" = "--show-current" ]; then
        printf 'pr-123-prep\\n'
        return 0
      fi
      ;;
  esac
  return 0
}
prepare_push 123
`,
    );

    const commitLog = readFileSync(path.join(repo, ".local", "committer.log"), "utf8");
    expect(commitLog).toContain("--fast");
    expect(commitLog).toContain("Config: accept truncateAfterCompaction");
    expect(commitLog).toContain("CHANGELOG.md");

    const prepLog = readFileSync(path.join(repo, ".local", "prep.md"), "utf8");
    expect(prepLog).toContain("Prepare-stage changelog status: added_and_committed.");
  });

  it("validates an existing changelog entry during prepare-push without constructing another one", () => {
    const repo = createTempDir("openclaw-pr-lib-prepare-existing-changelog-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    writeFileSync(
      path.join(repo, ".local", "pr-meta.env"),
      "PR_HEAD=feature\nPR_AUTHOR=alice\nPR_URL=https://example.test/pr/123\nPR_NUMBER=123\n",
      "utf8",
    );
    writeFileSync(
      path.join(repo, ".local", "prep-context.env"),
      "PREP_BRANCH=pr-123-prep\n",
      "utf8",
    );
    writeFileSync(
      path.join(repo, ".local", "gates.env"),
      "CHANGELOG_REQUIRED=true\nDOCS_ONLY=false\nGATES_MODE=changed\nBUILD_GATE_STATUS=passed\nCHECK_GATE_STATUS=passed\nTEST_GATE_STATUS=passed\n",
      "utf8",
    );
    writeFileSync(path.join(repo, ".local", "prep.md"), "# prep\n", "utf8");

    runPrepareCoreShell(
      repo,
      `
enter_worktree() { :; }
require_artifact() { [ -s "$1" ] || { echo "missing $1" >&2; exit 1; }; }
checkout_prep_branch() { :; }
verify_pr_head_branch_matches_expected() { :; }
changelog_entry_for_pr_exists() { return 0; }
validate_changelog_entry_for_pr() { printf 'validated existing changelog\\n' >> .local/changelog.log; }
resolve_pr_changelog_entry() { echo "resolve_pr_changelog_entry should not run" >&2; exit 42; }
ensure_pr_changelog_entry() { echo "ensure_pr_changelog_entry should not run" >&2; exit 43; }
pr_meta_json() { printf '%s\\n' '{"title":"Config: accept truncateAfterCompaction","author":{"login":"alice"},"labels":[{"name":"bug"}]}'; }
push_prep_head_to_pr_branch() {
  cat > "$7" <<'EOF_PUSH'
PUSH_PREP_HEAD_SHA=prep-after
PUSHED_FROM_SHA=remote-before
PR_HEAD_SHA_AFTER_PUSH=prep-after
PUSH_MAIN_STATUS=up_to_date
EOF_PUSH
}
gh() {
  if [ "$1" = "api" ] && [ "$2" = "users/alice" ] && [ "$3" = "--jq" ] && [ "$4" = ".id" ]; then
    printf '42\\n'
    return 0
  fi
  if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "123" ] && [ "$4" = "--json" ] && [ "$5" = "headRefOid" ] && [ "$6" = "--jq" ] && [ "$7" = ".headRefOid" ]; then
    printf 'prep-after\\n'
    return 0
  fi
  echo "unexpected gh invocation: $*" >&2
  exit 1
}
git() {
  case "$1" in
    rev-parse)
      if [ "$2" = "HEAD" ]; then
        printf 'prep-after\\n'
        return 0
      fi
      ;;
    branch)
      if [ "$2" = "--show-current" ]; then
        printf 'pr-123-prep\\n'
        return 0
      fi
      ;;
  esac
  return 0
}
prepare_push 123
`,
    );

    const changelogLog = readFileSync(path.join(repo, ".local", "changelog.log"), "utf8");
    expect(changelogLog).toContain("validated existing changelog");

    const prepLog = readFileSync(path.join(repo, ".local", "prep.md"), "utf8");
    expect(prepLog).toContain("Prepare-stage changelog status: already_present.");
    expect(existsSync(path.join(repo, ".local", "committer.log"))).toBe(false);
  });
});

describe("scripts/pr-lib/worktree.sh", () => {
  it("force-cleans only the targeted PR worktree", () => {
    const root = createTempDir("openclaw-pr-lib-worktree-root-");
    const worktreeDir = path.join(root, ".worktrees", "pr-123");
    mkdirSync(worktreeDir, { recursive: true });

    git(worktreeDir, "init", "-q", "--initial-branch=main");
    git(worktreeDir, "config", "user.email", "test@example.com");
    git(worktreeDir, "config", "user.name", "Test User");
    writeFileSync(path.join(worktreeDir, "tracked.txt"), "seed\n", "utf8");
    git(worktreeDir, "add", "tracked.txt");
    git(worktreeDir, "commit", "-qm", "seed");

    writeFileSync(path.join(worktreeDir, "tracked.txt"), "dirty\n", "utf8");
    writeFileSync(path.join(worktreeDir, "untracked.txt"), "remove me\n", "utf8");
    mkdirSync(path.join(worktreeDir, ".local"), { recursive: true });
    writeFileSync(path.join(worktreeDir, ".local", "pr-meta.env"), "KEEP=1\n", "utf8");

    runWorktreeShell(
      root,
      `
repo_root() { printf '%s\\n' "$TEST_REPO_ROOT"; }
clean_pr_worktree_state "$TEST_REPO_ROOT/.worktrees/pr-123"
`,
      { TEST_REPO_ROOT: root },
    );

    expect(readFileSync(path.join(worktreeDir, "tracked.txt"), "utf8")).toBe("seed\n");
    expect(existsSync(path.join(worktreeDir, "untracked.txt"))).toBe(false);
    expect(readFileSync(path.join(worktreeDir, ".local", "pr-meta.env"), "utf8")).toBe("KEEP=1\n");
  });
});
