// Verifies restart recovery marks and resumes interrupted main-agent sessions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionStore,
  type MainRestartRecoveryState,
  type SessionEntry,
} from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  appendTranscriptMessage,
  listSessionEntries,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readSessionStoreForTest } from "../config/sessions/test-helpers.js";
import { callGateway } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import * as sessionTranscriptReaders from "../gateway/session-transcript-readers.js";
import {
  getAgentEventLifecycleGeneration,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "./internal-runtime-context.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";
import {
  markRestartAbortedMainSessions,
  markRestartAbortedMainSessionsFromLocks,
  markStartupOrphanedMainSessionsForRecovery,
  recoverStartupOrphanedMainSessions,
  recoverRestartAbortedMainSessions,
  scheduleRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery.js";
import type { SessionLockInspection } from "./session-write-lock.js";

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "run-resumed" })),
}));

let tmpDir: string;

beforeEach(async () => {
  vi.mocked(callGateway).mockReset();
  vi.mocked(callGateway).mockImplementation(acceptRecoveryGatewayRequest);
  resetAgentRunContextForTest();
  resetGatewayWorkAdmission();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-restart-recovery-"));
});

async function acceptRecoveryGatewayRequest(request: {
  method: string;
  params?: Record<string, unknown>;
}): Promise<{ runId?: string }> {
  if (request.method !== "agent") {
    return {};
  }
  const sessionKey = String(request.params?.sessionKey ?? "");
  const sessionId = String(request.params?.sessionId ?? "");
  const runId = String(request.params?.idempotencyKey ?? "");
  const agentId = sessionKey.split(":")[1] || "main";
  const storePath = path.join(tmpDir, "agents", agentId, "sessions", "sessions.json");
  const admitted = await commitMainSessionRecovery({
    command: {
      kind: "admit_recovery",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      now: Date.now(),
      runId,
      sessionId,
    },
    requireWriteSuccess: true,
    target: { sessionKey, storePath },
  });
  if (admitted.transition.kind !== "admitted_recovery") {
    throw new Error(`test Gateway rejected recovery: ${admitted.transition.kind}`);
  }
  return { runId };
}

