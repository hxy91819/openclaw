import { describe, expect, it } from "vitest";
import type { MainRestartRecoveryState, SessionEntry } from "../config/sessions.js";
import {
  buildMainSessionRecoveryClearPatch,
  inspectMainSessionRecovery,
  inspectMainSessionRecoveryHealth,
  projectMainSessionRecoveryLifecycle,
  transitionMainSessionRecovery,
} from "./main-session-recovery-state.js";

const sessionKey = "agent:main:main";
const storePath = "/tmp/sessions.json";

function recoveryState(
  overrides: Partial<MainRestartRecoveryState> = {},
): MainRestartRecoveryState {
  return {
    schemaVersion: 1,
    cycleId: "cycle-1",
    revision: 1,
    attempts: { charged: 0 },
    ...overrides,
  };
}

function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    status: "running",
    abortedLastRun: true,
    mainRestartRecovery: recoveryState(),
    ...overrides,
  };
}

describe("main session recovery state", () => {
  it("gives a legacy interrupted row a stable cycle before exposing it to a scan", () => {
    const entry = interruptedEntry({ mainRestartRecovery: undefined });

    const observed = transitionMainSessionRecovery(entry, {
      kind: "observe",
      cycleId: "legacy-cycle",
      lifecycleGeneration: "generation-1",
      sessionKey,
    });

    expect(observed).toEqual({
      kind: "observed",
      view: {
        status: "recoverable",
        observation: { sessionId: "session-1", cycleId: "legacy-cycle", revision: 1 },
        nextAttempt: 1,
      },
    });
    expect(entry.mainRestartRecovery).toEqual(recoveryState({ cycleId: "legacy-cycle" }));
  });

  it("charges at reservation and refunds only the matching reservation", () => {
    const entry = interruptedEntry();
    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
    });
    expect(prepared.kind).toBe("reserved");
    if (prepared.kind !== "reserved") {
      throw new Error("expected reservation");
    }

    const claim = transitionMainSessionRecovery(entry, {
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration: "generation-1",
      sessionId: "session-1",
      sessionKey,
      storePath,
      token: "foreground-1",
    });
    expect(claim.kind).toBe("foreground_claimed");

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "cancel_reservation",
        reservation: prepared.reservation,
      }),
    ).toEqual({ kind: "reservation_cancelled" });
    expect(entry.mainRestartRecovery).toMatchObject({
      attempts: { charged: 0 },
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-1"],
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("moves a reservation into the lifecycle fence during Gateway admission", () => {
    const entry = interruptedEntry({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: " captured reply ",
      mainRestartRecovery: recoveryState({
        revision: 2,
        attempts: { charged: 1, lastAt: 200 },
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          reservedAt: 200,
          lifecycleGeneration: "generation-1",
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-1",
        now: 300,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "admitted_recovery" });
    expect(entry).toMatchObject({
      abortedLastRun: false,
      pendingFinalDeliveryAttemptCount: 1,
      pendingFinalDeliveryLastAttemptAt: 300,
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: {
        revision: 3,
        attempts: { charged: 1, lastAt: 200 },
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("rejects a reservation created by an older lifecycle generation", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        revision: 2,
        attempts: { charged: 1, lastAt: 200 },
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          reservedAt: 200,
          lifecycleGeneration: "generation-old",
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-new",
        now: 300,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(entry.mainRestartRecovery?.reservation).toBeDefined();
    expect(entry.abortedLastRun).toBe(true);
  });

  it("rejects recovery admission while any current-generation foreground claim remains", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        revision: 4,
        attempts: { charged: 1 },
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          reservedAt: 200,
          lifecycleGeneration: "generation-1",
        },
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-1", "foreground-2"],
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-1",
        now: 300,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "rejected", reason: "foreground_active" });
  });

  it("expires foreground claims from an older lifecycle generation", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        foregroundClaims: {
          lifecycleGeneration: "generation-old",
          tokens: ["old-owner"],
        },
      }),
    });

    const view = inspectMainSessionRecovery({
      entry,
      lifecycleGeneration: "generation-new",
      sessionKey,
    });

    expect(view).toMatchObject({ status: "recoverable", nextAttempt: 1 });
  });

  it("retains the charge but releases a reservation orphaned by process restart", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        revision: 2,
        attempts: { charged: 1, lastAt: 200 },
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          reservedAt: 200,
          lifecycleGeneration: "generation-old",
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "observe",
        cycleId: "unused",
        lifecycleGeneration: "generation-new",
        sessionKey,
      }),
    ).toEqual({
      kind: "observed",
      view: {
        status: "recoverable",
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 3 },
        nextAttempt: 2,
      },
    });
    expect(entry.mainRestartRecovery).toMatchObject({
      revision: 3,
      attempts: { charged: 1, lastAt: 200 },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("rejects an old observation after a healthy clear and a new interrupted cycle", () => {
    const entry = interruptedEntry();
    const oldObservation = { sessionId: "session-1", cycleId: "cycle-1", revision: 1 };
    transitionMainSessionRecovery(entry, { kind: "clear" });
    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "cycle-2",
      now: 400,
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration: "generation-1",
        now: 500,
        observation: oldObservation,
        runId: "stale-run",
      }),
    ).toEqual({ kind: "rejected", reason: "stale_cycle" });
  });

  it("tombstones an exhausted cycle and exposes only the Doctor repair action", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        attempts: { charged: 3, lastAt: 300 },
      }),
    });
    const view = inspectMainSessionRecovery({
      entry,
      lifecycleGeneration: "generation-1",
      sessionKey,
    });
    expect(view.status).toBe("exhausted");
    if (view.status !== "exhausted") {
      throw new Error("expected exhausted cycle");
    }

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "tombstone",
        now: 400,
        observation: view.observation,
        reason: view.reason,
      }),
    ).toEqual({ kind: "tombstoned", reason: view.reason });
    expect(inspectMainSessionRecoveryHealth(entry)).toEqual({
      status: "tombstoned",
      reason: view.reason,
      repair: null,
    });

    entry.abortedLastRun = true;
    expect(inspectMainSessionRecoveryHealth(entry)).toMatchObject({
      status: "tombstoned",
      repair: "clear_stale_abort",
    });
    expect(transitionMainSessionRecovery(entry, { kind: "doctor_repair", now: 500 })).toEqual({
      kind: "doctor_repaired",
    });
    expect(entry.abortedLastRun).toBe(false);
  });

  it("owns lifecycle fence suppression, consumption, and healthy clearing", () => {
    const entry = interruptedEntry({
      restartRecoveryRuns: [
        { runId: "interrupted", lifecycleGeneration: "generation-1" },
        { runId: "recovery", lifecycleGeneration: "generation-1" },
      ],
    });
    expect(
      projectMainSessionRecoveryLifecycle({
        entry,
        event: {
          runId: "interrupted",
          lifecycleGeneration: "generation-1",
          data: { phase: "error", stopReason: "restart" },
        },
        snapshotPatch: { status: "failed" },
      }),
    ).toEqual({ action: "suppress" });

    expect(
      projectMainSessionRecoveryLifecycle({
        entry,
        event: {
          runId: "recovery",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
    });
  });

  it("builds an empty clear patch when no main recovery state exists", () => {
    expect(buildMainSessionRecoveryClearPatch({ abortedLastRun: false })).toEqual({});
  });
});
