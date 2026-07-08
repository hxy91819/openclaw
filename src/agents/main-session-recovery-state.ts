import type { RestartRecoveryRun, SessionEntry } from "../config/sessions.js";
import type { RestartRecoveryFuseGate } from "./restart-recovery-fuse.js";

export const MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 2;

const MAIN_RESTART_RECOVERY_REMEDIATION_HINT =
  "inspect the transcript before retrying the session manually";

export type MainRestartRecoveryGate = RestartRecoveryFuseGate;

function normalizeRestartRecoveryRunMarkers(value: unknown): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  const markers = new Set<string>();
  for (const run of value) {
    if (!run || typeof run !== "object") {
      continue;
    }
    const runId = (run as RestartRecoveryRun).runId;
    const lifecycleGeneration = (run as RestartRecoveryRun).lifecycleGeneration;
    if (typeof runId !== "string" || typeof lifecycleGeneration !== "string") {
      continue;
    }
    const normalizedRunId = runId.trim();
    const normalizedLifecycleGeneration = lifecycleGeneration.trim();
    if (!normalizedRunId || !normalizedLifecycleGeneration) {
      continue;
    }
    markers.add(`${normalizedRunId}\0${normalizedLifecycleGeneration}`);
  }
  return markers.size;
}

export function inferMainRestartRecoveryAttemptFloorFromRunMarkers(entry: SessionEntry): number {
  return Math.max(0, normalizeRestartRecoveryRunMarkers(entry.restartRecoveryRuns) - 1);
}

export function evaluateMainRestartRecoveryGate(
  entry: SessionEntry,
  _now: number,
): MainRestartRecoveryGate {
  const previousAttempts = inferMainRestartRecoveryAttemptFloorFromRunMarkers(entry);
  if (previousAttempts >= MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS) {
    return {
      allowed: false,
      reason:
        `main-session restart recovery blocked after ${previousAttempts} restart-recovery marker attempts; ` +
        MAIN_RESTART_RECOVERY_REMEDIATION_HINT,
      shouldMarkWedged: true,
    };
  }

  return {
    allowed: true,
    nextAttempt: previousAttempts + 1,
  };
}

export function markMainRestartRecoveryWedged(params: {
  entry: SessionEntry;
  now: number;
  runId?: string;
  reason: string;
}): void {
  params.entry.abortedLastRun = false;
  params.entry.status = "failed";
  params.entry.endedAt = params.now;
  params.entry.runtimeMs = Math.max(0, params.now - (params.entry.startedAt ?? params.now));
  params.entry.updatedAt = params.now;
}
