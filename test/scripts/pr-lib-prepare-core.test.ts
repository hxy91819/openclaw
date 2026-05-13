import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const prepareCoreScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "prepare-core.sh");
const pushScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "push.sh");
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

function runPrepareCoreShellResult(cwd: string, body: string) {
  return spawnSync(
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PREPARE_CORE_SH"
${body}
`,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PREPARE_CORE_SH: prepareCoreScriptPath,
      },
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

function runPushShell(cwd: string, body: string): string {
  return run(
    cwd,
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PUSH_SH"
${body}
`,
    ],
    {
      OPENCLAW_PUSH_SH: pushScriptPath,
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

  it("reads gates metadata before deciding required changelog handling during prepare-push", () => {
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
      "CHANGELOG_REQUIRED=true\nDOCS_ONLY=false\nGATES_MODE=changed\nBUILD_GATE_STATUS=passed\nCHECK_GATE_STATUS=passed\nTEST_GATE_STATUS=passed\nLAST_VERIFIED_HEAD_SHA=prep-before\n",
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
ensure_pr_changelog_entry() { printf 'pr_changelog_changed=true\\n'; }
prepare_gates_coverage_status() { printf 'docsish_delta\\n'; return 0; }
pr_meta_json() { printf '%s\\n' '{"title":"Config: accept truncateAfterCompaction","author":{"login":"alice"},"labels":[{"name":"bug"}]}'; }
push_prep_head_to_pr_branch() {
  cat > "$7" <<'EOF_PUSH'
PUSH_PREP_HEAD_SHA=prep-after
PUSHED_FROM_SHA=remote-before
PR_HEAD_SHA_AFTER_PUSH=prep-after
PUSH_MAIN_STATUS=up_to_date
EOF_PUSH
}
resolve_contributor_coauthor_email() { printf '42+alice@users.noreply.github.com\\n'; }
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

    const prepEnv = readFileSync(path.join(repo, ".local", "prep.env"), "utf8");
    expect(prepEnv).toContain("PREP_HEAD_SHA=prep-after");
  });

  it("allows an existing changelog entry when gates cover the pushed head", () => {
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
      "CHANGELOG_REQUIRED=true\nDOCS_ONLY=false\nGATES_MODE=changed\nBUILD_GATE_STATUS=passed\nCHECK_GATE_STATUS=passed\nTEST_GATE_STATUS=passed\nLAST_VERIFIED_HEAD_SHA=prep-after\n",
      "utf8",
    );
    writeFileSync(path.join(repo, ".local", "prep.md"), "# prep\n", "utf8");

    const output = runPrepareCoreShell(
      repo,
      `
enter_worktree() { :; }
require_artifact() { [ -s "$1" ] || { echo "missing $1" >&2; exit 1; }; }
checkout_prep_branch() { :; }
verify_pr_head_branch_matches_expected() { :; }
changelog_entry_for_pr_exists() { return 0; }
validate_changelog_entry_for_pr() { printf 'validated existing changelog\\n' >> .local/changelog.log; }
prepare_gates_coverage_status() { printf 'same_head\\n'; return 0; }
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
resolve_contributor_coauthor_email() { printf '42+alice@users.noreply.github.com\\n'; }
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

    expect(output).toContain("prepare-push complete");
    expect(output).toContain("gates_coverage=same_head");
    expect(existsSync(path.join(repo, ".local", "committer.log"))).toBe(false);
  });

  it("stops prepare-push when gates do not cover the current prep head", () => {
    const repo = createTempDir("openclaw-pr-lib-prepare-push-coverage-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
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
      "CHANGELOG_REQUIRED=false\nDOCS_ONLY=false\nGATES_MODE=changed\nBUILD_GATE_STATUS=passed\nCHECK_GATE_STATUS=passed\nTEST_GATE_STATUS=passed\nLAST_VERIFIED_HEAD_SHA=prep-before\n",
      "utf8",
    );
    writeFileSync(path.join(repo, ".local", "prep.md"), "# prep\n", "utf8");

    const result = runPrepareCoreShellResult(
      repo,
      `
enter_worktree() { :; }
require_artifact() { [ -s "$1" ] || { echo "missing $1" >&2; exit 1; }; }
checkout_prep_branch() { :; }
prepare_gates_coverage_status() { printf 'non_docs_delta\\n'; return 1; }
push_prep_head_to_pr_branch() { echo "push should not run" >&2; exit 43; }
git() {
  if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
    printf 'prep-after\\n'
    return 0
  fi
  return 0
}
prepare_push 123
`,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Prepare gates do not cover the current prep head");
    expect(result.stdout).toContain("Run scripts/pr prepare-gates 123 before prepare-push.");
  });

  it("pushes a synced rebase result and refreshes PREP_HEAD_SHA", () => {
    const repo = createTempDir("openclaw-pr-lib-prepare-sync-head-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    writeFileSync(
      path.join(repo, ".local", "pr-meta.env"),
      "PR_HEAD=feature\nPR_AUTHOR=alice\nPR_URL=https://example.test/pr/123\nPR_NUMBER=123\n",
      "utf8",
    );
    writeFileSync(
      path.join(repo, ".local", "prep-context.env"),
      [
        "PR_NUMBER=123",
        "PR_HEAD=feature",
        "PR_HEAD_SHA_BEFORE=remote-before",
        "PREP_BRANCH=pr-123-prep",
        "PREP_REBASE_COUNT=0",
        "PREP_STARTED_AT=2026-05-13T00:00:00Z",
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(repo, ".local", "gates.env"),
      "CHANGELOG_REQUIRED=false\nDOCS_ONLY=false\nLAST_VERIFIED_HEAD_SHA=old-prep\n",
      "utf8",
    );
    writeFileSync(path.join(repo, ".local", "prep.md"), "# prep\n", "utf8");

    const output = runPrepareCoreShell(
      repo,
      `
enter_worktree() { :; }
require_artifact() { [ -s "$1" ] || { echo "missing $1" >&2; exit 1; }; }
checkout_prep_branch() { :; }
verify_pr_head_branch_matches_expected() { :; }
prepare_gates() {
  cat > .local/gates.env <<'EOF_GATES'
CHANGELOG_REQUIRED=false
DOCS_ONLY=false
LAST_VERIFIED_HEAD_SHA=synced-head
EOF_GATES
}
prepare_gates_coverage_status() { printf 'same_head\\n'; return 0; }
push_prep_head_to_pr_branch() {
  cat > "$7" <<'EOF_PUSH'
PUSH_PREP_HEAD_SHA=synced-head
PUSHED_FROM_SHA=remote-before
PR_HEAD_SHA_AFTER_PUSH=synced-head
PUSH_MAIN_STATUS=up_to_date
EOF_PUSH
}
resolve_contributor_coauthor_email() { printf '42+alice@users.noreply.github.com\\n'; }
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "123" ] && [ "$4" = "--json" ] && [ "$5" = "headRefOid" ] && [ "$6" = "--jq" ] && [ "$7" = ".headRefOid" ]; then
    printf 'remote-before\\n'
    return 0
  fi
  echo "unexpected gh invocation: $*" >&2
  exit 1
}
git() {
  case "$1" in
    fetch|rebase)
      return 0
      ;;
    merge-base)
      return 1
      ;;
    rev-parse)
      if [ "$2" = "HEAD" ]; then
        printf 'synced-head\\n'
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
  echo "unexpected git invocation: $*" >&2
  exit 1
}
prepare_sync_head 123 false
`,
    );

    expect(output).toContain("prepare-sync-head complete");
    expect(output).toContain("prep_head_sha=synced-head");
    expect(output).toContain("pr_head_sha=synced-head");

    const prepContext = readFileSync(path.join(repo, ".local", "prep-context.env"), "utf8");
    expect(prepContext).toContain("PREP_REBASE_COUNT=1");

    const prepLog = readFileSync(path.join(repo, ".local", "prep.md"), "utf8");
    expect(prepLog).toContain("Prepare sync rebase count: 1.");

    const prepEnv = readFileSync(path.join(repo, ".local", "prep.env"), "utf8");
    expect(prepEnv).toContain("PREP_HEAD_SHA=synced-head");
    expect(prepEnv).toContain("PR_HEAD_SHA_BEFORE=remote-before");
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

describe("scripts/pr-lib/push.sh", () => {
  it("refreshes gates metadata when lease-retry reruns prepare gates", () => {
    const repo = createTempDir("openclaw-pr-lib-push-lease-retry-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });

    runPushShell(
      repo,
      `