afterEach(async () => {
  resetGatewayWorkAdmission();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeSessionsDir(agentId = "main"): Promise<string> {
  const sessionsDir = path.join(tmpDir, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

type LegacyMainRecoveryState = {
  automaticAttempts?: number;
  lastAttemptAt?: number;
  lastRunId?: string;
  nonRecoveryOwners?: { lifecycleGeneration: string; tokens: string[] };
  wedgedAt?: number;
  wedgedReason?: string;
};

type TestSessionEntry = Omit<SessionEntry, "mainRestartRecovery"> & {
  mainRestartRecovery?: MainRestartRecoveryState | LegacyMainRecoveryState;
};

function normalizeTestRecoveryState(
  state: MainRestartRecoveryState | LegacyMainRecoveryState | undefined,
): MainRestartRecoveryState | undefined {
  if (!state || "schemaVersion" in state) {
    return state;
  }
  return {
    schemaVersion: 1,
    cycleId: `test-cycle:${state.lastRunId ?? "interrupted"}`,
    revision: 1,
    attempts: {
      charged: state.automaticAttempts ?? 0,
      ...(state.lastAttemptAt === undefined ? {} : { lastAt: state.lastAttemptAt }),
    },
    ...(state.nonRecoveryOwners
      ? { foregroundClaims: structuredClone(state.nonRecoveryOwners) }
      : {}),
    ...(state.wedgedAt
      ? {
          tombstone: {
            at: state.wedgedAt,
            code: "attempt_budget_exhausted" as const,
            reason: state.wedgedReason ?? "attempt budget exhausted",
          },
        }
      : {}),
  };
}

function recoveryTestView(entry: SessionEntry | undefined) {
  const state = entry?.mainRestartRecovery;
  const latestFence = entry?.restartRecoveryRuns?.at(-1);
  return state
    ? {
        automaticAttempts: state.attempts.charged,
        lastAttemptAt: state.attempts.lastAt,
        lastRunId: state.reservation?.runId ?? latestFence?.runId,
        nonRecoveryOwners: state.foregroundClaims,
        wedgedAt: state.tombstone?.at,
        wedgedReason: state.tombstone?.reason,
      }
    : undefined;
}

function normalizeTestStore(store: Record<string, TestSessionEntry>): Record<string, SessionEntry> {
  return Object.fromEntries(
    Object.entries(store).map(([key, entry]) => [
      key,
      {
        ...entry,
        mainRestartRecovery: normalizeTestRecoveryState(entry.mainRestartRecovery),
      },
    ]),
  );
}

async function writeStore(
  sessionsDir: string,
  store: Record<string, TestSessionEntry>,
): Promise<void> {
  await writeStorePath(path.join(sessionsDir, "sessions.json"), store);
}

async function writeSessionStoreForTestAsync(
  storePath: string,
  store: Record<string, TestSessionEntry>,
): Promise<void> {
  await writeStorePath(storePath, store);
}

async function writeStorePath(
  storePath: string,
  store: Record<string, TestSessionEntry>,
): Promise<void> {
  await Promise.all(
    Object.entries(normalizeTestStore(store)).map(([sessionKey, entry]) =>
      replaceSessionEntry({ storePath, sessionKey }, entry),
    ),
  );
}

function readStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntries({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  messages: unknown[],
): Promise<void> {
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = Object.entries(readStore(storePath)).find(
    ([, entry]) => entry.sessionId === sessionId,
  )?.[0];
  if (!sessionKey) {
    throw new Error(`expected session entry for transcript fixture: ${sessionId}`);
  }
  for (const message of messages) {
    await appendTranscriptMessage(
      { sessionId, sessionKey, storePath },
      {
        cwd: sessionsDir,
        message,
      },
    );
  }
}

function cleanedLockForPath(lockPath: string): SessionLockInspection {
  // Simulates lock cleanup after process restart: stale lock removed, owning
  // PID dead, and the transcript path available for recovery.
  return {
    lockPath,
    pid: 999_999,
    pidAlive: false,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    ageMs: 1_000,
    stale: true,
    staleReasons: ["dead-pid"],
    removable: true,
    removed: true,
  };
}

function cleanedLock(sessionsDir: string, sessionId: string): SessionLockInspection {
  return cleanedLockForPath(path.join(sessionsDir, `${sessionId}.jsonl.lock`));
}

function firstGatewayParams(): Record<string, unknown> {
  // Recovery resumes through the gateway. Narrow the first mock call so tests
  // assert request payloads without depending on the gateway return type.
  const call = vi.mocked(callGateway).mock.calls[0];
  if (!call) {
    throw new Error("expected gateway call");
  }
  const params = call[0].params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("expected gateway params");
  }
  return params as Record<string, unknown>;
}

function currentNonRecoveryOwners(...tokens: string[]) {
  return {
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    tokens: tokens.length > 0 ? tokens : ["foreground-token"],
  };
}

describe("main-session-restart-recovery", () => {
  it("marks only matching running main sessions by active session key", async () => {
    // Only top-level running main sessions are restart-recoverable. Completed,
    // child, cron, and non-active sessions must not be marked.
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "cron:nightly": {
        sessionId: "cron-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:other": {
        sessionId: "other-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    registerAgentRunContext("restart-run", {
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });
    registerAgentRunContext("key-only-run", {
      sessionKey: "agent:main:main",
    });
    registerAgentRunContext("stale-session-run", {
      sessionKey: "agent:main:main",
      sessionId: "stale-session",
    });
    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main", "agent:main:completed", "agent:main:subagent:child"],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
    expect(store["agent:main:completed"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      { runId: "key-only-run", lifecycleGeneration },
      { runId: "restart-run", lifecycleGeneration },
    ]);
  });

  it("marks active sessions in a configured custom session store", async () => {
    const storePath = path.join(tmpDir, "custom", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:issue-82433": {
        sessionId: "custom-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });
    await writeTranscript(path.dirname(storePath), "custom-session", [
      { role: "user", content: "continue this custom-store turn" },
      { role: "toolResult", content: "custom result" },
    ]);

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionKeys: ["agent:main:issue-82433"],
    });

    const store = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:issue-82433"]?.abortedLastRun).toBe(true);

    const recovery = await recoverRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
    });

    expect(recovery).toEqual({ recovered: 1, failed: 0, skipped: 0 });
  });

  it("persists abort-registry runs after their event context was cleared", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "cleared-context-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "cleared-context-run",
        lifecycleGeneration: "pre-restart",
      },
    ]);
  });

  it("marks queued abort-registry runs before lifecycle start changes session status", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
        startedAt: 1_000,
        endedAt: 2_000,
        runtimeMs: 1_000,
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "queued-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]).toEqual(
      expect.objectContaining({
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "queued-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      }),
    );
    expect(store["agent:main:main"]?.startedAt).toBeUndefined();
    expect(store["agent:main:main"]?.endedAt).toBeUndefined();
    expect(store["agent:main:main"]?.runtimeMs).toBeUndefined();
  });

  it("marks queued registered runs before lifecycle start without explicit candidates", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
    });
    registerAgentRunContext("queued-context-run", {
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]).toEqual(
      expect.objectContaining({
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "queued-context-run",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        ],
      }),
    );
  });

  it("does not reopen a queued run that completed before store persistence", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "done",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "completed-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
      isActiveRun: () => false,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("does not reopen a session completed after a failed terminal persistence candidate", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: 3_000,
        status: "done",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "failed-persistence-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          observedAt: 2_000,
        },
      ],
      isActiveRun: () => true,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("does not reopen a terminal row written at the observed event timestamp", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: 2_000,
        status: "done",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "just-persisted-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          observedAt: 2_000,
        },
      ],
      isActiveRun: () => true,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("does not reopen a completed session via current-generation maintenance-expired abort controller", async () => {
    const sessionsDir = await makeSessionsDir();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: 3_000,
        status: "done",
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "stale-abort-controller-run",
          lifecycleGeneration,
          sessionKey: "agent:main:main",
          sessionId: "main-session",
          observedAt: 5_000,
        },
      ],
      isActiveRun: () => true,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]?.restartRecoveryRuns).toBeUndefined();
  });

  it("does not charge another recovery attempt for an already marked session", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });

    const result = await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "repeat-restart-run",
          lifecycleGeneration: "pre-restart",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
  });

  it("preserves current-generation markers across repeated restart marking", async () => {
    const sessionsDir = await makeSessionsDir();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        restartRecoveryRuns: [
          {
            runId: "first-restart-run",
            lifecycleGeneration,
          },
        ],
      },
    });

    await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "second-restart-run",
          lifecycleGeneration,
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "first-restart-run",
        lifecycleGeneration,
      },
      {
        runId: "second-restart-run",
        lifecycleGeneration,
      },
    ]);
  });

  it("preserves prior-generation restart recovery markers across repeated restart marking", async () => {
    const sessionsDir = await makeSessionsDir();
    const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        restartRecoveryRuns: [
          {
            runId: "initial-wedged-run",
            lifecycleGeneration: "previous-generation",
          },
          {
            runId: "first-recovery-run",
            lifecycleGeneration: "previous-recovery-generation",
          },
        ],
      },
    });

    await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "second-recovery-run",
          lifecycleGeneration: currentLifecycleGeneration,
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "first-recovery-run",
        lifecycleGeneration: "previous-recovery-generation",
      },
      {
        runId: "initial-wedged-run",
        lifecycleGeneration: "previous-generation",
      },
      {
        runId: "second-recovery-run",
        lifecycleGeneration: currentLifecycleGeneration,
      },
    ]);
  });

  it("replaces an older marker when the same run id is active after another restart", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        restartRecoveryRuns: [
          {
            runId: "shared-run",
            lifecycleGeneration: "first-generation",
          },
        ],
      },
    });

    await markRestartAbortedMainSessions({
      stateDir: tmpDir,
      sessionKeys: ["agent:main:main"],
      sessionIds: ["main-session"],
      activeRuns: [
        {
          runId: "shared-run",
          lifecycleGeneration: "second-generation",
          sessionKey: "agent:main:main",
          sessionId: "main-session",
        },
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      {
        runId: "shared-run",
        lifecycleGeneration: "second-generation",
      },
    ]);
  });

  it("uses active session ids to avoid marking stale duplicate keys in another store", async () => {
    // Custom and default stores can contain the same session key. Active ids
    // keep restart marking tied to the store that owned the interrupted run.
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:issue-82433": {
        sessionId: "stale-default-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const storePath = path.join(tmpDir, "custom-duplicate-key", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:issue-82433": {
        sessionId: "active-custom-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionIds: ["active-custom-session"],
      sessionKeys: ["agent:main:issue-82433"],
    });

    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(defaultStore["agent:main:issue-82433"]?.abortedLastRun).toBeUndefined();
    expect(customStore["agent:main:issue-82433"]?.abortedLastRun).toBe(true);
  });

  it("marks custom-store sessions by session id when no session key is available", async () => {
    const storePath = path.join(tmpDir, "custom-by-id", "sessions.json");
    await writeStorePath(storePath, {
      "agent:main:custom-by-id": {
        sessionId: "custom-session-id-only",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessions({
      cfg: { session: { store: storePath } },
      stateDir: tmpDir,
      sessionIds: ["custom-session-id-only"],
    });

    const store = readStore(storePath);
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:custom-by-id"]?.abortedLastRun).toBe(true);
  });

  it("marks only main running sessions whose transcript lock was cleaned", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "agent:main:other": {
        sessionId: "other-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLock(sessionsDir, "main-session"),
        cleanedLock(sessionsDir, "child-session"),
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 1 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:other"]?.abortedLastRun).toBeUndefined();
  });

  it("marks a running main session whose cleaned transcript lock is topic-suffixed", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "main-session";
    const sessionFile = `${sessionId}-topic-1234567890.jsonl`;
    await writeStore(sessionsDir, {
      "agent:main:discord:channel:123:thread:1234567890": {
        sessionId,
        sessionFile,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLockForPath(path.join(sessionsDir, `${sessionFile}.lock`))],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:discord:channel:123:thread:1234567890"]?.abortedLastRun).toBe(true);
  });

  it("does not mark a session for an unrelated topic lock that only shares its id prefix", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        sessionFile: "main-session.jsonl",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLockForPath(path.join(sessionsDir, "main-session-topic-unrelated.jsonl.lock")),
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 0, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBeUndefined();
  });

  it("normalizes relative cleaned lock paths against the current working directory", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "main-session";
    const sessionFile = `${sessionId}-topic-1234567890.jsonl`;
    await writeStore(sessionsDir, {
      "agent:main:discord:channel:123:thread:1234567890": {
        sessionId,
        sessionFile,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [
        cleanedLockForPath(
          path.relative(process.cwd(), path.join(sessionsDir, `${sessionFile}.lock`)),
        ),
      ],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:discord:channel:123:thread:1234567890"]?.abortedLastRun).toBe(true);
  });

  it("falls back to the session id transcript lock when persisted sessionFile is outside the sessions dir", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        sessionFile: "../stale/outside.jsonl",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLock(sessionsDir, "main-session")],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("falls back to the session id transcript lock when persisted sessionFile belongs to another generated session", async () => {
    const sessionsDir = await makeSessionsDir();
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const otherSessionId = "22222222-2222-4222-8222-222222222222";
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId,
        sessionFile: `${otherSessionId}.jsonl`,
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });

    const result = await markRestartAbortedMainSessionsFromLocks({
      sessionsDir,
      cleanedLocks: [cleanedLock(sessionsDir, sessionId)],
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(result).toEqual({ marked: 1, skipped: 0 });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
  });

  it("tombstones exhausted restart-aborted sessions before resume", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          automaticAttempts: 3,
          lastAttemptAt: Date.now() - 1_000,
          lastRunId: "recovery-run-3",
        },
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          threadId: "thread-1",
        },
      },
    });
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      const store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
      expect(store["agent:main:main"]?.status).toBe("failed");
      expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
      return {};
    });

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | { method?: string; params?: Record<string, unknown> }
      | undefined;
    expect(gatewayCall?.method).toBe("message.action");
    expect(gatewayCall?.params).toMatchObject({
      channel: "discord",
      action: "send",
      accountId: "main",
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });
    expect(gatewayCall?.params?.params).toMatchObject({
      to: "discord:dm:123",
      threadId: "thread-1",
      bestEffort: true,
    });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.endedAt).toEqual(expect.any(Number));
    expect(store["agent:main:main"]?.runtimeMs).toBe(0);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 3,
      wedgedAt: expect.any(Number),
      wedgedReason: expect.stringContaining("accepted resume attempts"),
    });
    expect(recoveryTestView(store["agent:main:main"])?.wedgedReason).not.toContain("doctor --fix");
  });

  it("does not warn or tombstone a row replaced before the exhaustion claim", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          automaticAttempts: 3,
          lastAttemptAt: Date.now() - 1_000,
          lastRunId: "recovery-run-3",
        },
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    const accessorSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementationOnce(async (params) => {
        const store = readSessionStoreForTest(storePath);
        await writeSessionStoreForTestAsync(storePath, {
          ...store,
          "agent:main:main": {
            ...store["agent:main:main"],
            sessionId: "new-main-session",
            updatedAt: Date.now(),
            status: "running",
            abortedLastRun: true,
            mainRestartRecovery: {
              automaticAttempts: 1,
              lastAttemptAt: Date.now(),
              lastRunId: "new-recovery-run",
            },
          },
        });
        return await applySessionEntryReplacements(params);
      });

    let result: Awaited<ReturnType<typeof recoverRestartAbortedMainSessions>>;
    try {
      result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });
    } finally {
      accessorSpy.mockRestore();
    }

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]?.sessionId).toBe("new-main-session");
    expect(store["agent:main:main"]?.status).toBe("running");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 1,
    });
    expect(recoveryTestView(store["agent:main:main"])?.wedgedAt).toBeUndefined();
  });

  it("does not tombstone a same-session row admitted before the exhaustion claim", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const scannedAt = Date.now() - 10_000;
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: scannedAt,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          automaticAttempts: 3,
          lastAttemptAt: scannedAt - 1_000,
          lastRunId: "recovery-run-3",
        },
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    const accessorSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockImplementationOnce(async (params) => {
        const store = readSessionStoreForTest(storePath);
        await writeSessionStoreForTestAsync(storePath, {
          ...store,
          "agent:main:main": {
            ...store["agent:main:main"],
            updatedAt: scannedAt,
            lastInteractionAt: scannedAt,
            mainRestartRecovery: {
              ...store["agent:main:main"]?.mainRestartRecovery,
              foregroundClaims: currentNonRecoveryOwners(),
            },
          },
        });
        return await applySessionEntryReplacements(params);
      });

    let result: Awaited<ReturnType<typeof recoverRestartAbortedMainSessions>>;
    try {
      result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });
    } finally {
      accessorSpy.mockRestore();
    }

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      sessionId: "main-session",
      updatedAt: scannedAt,
      lastInteractionAt: scannedAt,
      status: "running",
      abortedLastRun: true,
    });
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 3,
      nonRecoveryOwners: currentNonRecoveryOwners(),
    });
    expect(recoveryTestView(store["agent:main:main"])?.wedgedAt).toBeUndefined();
  });

  it("starts a fresh durable budget for released rows with only lifecycle markers", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
          { runId: "recovery-run-1", lifecycleGeneration: "gen-2" },
          { runId: "recovery-run-2", lifecycleGeneration: "gen-3" },
          { runId: "recovery-run-3", lifecycleGeneration: "gen-4" },
        ],
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"), { skipCache: true });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 1,
      lastAttemptAt: expect.any(Number),
      lastRunId: expect.any(String),
    });
  });

  it("persists the durable recovery attempt before dispatching the accepted run", async () => {
    const sessionsDir = await makeSessionsDir();
    let attemptDuringDispatch: SessionEntry["mainRestartRecovery"];
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    vi.mocked(callGateway).mockImplementationOnce(async (request) => {
      const store = loadSessionStore(path.join(sessionsDir, "sessions.json"), {
        skipCache: true,
      });
      attemptDuringDispatch = store["agent:main:main"]?.mainRestartRecovery;
      const gatewayParams = request.params as Record<string, unknown>;
      expect(gatewayParams.sessionId).toBe("main-session");
      expect(gatewayParams.idempotencyKey).toBe(attemptDuringDispatch?.reservation?.runId);
      return await acceptRecoveryGatewayRequest(request);
    });

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(attemptDuringDispatch).toMatchObject({
      attempts: { charged: 1, lastAt: expect.any(Number) },
      reservation: { runId: expect.any(String), attempt: 1 },
    });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"), {
      skipCache: true,
    });
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 1,
      lastAttemptAt: expect.any(Number),
      lastRunId: expect.any(String),
    });
  });

  it("does not recreate main recovery state when the accepted run already cleared it", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    vi.mocked(callGateway).mockImplementationOnce(async (request) => {
      const store = readSessionStoreForTest(storePath);
      expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
        automaticAttempts: 1,
        lastRunId: expect.any(String),
      });
      await acceptRecoveryGatewayRequest(request);
      const admittedStore = readSessionStoreForTest(storePath);
      await writeSessionStoreForTestAsync(storePath, {
        ...admittedStore,
        "agent:main:main": {
          ...admittedStore["agent:main:main"],
          status: "done",
          abortedLastRun: false,
          endedAt: Date.now(),
          runtimeMs: 1_000,
          restartRecoveryRuns: undefined,
          mainRestartRecovery: undefined,
        },
      });
      return { runId: String(request.params?.idempotencyKey ?? "") };
    });

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
    expect(store["agent:main:main"]).not.toHaveProperty("restartRecoveryRuns");
  });

  it("does not reserve recovery when the scanned row was already cleared", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    const readSessionMessagesAsync = sessionTranscriptReaders.readSessionMessagesAsync;
    vi.spyOn(sessionTranscriptReaders, "readSessionMessagesAsync").mockImplementationOnce(
      async (...args) => {
        const messages = await readSessionMessagesAsync(...args);
        const store = readSessionStoreForTest(storePath);
        await writeSessionStoreForTestAsync(storePath, {
          ...store,
          "agent:main:main": {
            ...store["agent:main:main"],
            status: "done",
            abortedLastRun: false,
            endedAt: Date.now(),
            runtimeMs: 1_000,
            restartRecoveryRuns: undefined,
            mainRestartRecovery: undefined,
          },
        });
        return messages;
      },
    );

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]?.status).toBe("done");
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
    expect(store["agent:main:main"]).not.toHaveProperty("restartRecoveryRuns");
  });

  it("does not reserve recovery after the same session is admitted during transcript read", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const scannedAt = Date.now() - 10_000;
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: scannedAt,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    const readSessionMessagesAsync = sessionTranscriptReaders.readSessionMessagesAsync;
    vi.spyOn(sessionTranscriptReaders, "readSessionMessagesAsync").mockImplementationOnce(
      async (...args) => {
        const messages = await readSessionMessagesAsync(...args);
        const store = readSessionStoreForTest(storePath);
        await writeSessionStoreForTestAsync(storePath, {
          ...store,
          "agent:main:main": {
            ...store["agent:main:main"],
            updatedAt: scannedAt,
            lastInteractionAt: scannedAt,
            mainRestartRecovery: { nonRecoveryOwners: currentNonRecoveryOwners() },
          },
        });
        return messages;
      },
    );

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      sessionId: "main-session",
      updatedAt: scannedAt,
      lastInteractionAt: scannedAt,
      status: "running",
      abortedLastRun: true,
    });
    expect(recoveryTestView(store["agent:main:main"])?.nonRecoveryOwners).toEqual(
      currentNonRecoveryOwners(),
    );
  });

  it("skips a row already owned by non-recovery work in the current generation", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: { nonRecoveryOwners: currentNonRecoveryOwners() },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("allows recovery after a non-recovery owner generation expires", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          nonRecoveryOwners: {
            lifecycleGeneration: `${getAgentEventLifecycleGeneration()}-previous`,
            tokens: ["previous-owner-token"],
          },
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"), { skipCache: true });
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 1,
      lastRunId: expect.any(String),
    });
    expect(recoveryTestView(store["agent:main:main"])?.nonRecoveryOwners).toBeUndefined();
  });

  it("does not overwrite a concurrent main recovery reservation", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          automaticAttempts: 1,
          lastAttemptAt: Date.now() - 1_000,
          lastRunId: "recovery-run-1",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    const readSessionMessagesAsync = sessionTranscriptReaders.readSessionMessagesAsync;
    vi.spyOn(sessionTranscriptReaders, "readSessionMessagesAsync").mockImplementationOnce(
      async (...args) => {
        const messages = await readSessionMessagesAsync(...args);
        const store = readSessionStoreForTest(storePath);
        await writeSessionStoreForTestAsync(storePath, {
          ...store,
          "agent:main:main": {
            ...store["agent:main:main"],
            mainRestartRecovery: {
              automaticAttempts: 2,
              lastAttemptAt: Date.now(),
              lastRunId: "other-reservation",
            },
          },
        });
        return messages;
      },
    );

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]?.status).toBe("running");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 2,
    });
  });

  it("charges accepted recovery dispatches with a restart recovery marker", async () => {
    const sessionsDir = await makeSessionsDir();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
          { runId: "recovery-run-1", lifecycleGeneration: "gen-2" },
        ],
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"), { skipCache: true });
    expect(store["agent:main:main"]?.restartRecoveryRuns).toEqual([
      { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
      { runId: "recovery-run-1", lifecycleGeneration: "gen-2" },
      { runId: expect.any(String), lifecycleGeneration },
    ]);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 1,
      lastAttemptAt: expect.any(Number),
      lastRunId: expect.any(String),
    });
  });

  it("rolls back a durable attempt when Gateway rejects the dispatched request", async () => {
    vi.mocked(callGateway).mockImplementationOnce(async (request) => {
      request.onDispatched?.();
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "restart recovery reservation is stale",
      });
    });
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({ automaticAttempts: 0 });
  });

  it("retains a durable attempt for an unclassified post-dispatch failure", async () => {
    vi.mocked(callGateway).mockImplementationOnce(async (request) => {
      request.onDispatched?.();
      throw new Error("gateway request timeout for agent");
    });
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"), { skipCache: true });
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 1,
      lastAttemptAt: expect.any(Number),
      lastRunId: expect.any(String),
    });
  });

  it("does not roll back over a replacement written after reservation", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      const store = readSessionStoreForTest(storePath);
      expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
        automaticAttempts: 1,
        lastRunId: expect.any(String),
      });
      await writeSessionStoreForTestAsync(storePath, {
        ...store,
        "agent:main:main": {
          sessionId: "replacement-session",
          updatedAt: Date.now(),
          status: "running",
          abortedLastRun: true,
          mainRestartRecovery: {
            automaticAttempts: 2,
            lastAttemptAt: Date.now(),
            lastRunId: "replacement-reservation",
          },
        },
      });
      throw new Error("gateway unavailable before dispatch");
    });

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      sessionId: "replacement-session",
      status: "running",
      abortedLastRun: true,
    });
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({ automaticAttempts: 2 });
  });

  it("refunds a reservation without clobbering a same-millisecond admission", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const scannedAt = Date.now() - 10_000;
    let admittedAt = 0;
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: scannedAt,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    vi.mocked(callGateway).mockImplementationOnce(async () => {
      const store = readSessionStoreForTest(storePath);
      const reservedEntry = store["agent:main:main"];
      if (!reservedEntry) {
        throw new Error("expected reserved main session");
      }
      expect(reservedEntry.mainRestartRecovery).toMatchObject({
        attempts: { charged: 1 },
        reservation: { runId: expect.any(String) },
      });
      admittedAt = reservedEntry.updatedAt;
      await writeSessionStoreForTestAsync(storePath, {
        ...store,
        "agent:main:main": {
          ...reservedEntry,
          updatedAt: admittedAt,
          lastInteractionAt: admittedAt,
          mainRestartRecovery: {
            ...reservedEntry.mainRestartRecovery,
            foregroundClaims: currentNonRecoveryOwners(),
          },
        },
      });
      throw new Error("gateway unavailable before dispatch");
    });

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      sessionId: "main-session",
      updatedAt: admittedAt,
      lastInteractionAt: admittedAt,
      status: "running",
      abortedLastRun: true,
    });
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 0,
      nonRecoveryOwners: currentNonRecoveryOwners(),
    });
  });

  it("rolls back a durable attempt when Gateway fails before dispatch", async () => {
    vi.mocked(callGateway).mockRejectedValueOnce(new Error("gateway unavailable before dispatch"));
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"), { skipCache: true });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({ automaticAttempts: 0 });
  });

  it("fails unreadable transcript paths without creating durable recovery state", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
          { runId: "previous-recovery-run", lifecycleGeneration: "gen-2" },
        ],
      },
    });
    await fs.mkdir(path.join(sessionsDir, "main-session.jsonl"));

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"), { skipCache: true });
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.endedAt).toEqual(expect.any(Number));
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
  });

  it("does not fail or notify a same-session row admitted before transcript read fails", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const scannedAt = Date.now() - 10_000;
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: scannedAt,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
    vi.spyOn(sessionTranscriptReaders, "readSessionMessagesAsync").mockImplementationOnce(
      async () => {
        const store = readSessionStoreForTest(storePath);
        await writeSessionStoreForTestAsync(storePath, {
          ...store,
          "agent:main:main": {
            ...store["agent:main:main"],
            updatedAt: scannedAt,
            lastInteractionAt: scannedAt,
            mainRestartRecovery: { nonRecoveryOwners: currentNonRecoveryOwners() },
          },
        });
        throw new Error("transcript unavailable");
      },
    );

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      sessionId: "main-session",
      updatedAt: scannedAt,
      lastInteractionAt: scannedAt,
      status: "running",
      abortedLastRun: true,
    });
    expect(recoveryTestView(store["agent:main:main"])?.nonRecoveryOwners).toEqual(
      currentNonRecoveryOwners(),
    );
  });

  it("does not charge the durable fuse after scheduled dispatch failures", async () => {
    vi.mocked(callGateway)
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockRejectedValueOnce(new Error("gateway unavailable"));
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);

    scheduleRestartAbortedMainSessionRecovery({
      stateDir: tmpDir,
      delayMs: 0,
      maxRetries: 3,
    });
    let store = loadSessionStore(path.join(sessionsDir, "sessions.json"), { skipCache: true });
    for (let i = 0; i < 100; i++) {
      const recovery = recoveryTestView(store["agent:main:main"]);
      if (vi.mocked(callGateway).mock.calls.length === 3 && recovery?.automaticAttempts === 0) {
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
      store = loadSessionStore(path.join(sessionsDir, "sessions.json"), { skipCache: true });
    }

    expect(callGateway).toHaveBeenCalledTimes(3);
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]?.status).toBe("running");
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({ automaticAttempts: 0 });
  });

  it("resumes marked sessions with a tool-result transcript tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const resumeParams = firstGatewayParams();
    expect(resumeParams.sessionKey).toBe("agent:main:main");
    expect(resumeParams.deliver).toBe(false);
    expect(resumeParams.lane).toBe("main");
    expect(resumeParams.inputProvenance).toEqual({
      kind: "internal_system",
      sourceSessionKey: "agent:main:main",
      sourceTool: "main_session_restart_recovery",
    });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 1,
      lastAttemptAt: expect.any(Number),
      lastRunId: expect.any(String),
    });
  });

  it("delivers resumed marked sessions through the current run recovery context", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        deliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          threadId: 123,
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    const resumeParams = firstGatewayParams();
    expect(resumeParams).toMatchObject({
      sessionKey: "agent:main:discord:direct:123",
      deliver: true,
      bestEffortDeliver: true,
      lane: "main",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      threadId: "123",
    });
  });

  it("does not infer restart delivery from historical session routes", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        deliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().deliver).toBe(false);
  });

  it("does not deliver restart recovery when session send policy denies sends", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:discord:direct:123": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      cfg: { session: { sendPolicy: { default: "deny" } } },
      stateDir: tmpDir,
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().deliver).toBe(false);
  });

  it("fails marked sessions with stale approval-pending exec tool results", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run a command that needs approval" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      {
        role: "toolResult",
        content: "Approval required (id stale, full stale-approval-id).",
        details: {
          status: "approval-pending",
          approvalId: "stale-approval-id",
          host: "gateway",
          command: "echo stale",
        },
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
  });

  it("does not fail or notify a same-session row admitted during resume preflight", async () => {
    const sessionsDir = await makeSessionsDir();
    const storePath = path.join(sessionsDir, "sessions.json");
    const scannedAt = Date.now() - 10_000;
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: scannedAt,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish this turn" },
      { role: "assistant", content: "already finished" },
    ]);
    const readSessionMessagesAsync = sessionTranscriptReaders.readSessionMessagesAsync;
    vi.spyOn(sessionTranscriptReaders, "readSessionMessagesAsync").mockImplementationOnce(
      async (...args) => {
        const messages = await readSessionMessagesAsync(...args);
        const store = readSessionStoreForTest(storePath);
        await writeSessionStoreForTestAsync(storePath, {
          ...store,
          "agent:main:main": {
            ...store["agent:main:main"],
            updatedAt: scannedAt,
            lastInteractionAt: scannedAt,
            mainRestartRecovery: { nonRecoveryOwners: currentNonRecoveryOwners() },
          },
        });
        return messages;
      },
    );

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 1 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = readSessionStoreForTest(storePath);
    expect(store["agent:main:main"]).toMatchObject({
      sessionId: "main-session",
      updatedAt: scannedAt,
      lastInteractionAt: scannedAt,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: { nonRecoveryOwners: currentNonRecoveryOwners() },
    });
  });

  it("resumes marked sessions with a durable pending final delivery payload (Phase 2)", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = "The final answer is 42.";
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryForceSafeTools: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: pendingPayload,
        pendingFinalDeliveryContext: {
          channel: "discord",
          to: "discord:dm:final",
          accountId: "main",
        },
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:dm:stale",
          accountId: "old",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(firstGatewayParams()).toMatchObject({
      deliver: true,
      bestEffortDeliver: true,
      channel: "discord",
      to: "discord:dm:final",
      accountId: "main",
      forceRestartSafeTools: true,
    });
    expect(firstGatewayParams().message).toContain(pendingPayload);

    const beforeStoreRead = Date.now();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    const entry = store["agent:main:main"];
    expect(entry?.abortedLastRun).toBe(false);
    expect(entry?.pendingFinalDelivery).toBe(true);
    expect(entry?.pendingFinalDeliveryText).toBe(pendingPayload);
    expect(entry?.pendingFinalDeliveryAttemptCount).toBe(1);
    expect(entry?.pendingFinalDeliveryLastError).toBeNull();
    expect(entry?.restartRecoveryForceSafeTools).toBe(true);
    expect(entry?.pendingFinalDeliveryCreatedAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt).toBeLessThanOrEqual(beforeStoreRead);
    expect(entry?.pendingFinalDeliveryLastAttemptAt ?? 0).toBeGreaterThanOrEqual(
      entry?.pendingFinalDeliveryCreatedAt ?? Number.POSITIVE_INFINITY,
    );
  });

  it("retains restart safety when the first restart follows pending final persistence", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "Safe work finished.",
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "completed", value: "done", replaySafe: true }),
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Safe work finished." }] },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.restartRecoveryForceSafeTools).toBe(true);
  });

  it("sanitizes durable pending final delivery payloads before resume prompts", async () => {
    const sessionsDir = await makeSessionsDir();
    const pendingPayload = [
      "The final answer is 42.",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "internal recovery detail",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-1"}',
      "```",
    ].join("\n");
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: pendingPayload,
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "calculate the answer" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "calc" }] },
      { role: "toolResult", content: "42" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().message).toContain("The final answer is 42.");
    expect(firstGatewayParams().message).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
    expect(firstGatewayParams().message).not.toContain("Conversation info");

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.pendingFinalDeliveryText).toBe("The final answer is 42.");
  });

  it("resumes an unguarded pending final delivery without a transcript", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "missing-transcript-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "The durable final answer.",
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams().message).toContain("The durable final answer.");
    expect(firstGatewayParams()).not.toHaveProperty("forceRestartSafeTools");
  });

  it("resumes pending final delivery even when the transcript tail is assistant output", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "assistant final was already captured",
        pendingFinalDeliveryCreatedAt: Date.now() - 5_000,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "finish" },
      { role: "assistant", content: "assistant final was already captured" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(firstGatewayParams().message).toContain("assistant final was already captured");
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("running");
    expect(store["agent:main:main"]?.pendingFinalDelivery).toBe(true);
    expect(store["agent:main:main"]?.pendingFinalDeliveryText).toBe(
      "assistant final was already captured",
    );
  });

  it("does not scan ordinary running sessions without the restart-aborted marker", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "current process owns this" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("skips restart-aborted sessions that a current process owns", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:active-key": {
        sessionId: "active-key-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
      "agent:main:active-id": {
        sessionId: "active-id-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
      "agent:main:recoverable": {
        sessionId: "recoverable-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "active-key-session", [
      { role: "user", content: "new run owns this key" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "active-id-session", [
      { role: "user", content: "new run owns this id" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "recoverable-session", [
      { role: "user", content: "recover this one" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 2 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:active-key"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-id"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:recoverable"]?.abortedLastRun).toBe(false);
  });

  it("recovers duplicate-key restart-aborted rows when the active run owns a different session id", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "stale-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "stale-session", [
      { role: "user", content: "recover the stale duplicate" },
      { role: "toolResult", content: "done" },
    ]);

    const result = await recoverRestartAbortedMainSessions({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:main"],
      activeSessionIds: ["new-current-session"],
    });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("marks startup-orphaned running main sessions before recovery", async () => {
    const sessionsDir = await makeSessionsDir();
    const cutoff = Date.now();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:active-key": {
        sessionId: "active-key-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:active-id": {
        sessionId: "active-id-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:fresh": {
        sessionId: "fresh-session",
        updatedAt: cutoff + 1,
        status: "running",
      },
      "agent:main:subagent:child": {
        sessionId: "child-session",
        updatedAt: cutoff - 10_000,
        status: "running",
        spawnDepth: 1,
      },
      "agent:main:cron:nightly": {
        sessionId: "cron-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
      "agent:main:completed": {
        sessionId: "completed-session",
        updatedAt: cutoff - 10_000,
        status: "done",
        restartRecoveryRuns: [
          {
            runId: "completed-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
      "agent:main:already-marked": {
        sessionId: "already-marked-session",
        updatedAt: cutoff - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "marked-prior-process-run",
            lifecycleGeneration: "prior-process",
          },
        ],
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "run the tool" },
      { role: "toolResult", content: "done" },
    ]);
    await writeTranscript(sessionsDir, "already-marked-session", [
      { role: "user", content: "already interrupted" },
      { role: "toolResult", content: "done" },
    ]);

    const marked = await markStartupOrphanedMainSessionsForRecovery({
      stateDir: tmpDir,
      activeSessionKeys: ["agent:main:active-key"],
      activeSessionIds: ["active-key-session", "active-id-session"],
      updatedBeforeMs: cutoff,
    });

    expect(marked).toEqual({ marked: 1, skipped: 2 });
    let store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:active-key"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:active-id"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:fresh"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:subagent:child"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:cron:nightly"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:completed"]?.abortedLastRun).toBeUndefined();
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
    expect(store["agent:main:already-marked"]).not.toHaveProperty("mainRestartRecovery");
    expect(store["agent:main:completed"]?.restartRecoveryRuns).toHaveLength(1);
    expect(store["agent:main:already-marked"]?.restartRecoveryRuns).toHaveLength(1);

    const recovered = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(recovered).toEqual({ recovered: 2, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledTimes(2);
    store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.abortedLastRun).toBe(false);
    expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
      automaticAttempts: 1,
      lastRunId: "run-resumed",
    });
    expect(store["agent:main:already-marked"]?.abortedLastRun).toBe(false);
    expect(recoveryTestView(store["agent:main:already-marked"])).toMatchObject({
      automaticAttempts: 1,
      lastRunId: "run-resumed",
    });
  });

  it("tombstones startup-orphaned main sessions after slow accepted recovery re-wedges", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const firstBoot = new Date("2026-06-09T10:00:00.000Z");
      vi.setSystemTime(firstBoot);
      vi.mocked(callGateway)
        .mockResolvedValueOnce({ runId: "slow-recovery-run-1" })
        .mockResolvedValueOnce({ runId: "slow-recovery-run-2" })
        .mockResolvedValueOnce({ runId: "slow-recovery-run-3" });
      const sessionsDir = await makeSessionsDir();
      await writeStore(sessionsDir, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now() - 10_000,
          status: "running",
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "run the tool" },
        { role: "toolResult", content: "done" },
      ]);

      await markStartupOrphanedMainSessionsForRecovery({
        stateDir: tmpDir,
        updatedBeforeMs: Date.now(),
      });
      expect(await recoverRestartAbortedMainSessions({ stateDir: tmpDir })).toEqual({
        recovered: 1,
        failed: 0,
        skipped: 0,
      });
      let store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
      expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
        automaticAttempts: 1,
        lastRunId: "slow-recovery-run-1",
      });

      vi.setSystemTime(new Date(firstBoot.getTime() + 5 * 60_000));
      await markStartupOrphanedMainSessionsForRecovery({
        stateDir: tmpDir,
        updatedBeforeMs: Date.now(),
      });
      expect(await recoverRestartAbortedMainSessions({ stateDir: tmpDir })).toEqual({
        recovered: 1,
        failed: 0,
        skipped: 0,
      });
      store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
      expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
        automaticAttempts: 2,
        lastRunId: "slow-recovery-run-2",
      });

      vi.setSystemTime(new Date(firstBoot.getTime() + 10 * 60_000));
      await markStartupOrphanedMainSessionsForRecovery({
        stateDir: tmpDir,
        updatedBeforeMs: Date.now(),
      });
      expect(await recoverRestartAbortedMainSessions({ stateDir: tmpDir })).toEqual({
        recovered: 1,
        failed: 0,
        skipped: 0,
      });
      store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
      expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
        automaticAttempts: 3,
        lastRunId: "slow-recovery-run-3",
      });

      vi.setSystemTime(new Date(firstBoot.getTime() + 15 * 60_000));
      await markStartupOrphanedMainSessionsForRecovery({
        stateDir: tmpDir,
        updatedBeforeMs: Date.now(),
      });
      expect(await recoverRestartAbortedMainSessions({ stateDir: tmpDir })).toEqual({
        recovered: 0,
        failed: 0,
        skipped: 1,
      });
      expect(callGateway).toHaveBeenCalledTimes(3);
      store = readSessionStoreForTest(path.join(sessionsDir, "sessions.json"));
      expect(store["agent:main:main"]?.status).toBe("failed");
      expect(recoveryTestView(store["agent:main:main"])).toMatchObject({
        automaticAttempts: 3,
        lastRunId: "slow-recovery-run-3",
        wedgedAt: expect.any(Number),
        wedgedReason: expect.stringContaining("accepted resume attempts"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers only the configured store for duplicate startup-orphaned session keys", async () => {
    const cutoff = Date.now();
    const defaultSessionsDir = await makeSessionsDir();
    await writeStore(defaultSessionsDir, {
      "agent:main:main": {
        sessionId: "default-main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });
    await writeTranscript(defaultSessionsDir, "default-main-session", [
      { role: "user", content: "continue default" },
      { role: "toolResult", content: "default result" },
    ]);

    const customStorePath = path.join(tmpDir, "custom-startup-duplicate", "sessions.json");
    await writeStorePath(customStorePath, {
      "agent:main:main": {
        sessionId: "custom-main-session",
        updatedAt: cutoff - 10_000,
        status: "running",
      },
    });
    await writeTranscript(path.dirname(customStorePath), "custom-main-session", [
      { role: "user", content: "continue custom" },
      { role: "toolResult", content: "custom result" },
    ]);

    const result = await recoverStartupOrphanedMainSessions({
      cfg: { session: { store: customStorePath } },
      stateDir: tmpDir,
      updatedBeforeMs: cutoff,
    });

    expect(result).toMatchObject({ marked: 2, recovered: 1, failed: 0 });
    // Discovery can revisit the non-routable default store through a canonical path alias.
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBeLessThanOrEqual(2);
    expect(callGateway).toHaveBeenCalledOnce();
    const defaultStore = readStore(path.join(defaultSessionsDir, "sessions.json"));
    const customStore = readStore(customStorePath);
    expect(defaultStore["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(customStore["agent:main:main"]?.abortedLastRun).toBe(false);
  });

  it("admits each scheduled recovery attempt as independent root work", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "interrupted response",
      },
    });

    const suspensionRef: {
      current: ReturnType<typeof tryBeginGatewaySuspendAdmission>;
    } = { current: null };
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        suspensionRef.current = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspensionRef.current?.commit()).toBe(true);
        throw new Error("retry after suspension");
      })
      .mockImplementationOnce(async () => {
        expect(getActiveGatewayRootWorkCount()).toBe(1);
        return { runId: "run-resumed" };
      });

    scheduleRestartAbortedMainSessionRecovery({
      delayMs: 0,
      maxRetries: 2,
      stateDir: tmpDir,
    });

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(suspensionRef.current?.release()).toBe(true);

    await vi.waitFor(() => {
      expect(callGateway).toHaveBeenCalledTimes(2);
      const entry = loadSessionEntry({
        storePath: path.join(sessionsDir, "sessions.json"),
        sessionKey: "agent:main:main",
      });
      expect(entry?.abortedLastRun).toBe(false);
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
  });

  it("fails an unresumable transcript tail without charging the retry budget", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial answer" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
    const store = loadSessionStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:main"]?.status).toBe("failed");
    expect(store["agent:main:main"]?.abortedLastRun).toBe(true);
    expect(store["agent:main:main"]).not.toHaveProperty("mainRestartRecovery");
  });

  it.each([
    [
      "completed assistant output",
      {
        role: "assistant",
        content: [{ type: "text", text: "finished answer" }],
        stopReason: "stop",
      },
    ],
    [
      "errored assistant output",
      {
        role: "assistant",
        content: [{ type: "text", text: "provider failed" }],
        stopReason: "error",
      },
    ],
    [
      "completed tool call",
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
        stopReason: "toolUse",
      },
    ],
    [
      "aborted tool call",
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
        stopReason: "aborted",
      },
    ],
    [
      "aborted assistant output with text",
      {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        stopReason: "aborted",
      },
    ],
  ])("does not resume %s at the transcript tail", async (_label, assistantMessage) => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      assistantMessage,
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("sends a visible notice through the legacy route when no resumable transcript survives", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:demo-channel:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        lastChannel: "discord",
        lastTo: "discord:channel:room-1",
        lastAccountId: "default",
        lastThreadId: "thread-1",
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "system", content: "session metadata only" },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | {
          method?: string;
          params?: Record<string, unknown>;
          clientName?: string;
          mode?: string;
        }
      | undefined;
    expect(gatewayCall?.method).toBe("message.action");
    expect(gatewayCall?.clientName).toBe("gateway-client");
    expect(gatewayCall?.mode).toBe("backend");
    expect(gatewayCall?.params).toMatchObject({
      channel: "discord",
      action: "send",
      accountId: "default",
      sessionKey: "agent:main:demo-channel:room-1",
      sessionId: "main-session",
    });
    expect(gatewayCall?.params?.params).toMatchObject({
      to: "discord:channel:room-1",
      threadId: "thread-1",
      bestEffort: true,
    });
    expect(String((gatewayCall?.params?.params as Record<string, unknown>)?.message)).toContain(
      "couldn't safely resume",
    );

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:demo-channel:room-1"]?.status).toBe("failed");
    expect(store["agent:main:demo-channel:room-1"]?.abortedLastRun).toBe(true);
  });

  it("resumes a restart interrupted at the Code Mode wait control", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:demo-channel:room-1": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryContext: {
          channel: "discord",
          to: "discord:channel:room-1",
          accountId: "default",
          threadId: "thread-1",
        },
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "waiting",
              runId: "cm_interrupted",
              reason: "yield",
              replaySafe: true,
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The read-only work is still pending." },
          { type: "text", text: "" },
          {
            type: "toolCall",
            id: "call-wait-1",
            name: "wait",
            arguments: { runId: "cm_interrupted" },
          },
        ],
        stopReason: "toolUse",
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    const gatewayCall = vi.mocked(callGateway).mock.calls[0]?.[0] as
      | {
          method?: string;
          params?: Record<string, unknown>;
        }
      | undefined;
    expect(gatewayCall?.method).toBe("agent");
    expect(gatewayCall?.params).toMatchObject({
      message: expect.stringContaining("Continue from the existing transcript"),
      deliver: true,
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:demo-channel:room-1",
      to: "discord:channel:room-1",
      threadId: "thread-1",
      bestEffortDeliver: true,
      forceRestartSafeTools: true,
    });

    const store = readStore(path.join(sessionsDir, "sessions.json"));
    expect(store["agent:main:demo-channel:room-1"]?.status).toBe("running");
    expect(store["agent:main:demo-channel:room-1"]?.abortedLastRun).toBe(false);
    expect(store["agent:main:demo-channel:room-1"]?.restartRecoveryForceSafeTools).toBe(true);
  });

  it("reads a provider-native Code Mode wait input", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "waiting",
              runId: "cm_interrupted",
              replaySafe: true,
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call-wait-1",
            name: "wait",
            input: { runId: "cm_interrupted" },
          },
        ],
        stopReason: "toolUse",
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it.each([
    {
      replaySafe: true,
      expected: { recovered: 1, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
    {
      replaySafe: false,
      expected: { recovered: 0, failed: 1, skipped: 0 },
      gatewayCalls: 0,
    },
  ])(
    "classifies a direct waiting checkpoint with replaySafe=$replaySafe",
    async ({ replaySafe, expected, gatewayCalls }) => {
      const sessionsDir = await makeSessionsDir();
      await writeStore(sessionsDir, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now() - 10_000,
          status: "running",
          abortedLastRun: true,
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing" },
        {
          role: "toolResult",
          toolName: "exec",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "waiting",
                runId: "cm_interrupted",
                replaySafe,
              }),
            },
          ],
        },
      ]);

      const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

      expect(result).toEqual(expected);
      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
      if (replaySafe) {
        expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
      }
    },
  );

  it.each(["completed", "failed"] as const)(
    "keeps restart safety after a terminal Code Mode %s result",
    async (status) => {
      const sessionsDir = await makeSessionsDir();
      await writeStore(sessionsDir, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now() - 10_000,
          status: "running",
          abortedLastRun: true,
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing" },
        {
          role: "toolResult",
          toolName: "wait",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status,
                replaySafe: true,
                ...(status === "completed" ? { value: "done" } : { error: "safe failure" }),
              }),
            },
          ],
        },
      ]);

      const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

      expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
      expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
    },
  );

  it("keeps restart safety across a second restart of the recovery turn", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryForceSafeTools: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "user",
        content:
          "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-read-1",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "read result" }],
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("keeps restart safety after the recovery prompt leaves the recent transcript window", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryForceSafeTools: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      ...Array.from({ length: 24 }, (_, index) => ({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: `read result ${index}` }],
      })),
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("resumes an in-flight safe tool call across a repeated restart", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryForceSafeTools: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I need one more read." },
          { type: "toolCall", id: "call-read-2", name: "read", arguments: { path: "README.md" } },
        ],
        stopReason: "toolUse",
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("does not resume completed assistant output just because the restart-safe guard remains", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryForceSafeTools: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "Done already." }] },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not treat a historical recovery prompt as current recovery state", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      {
        role: "user",
        content:
          "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.",
      },
      { role: "assistant", content: [{ type: "text", text: "Finished that recovery." }] },
      { role: "user", content: "a later request" },
      { role: "assistant", content: [{ type: "text", text: "Finished the later request." }] },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not replay visible assistant text beside a Code Mode wait", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "waiting",
              runId: "cm_interrupted",
              replaySafe: true,
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I already sent this part." },
          {
            type: "toolCall",
            id: "call-wait-1",
            name: "wait",
            arguments: { runId: "cm_interrupted" },
          },
        ],
        stopReason: "toolUse",
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "empty provider abort artifact",
      content: [],
      expected: { recovered: 1, failed: 0, skipped: 0 },
      gatewayCalls: 1,
    },
    {
      label: "provider abort artifact with partial output",
      content: [{ type: "text", text: "partial answer" }],
      expected: { recovered: 0, failed: 1, skipped: 0 },
      gatewayCalls: 0,
    },
  ])(
    "handles $label without discarding assistant output",
    async ({ content, expected, gatewayCalls }) => {
      const sessionsDir = await makeSessionsDir();
      await writeStore(sessionsDir, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now() - 10_000,
          status: "running",
          abortedLastRun: true,
        },
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "do the thing" },
        {
          role: "toolResult",
          toolName: "exec",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "waiting",
                runId: "cm_interrupted",
                replaySafe: true,
              }),
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-wait-1",
              name: "wait",
              arguments: { runId: "cm_interrupted" },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "assistant",
          content,
          stopReason: "error",
          errorMessage: "Request was aborted",
        },
      ]);

      const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

      expect(result).toEqual(expected);
      expect(callGateway).toHaveBeenCalledTimes(gatewayCalls);
    },
  );

  it("resumes through the shutdown error persisted for an interrupted Code Mode wait", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "wait",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "waiting",
              runId: "cm_interrupted",
              replaySafe: true,
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-wait-1",
            name: "wait",
            arguments: { runId: "cm_interrupted" },
          },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolName: "wait",
        toolCallId: "call-wait-1",
        content: [{ type: "text", text: "Error: The operation was aborted." }],
        details: {
          status: "failed",
          error: "Error: The operation was aborted.",
          code: "internal_error",
        },
        isError: true,
      },
      {
        role: "assistant",
        content: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it("keeps an unmatched failed wait restricted when its checkpoint is replay-safe", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "wait",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "waiting",
              runId: "cm_interrupted",
              replaySafe: true,
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-wait-1",
            name: "wait",
            arguments: { runId: "cm_interrupted" },
          },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolName: "wait",
        toolCallId: "call-other",
        content: [{ type: "text", text: "Error: The operation was aborted." }],
        details: {
          status: "failed",
          error: "Error: The operation was aborted.",
          code: "internal_error",
        },
        isError: true,
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 1, failed: 0, skipped: 0 });
    expect(firstGatewayParams()).toMatchObject({ forceRestartSafeTools: true });
  });

  it.each([
    {
      label: "non-replay-safe checkpoint",
      checkpoint: {
        status: "waiting",
        runId: "cm_interrupted",
        reason: "pending_tools",
        replaySafe: false,
      },
    },
    {
      label: "replay-safe checkpoint for another run",
      checkpoint: {
        status: "waiting",
        runId: "cm_other",
        reason: "yield",
        replaySafe: true,
      },
    },
  ])("does not resume a Code Mode wait after a $label", async ({ checkpoint }) => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "wait",
        content: [
          {
            type: "text",
            text: JSON.stringify(checkpoint),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-wait-1",
            name: "wait",
            arguments: { runId: "cm_interrupted" },
          },
        ],
        stopReason: "toolUse",
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("does not resume a mixed Code Mode wait and side-effecting tool tail", async () => {
    const sessionsDir = await makeSessionsDir();
    await writeStore(sessionsDir, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now() - 10_000,
        status: "running",
        abortedLastRun: true,
      },
    });
    await writeTranscript(sessionsDir, "main-session", [
      { role: "user", content: "do the thing" },
      {
        role: "toolResult",
        toolName: "exec",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "waiting",
              runId: "cm_interrupted",
              replaySafe: true,
            }),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-wait-1",
            name: "wait",
            arguments: { runId: "cm_interrupted" },
          },
          {
            type: "toolCall",
            id: "call-write-1",
            name: "write",
            arguments: { path: "result.txt", content: "done" },
          },
        ],
        stopReason: "toolUse",
      },
    ]);

    const result = await recoverRestartAbortedMainSessions({ stateDir: tmpDir });

    expect(result).toEqual({ recovered: 0, failed: 1, skipped: 0 });
    expect(callGateway).not.toHaveBeenCalled();
  });
});
