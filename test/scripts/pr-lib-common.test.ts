import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const commonScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "common.sh");
const { createTempDir } = createScriptTestHarness();

function evaluateChangelogRequired(files: string[]) {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_COMMON_SH"
if changelog_required_for_changed_files "$OPENCLAW_TEST_FILES"; then
  printf true
else
  printf false
fi
`,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PR_COMMON_SH: commonScriptPath,
        OPENCLAW_TEST_FILES: files.join("\n"),
      },
    },
  ).trim();

  return output === "true";
}

function runCommonShell(cwd: string, body: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_COMMON_SH"
${body}
`,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PR_COMMON_SH: commonScriptPath,
        ...env,
      },
    },
  ).trim();
}

function runCommonShellResult(cwd: string, body: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PR_COMMON_SH"
${body}
`,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_PR_COMMON_SH: commonScriptPath,
        ...env,
      },
    },
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

describe("scripts/pr-lib/common.sh", () => {
  it("does not require changelog entries for qa-only maintenance paths", () => {
    expect(
      evaluateChangelogRequired([
        "extensions/qa-channel/src/bus-client.ts",
        "extensions/qa-lab/src/bus-server.ts",
      ]),
    ).toBe(false);
  });

  it("does not require changelog entries for maintainer workflow paths", () => {
    expect(evaluateChangelogRequired(["scripts/pr-lib/common.sh", "docs/subagent.md"])).toBe(false);
  });

  it("still requires changelog entries when qa-only paths are mixed with product code", () => {
    expect(
      evaluateChangelogRequired([
        "extensions/qa-channel/src/bus-client.ts",
        "src/gateway/server.ts",
      ]),
    ).toBe(true);
  });

  it("bootstraps dependencies once per current install fingerprint even when vitest already exists", () => {
    const repo = createTempDir("openclaw-pr-lib-common-bootstrap-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
    mkdirSync(path.join(repo, "fake-bin"), { recursive: true });

    writeFileSync(path.join(repo, "package.json"), '{"name":"fixture"}\n', "utf8");
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    writeFileSync(path.join(repo, "node_modules", ".bin", "vitest"), "#!/usr/bin/env sh\n", "utf8");
    writeFileSync(path.join(repo, "node_modules", ".bin", "oxlint"), "#!/usr/bin/env sh\n", "utf8");
    chmodSync(path.join(repo, "node_modules", ".bin", "vitest"), 0o755);
    chmodSync(path.join(repo, "node_modules", ".bin", "oxlint"), 0o755);

    const pnpmLog = path.join(repo, "pnpm.log");
    const fakePnpm = path.join(repo, "fake-bin", "pnpm");
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "10.33.2"
  exit 0
fi
printf '%s\\n' "$*" >> "${pnpmLog}"
exit 0
`,
      "utf8",
    );
    chmodSync(fakePnpm, 0o755);

    const env = {
      PATH: `${path.join(repo, "fake-bin")}:${process.env.PATH ?? ""}`,
    };
    runCommonShell(repo, "bootstrap_deps_if_needed", env);
    runCommonShell(repo, "bootstrap_deps_if_needed", env);

    expect(readFileSync(pnpmLog, "utf8").trim().split("\n")).toEqual(["install --frozen-lockfile"]);
    expect(readFileSync(path.join(repo, ".local", "bootstrap-deps.stamp"), "utf8")).toMatch(
      /^[a-f0-9]{64}\n$/,
    );
  });

  it("does not write a dependency bootstrap stamp when install fails", () => {
    const repo = createTempDir("openclaw-pr-lib-common-bootstrap-fail-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
    mkdirSync(path.join(repo, "fake-bin"), { recursive: true });

    writeFileSync(path.join(repo, "package.json"), '{"name":"fixture"}\n', "utf8");
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    writeFileSync(path.join(repo, "node_modules", ".bin", "vitest"), "#!/usr/bin/env sh\n", "utf8");
    writeFileSync(path.join(repo, "node_modules", ".bin", "oxlint"), "#!/usr/bin/env sh\n", "utf8");
    chmodSync(path.join(repo, "node_modules", ".bin", "vitest"), 0o755);
    chmodSync(path.join(repo, "node_modules", ".bin", "oxlint"), 0o755);

    const fakePnpm = path.join(repo, "fake-bin", "pnpm");
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "10.33.2"
  exit 0
fi
exit 42
`,
      "utf8",
    );
    chmodSync(fakePnpm, 0o755);

    const result = runCommonShellResult(repo, "bootstrap_deps_if_needed", {
      PATH: `${path.join(repo, "fake-bin")}:${process.env.PATH ?? ""}`,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("pnpm install --frozen-lockfile failed");
    expect(existsSync(path.join(repo, ".local", "bootstrap-deps.stamp"))).toBe(false);
  });

  it("invalidates the dependency bootstrap stamp when patch contents change", () => {
    const repo = createTempDir("openclaw-pr-lib-common-bootstrap-patch-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
    mkdirSync(path.join(repo, "fake-bin"), { recursive: true });
    mkdirSync(path.join(repo, "patches"), { recursive: true });

    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    writeFileSync(path.join(repo, "package.json"), '{"name":"fixture"}\n', "utf8");
    writeFileSync(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(path.join(repo, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    writeFileSync(path.join(repo, "patches", "fixture.patch"), "first patch\n", "utf8");
    writeFileSync(path.join(repo, "node_modules", ".bin", "vitest"), "#!/usr/bin/env sh\n", "utf8");
    writeFileSync(path.join(repo, "node_modules", ".bin", "oxlint"), "#!/usr/bin/env sh\n", "utf8");
    chmodSync(path.join(repo, "node_modules", ".bin", "vitest"), 0o755);
    chmodSync(path.join(repo, "node_modules", ".bin", "oxlint"), 0o755);
    git(
      repo,
      "add",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "patches/fixture.patch",
    );
    git(repo, "commit", "-qm", "seed");

    const pnpmLog = path.join(repo, "pnpm.log");
    const fakePnpm = path.join(repo, "fake-bin", "pnpm");
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "10.33.2"
  exit 0
fi
printf '%s\\n' "$*" >> "${pnpmLog}"
exit 0
`,
      "utf8",
    );
    chmodSync(fakePnpm, 0o755);

    const env = {
      PATH: `${path.join(repo, "fake-bin")}:${process.env.PATH ?? ""}`,
    };
    runCommonShell(repo, "bootstrap_deps_if_needed", env);
    writeFileSync(path.join(repo, "patches", "fixture.patch"), "second patch\n", "utf8");
    runCommonShell(repo, "bootstrap_deps_if_needed", env);

    expect(readFileSync(pnpmLog, "utf8").trim().split("\n")).toEqual([
      "install --frozen-lockfile",
      "install --frozen-lockfile",
    ]);
  });

  it("deletes a branch after pruning stale worktree metadata", () => {
    const repo = createTempDir("openclaw-pr-lib-common-prune-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");
    writeFileSync(path.join(repo, "README.md"), "fixture\n", "utf8");
    git(repo, "add", "README.md");
    git(repo, "commit", "-qm", "seed");
    git(repo, "branch", "pr-123-prep");

    const worktreePath = path.join(repo, ".worktrees", "pr-123");
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(repo, "worktree", "add", "-q", worktreePath, "pr-123-prep");
    rmSync(worktreePath, { force: true, recursive: true });

    runCommonShell(repo, 'delete_local_branch_if_safe "pr-123-prep"');

    expect(() => git(repo, "show-ref", "--verify", "refs/heads/pr-123-prep")).toThrow();
  });
});