setup_prhead_remote() { :; }
resolve_prhead_remote_sha() { printf 'stale-remote\\n'; }
prepare_gates() {
  printf 'LAST_VERIFIED_HEAD_SHA=%s\\n' "$(git rev-parse HEAD)" > .local/gates.env
}
wait_for_pr_head_sha() { return 0; }
gh() {
  if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "123" ] && [ "$4" = "--json" ] && [ "$5" = "headRefOid" ] && [ "$6" = "--jq" ] && [ "$7" = ".headRefOid" ]; then
    printf 'fresh-remote\\n'
    return 0
  fi
  echo "unexpected gh invocation: $*" >&2
  exit 1
}
git() {
  case "$1" in
    push)
      if [ ! -f .local/push-attempted ]; then
        touch .local/push-attempted
        printf 'lease failed\\n' >&2
        return 1
      fi
      return 0
      ;;
    fetch|rebase|branch)
      return 0
      ;;
    rev-parse)
      if [ "$2" = "HEAD" ]; then
        printf 'retry-head\\n'
      elif [ "$2" = "origin/main" ]; then
        printf 'main-head\\n'
      fi
      return 0
      ;;
    merge-base)
      return 0
      ;;
  esac
  echo "unexpected git invocation: $*" >&2
  exit 1
}
OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH=1
push_prep_head_to_pr_branch 123 feature initial-head stale-remote true false .local/push-result.env
`,
    );

    const gatesEnv = readFileSync(path.join(repo, ".local", "gates.env"), "utf8");
    expect(gatesEnv).toContain("LAST_VERIFIED_HEAD_SHA=retry-head");

    const pushResult = readFileSync(path.join(repo, ".local", "push-result.env"), "utf8");
    expect(pushResult).toContain("PUSH_PREP_HEAD_SHA=retry-head");
  });
});
