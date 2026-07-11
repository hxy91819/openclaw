import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessionStore, saveSessionStore, type SessionEntry } from "../config/sessions.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";

const sessionKey = "agent:main:main";

describe("main session recovery store", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-main-recovery-store-"));
    storePath = path.join(dir, "sessions.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(entry: SessionEntry): Promise<void> {
    await saveSessionStore(storePath, { [sessionKey]: entry });
  }

  function read(): SessionEntry {
    return loadSessionStore(storePath, { skipCache: true })[sessionKey]!;
  }

  it("persists a cycle before returning a legacy interrupted observation", async () => {
    await write({
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });

    const result = await commitMainSessionRecovery({
      command: {
        kind: "observe",
        cycleId: "cycle-1",
        lifecycleGeneration: "generation-1",
        now: 200,
        sessionKey,
      },
      requireWriteSuccess: true,
      target: { sessionKey, storePath },
    });

    expect(result.transition).toMatchObject({
      kind: "observed",
      view: { status: "recoverable" },
    });
    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-1",
      revision: 1,
    });
  });

  it("preserves a concurrent foreground claim while cancelling its reservation", async () => {
    await write({
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        schemaVersion: 1,
        cycleId: "cycle-1",
        revision: 1,
        attempts: { charged: 0 },
      },
    });
    const reserved = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        now: 200,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "recovery-1",
      },
      target: { sessionKey, storePath },
    });
    expect(reserved.transition.kind).toBe("reserved");
    if (reserved.transition.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    await commitMainSessionRecovery({
      command: {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration: "generation-1",
        sessionId: "session-1",
        sessionKey,
        storePath,
        token: "foreground-1",
      },
      target: { sessionKey, storePath },
    });

    await commitMainSessionRecovery({
      command: { kind: "cancel_reservation", reservation: reserved.transition.reservation },
      target: { sessionKey, storePath },
    });

    expect(read().mainRestartRecovery).toMatchObject({
      attempts: { charged: 0 },
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-1"],
      },
    });
  });

  it("rejects an observation after the session is replaced", async () => {
    await write({
      sessionId: "session-2",
      updatedAt: 300,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        schemaVersion: 1,
        cycleId: "cycle-2",
        revision: 1,
        attempts: { charged: 0 },
      },
    });

    const result = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        now: 400,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "stale-recovery",
      },
      target: { sessionKey, storePath },
    });

    expect(result.transition).toEqual({ kind: "rejected", reason: "session_replaced" });
    expect(read().mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("does not let an old reservation survive healthy clear and immediate re-wedge", async () => {
    await write({
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        schemaVersion: 1,
        cycleId: "cycle-1",
        revision: 1,
        attempts: { charged: 0 },
      },
    });
    const reserved = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        now: 200,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "recovery-1",
      },
      target: { sessionKey, storePath },
    });
    expect(reserved.transition.kind).toBe("reserved");
    if (reserved.transition.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    await commitMainSessionRecovery({
      command: { kind: "clear" },
      target: { sessionKey, storePath },
    });
    await commitMainSessionRecovery({
      command: { kind: "mark_interrupted", cycleId: "cycle-2", now: 300 },
      target: { sessionKey, storePath },
    });

    const cancelled = await commitMainSessionRecovery({
      command: { kind: "cancel_reservation", reservation: reserved.transition.reservation },
      target: { sessionKey, storePath },
    });

    expect(cancelled.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      attempts: { charged: 0 },
    });
  });
});
