#!/usr/bin/env node
// Builds a local OpenClaw npm tarball for Docker E2E and ad hoc deployment.
// Definition: owns one build/inventory/smoke/pack/check sequence and packs with
// --ignore-scripts so npm lifecycle hooks cannot repeat the expensive build.
// Parameters: --output-dir, --output-name, --source-dir, --profile, --skip-build.
// Outputs: prints the generated tarball path on stdout; logs progress to stderr.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePackageChangelog, restorePackageChangelog } from "./package-changelog.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PACKAGE_BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_PACKAGE_INVENTORY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PACKAGE_PACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PACKAGE_TARBALL_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_KILL_AFTER_MS = 5_000;
const DEFAULT_CAPTURED_STDOUT_MAX_BYTES = 1024 * 1024;
const DEFAULT_BUILD_PROFILE = "full";
const ACTIVE_CHILD_KILLERS = new Set();
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
let forwardedSignalExitCode;

class ForwardedSignalExitError extends Error {
  constructor(exitCode) {
    super(`forwarded signal requested exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}

for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    forwardedSignalExitCode ??= SIGNAL_EXIT_CODES[signal];
    if (ACTIVE_CHILD_KILLERS.size === 0) {
      process.exit(forwardedSignalExitCode);
    }
    for (const killChild of ACTIVE_CHILD_KILLERS) {
      killChild(signal);
    }
    setTimeout(() => {
      for (const killChild of ACTIVE_CHILD_KILLERS) {
        killChild("SIGKILL");
      }
      process.exit(forwardedSignalExitCode);
    }, DEFAULT_TIMEOUT_KILL_AFTER_MS);
  });
}

function resolveTimeoutMs(envName, defaultValue) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive timeout in milliseconds`);
  }
  return Math.trunc(parsed);
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function readEqualsOptionValue(value, optionName) {
  if (value === "" || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function usage() {
  return [
    "Usage:",
    "  node scripts/package-openclaw-for-docker.mjs [options]",
    "",
    "Description:",
    "  Build and pack a local OpenClaw npm tarball for Docker E2E or deployment testing.",
    "  The script runs build-all at most once, writes the package dist inventory,",
    "  prepares the package changelog, packs with npm --ignore-scripts, restores the",
    "  changelog, and validates the resulting tarball.",
    "",
    "Options:",
    "  --output-dir <path>   Directory for the .tgz artifact. Default: .artifacts/docker-e2e-package",
    "  --output-name <name>  Rename the generated tarball after packing.",
    "  --source-dir <path>   Repository root to package. Default: current repository root.",
    `  --profile <name>      build-all profile to run before packing. Default: ${DEFAULT_BUILD_PROFILE}`,
    "  --skip-build          Reuse existing dist artifacts and only run inventory/pack/check.",
    "  -h, --help            Show this help.",
    "",
    "Outputs:",
    "  stdout: absolute path to the generated tarball.",
    "  stderr: build, packaging, and validation progress.",
    "  exit code: 0 on success, non-zero when build, pack, or validation fails.",
    "",
    "Examples:",
    "  node scripts/package-openclaw-for-docker.mjs --output-dir /tmp/openclaw-pack",
    "  node scripts/package-openclaw-for-docker.mjs --skip-build --output-dir /tmp/openclaw-pack --output-name openclaw-current.tgz",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    help: false,
    outputDir: "",
    outputName: "",
    profile: DEFAULT_BUILD_PROFILE,
    skipBuild: false,
    sourceDir: ROOT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--output-dir") {
      options.outputDir = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg?.startsWith("--output-dir=")) {
      options.outputDir = readEqualsOptionValue(arg.slice("--output-dir=".length), "--output-dir");
    } else if (arg === "--output-name") {
      options.outputName = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg?.startsWith("--output-name=")) {
      options.outputName = readEqualsOptionValue(
        arg.slice("--output-name=".length),
        "--output-name",
      );
    } else if (arg === "--profile") {
      options.profile = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg?.startsWith("--profile=")) {
      options.profile = readEqualsOptionValue(arg.slice("--profile=".length), "--profile");
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--source-dir") {
      options.sourceDir = readOptionValue(argv, index, arg);
      index += 1;
    } else if (arg?.startsWith("--source-dir=")) {
      options.sourceDir = readEqualsOptionValue(arg.slice("--source-dir=".length), "--source-dir");
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function run(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      detached: useProcessGroup,
    });
    let timedOut = false;
    let outputLimitExceeded = false;
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    let forceKillTimeout;
    const maxCapturedStdoutBytes = Math.max(
      1,
      options.maxCapturedStdoutBytes ?? DEFAULT_CAPTURED_STDOUT_MAX_BYTES,
    );
    const finish = (error, value = "") => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      ACTIVE_CHILD_KILLERS.delete(killChild);
      if (forwardedSignalExitCode !== undefined && ACTIVE_CHILD_KILLERS.size === 0) {
        if (options.deferForwardedSignalExit) {
          reject(new ForwardedSignalExitError(forwardedSignalExitCode));
          return;
        }
        process.exit(forwardedSignalExitCode);
      }
      if (error) {
        reject(toLintErrorObject(error, "Non-Error rejection"));
        return;
      }
      resolve(value);
    };
    const killChild = (signal) => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The direct child may already have exited; fall back to child.kill.
        }
      }
      child.kill(signal);
    };
    const processGroupAlive = () => {
      if (!useProcessGroup || !child.pid) {
        return false;
      }
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error?.code === "EPERM";
      }
    };
    const terminateChild = () => {
      killChild("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        forceKillTimeout = undefined;
        if (settled && !processGroupAlive()) {
          return;
        }
        killChild("SIGKILL");
      }, options.killAfterMs ?? DEFAULT_TIMEOUT_KILL_AFTER_MS);
      forceKillTimeout.unref?.();
    };
    ACTIVE_CHILD_KILLERS.add(killChild);
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminateChild();
          }, options.timeoutMs);
    timeout?.unref?.();
    if (options.captureStdout) {
      child.stdout.on("data", (chunk) => {
        if (outputLimitExceeded) {
          return;
        }
        const chunkText = String(chunk);
        const chunkBytes = Buffer.byteLength(chunkText);
        if (stdoutBytes + chunkBytes > maxCapturedStdoutBytes) {
          outputLimitExceeded = true;
          terminateChild();
          return;
        }
        stdout += chunkText;
        stdoutBytes += chunkBytes;
      });
    } else {
      child.stdout.pipe(process.stderr, { end: false });
    }
    child.stderr.pipe(process.stderr, { end: false });
    child.on("error", (error) => finish(error));
    child.on("close", (status, signal) => {
      if (timedOut) {
        finish(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
        return;
      }
      if (outputLimitExceeded) {
        finish(
          new Error(
            `${command} ${args.join(" ")} exceeded captured stdout limit (${maxCapturedStdoutBytes} bytes)`,
          ),
        );
        return;
      }
      if (status === 0) {
        finish(undefined, stdout);
        return;
      }
      finish(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}`));
    });
  });
}

export async function buildPackageArtifacts(sourceDir, options = {}) {
  const runImpl = options.runImpl ?? run;
  const profile = options.profile ?? DEFAULT_BUILD_PROFILE;
  console.error(`==> Building OpenClaw package artifacts (${profile})`);
  await runImpl("node", ["scripts/build-all.mjs", profile], sourceDir, {
    env: {
      ...process.env,
      OPENCLAW_BUILD_ALL_NO_PNPM: "1",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
    },
    timeoutMs: resolveTimeoutMs(
      "OPENCLAW_DOCKER_PACKAGE_BUILD_TIMEOUT_MS",
      DEFAULT_PACKAGE_BUILD_TIMEOUT_MS,
    ),
  });
}

export const runCommandForTest = run;

async function runCapture(command, args, cwd, options = {}) {
  return await run(command, args, cwd, { ...options, captureStdout: true });
}

async function newestOpenClawTarball(outputDir, packOutput) {
  let fromOutput = "";
  for (const line of packOutput.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (/^openclaw-.*\.tgz$/u.test(trimmed)) {
      fromOutput = trimmed;
    }
  }
  if (fromOutput) {
    return path.join(outputDir, fromOutput);
  }

  const entries = await fs.readdir(outputDir);
  const packed = entries
    .filter((entry) => /^openclaw-.*\.tgz$/u.test(entry))
    .toSorted()
    .at(-1);
  if (!packed) {
    throw new Error(`missing packed OpenClaw tarball in ${outputDir}`);
  }
  return path.join(outputDir, packed);
}

export async function packOpenClawPackageForDocker(sourceDir, outputDir, options = {}) {
  const runCaptureImpl = options.runCaptureImpl ?? runCapture;
  const prepareChangelog = options.prepareChangelog ?? preparePackageChangelog;
  const restoreChangelog = options.restoreChangelog ?? restorePackageChangelog;
  console.error("==> Packing OpenClaw package");
  await prepareChangelog(sourceDir);
  let packOutput;
  try {
    packOutput = await runCaptureImpl(
      "npm",
      ["pack", "--silent", "--ignore-scripts", "--pack-destination", outputDir],
      sourceDir,
      {
        deferForwardedSignalExit: true,
        timeoutMs: resolveTimeoutMs(
          "OPENCLAW_DOCKER_PACKAGE_PACK_TIMEOUT_MS",
          DEFAULT_PACKAGE_PACK_TIMEOUT_MS,
        ),
      },
    );
  } finally {
    await restoreChangelog(sourceDir);
  }
  return await newestOpenClawTarball(outputDir, packOutput);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const sourceDir = path.resolve(ROOT_DIR, options.sourceDir || ROOT_DIR);
  const outputDir = path.resolve(
    ROOT_DIR,
    options.outputDir || path.join(".artifacts", "docker-e2e-package"),
  );
  await fs.mkdir(outputDir, { recursive: true });

  if (!options.skipBuild) {
    await buildPackageArtifacts(sourceDir, { profile: options.profile });
  }

  console.error("==> Writing OpenClaw package inventory");
  await run(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "const { writePackageDistInventory } = await import('./src/infra/package-dist-inventory.ts'); await writePackageDistInventory(process.cwd());",
    ],
    sourceDir,
    {
      timeoutMs: resolveTimeoutMs(
        "OPENCLAW_DOCKER_PACKAGE_INVENTORY_TIMEOUT_MS",
        DEFAULT_PACKAGE_INVENTORY_TIMEOUT_MS,
      ),
    },
  );

  let tarball = await packOpenClawPackageForDocker(sourceDir, outputDir);

  if (options.outputName) {
    const target = path.join(outputDir, options.outputName);
    if (target !== tarball) {
      await fs.rm(target, { force: true });
      await fs.rename(tarball, target);
      tarball = target;
    }
  }

  console.error("==> Checking OpenClaw package tarball");
  const checkStartedAt = Date.now();
  await run(
    "node",
    [path.join(ROOT_DIR, "scripts/check-openclaw-package-tarball.mjs"), tarball],
    sourceDir,
    {
      timeoutMs: resolveTimeoutMs(
        "OPENCLAW_DOCKER_PACKAGE_TARBALL_CHECK_TIMEOUT_MS",
        DEFAULT_PACKAGE_TARBALL_CHECK_TIMEOUT_MS,
      ),
    },
  );
  console.error(
    `==> OpenClaw package tarball check finished in ${Math.round((Date.now() - checkStartedAt) / 1000)}s`,
  );

  process.stdout.write(`${tarball}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(Number.isInteger(error?.exitCode) ? error.exitCode : 1);
    },
  );
}

function toLintErrorObject(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
