import type { RestartRecoveryRun, SessionEntry } from "../config/sessions.js";
import {
  evaluateRecoveryFuse,
  formatRecoveryWedgedReason,
  isRecoveryWedged,
  markRecoveryAttempt,
  markRecoveryWedged,
  type RestartRecoveryFuseGate,
} from "./restart-recovery-fuse.js";

export const MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 2;
export const MAIN_RESTART_RECOVERY_REWEDGE_WINDOW_MS = 2 * 60_000;

const MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON =
  "main-session restart recovery is tombstoned for this session";
const MAIN_RESTART_RECOVERY_REMEDIATION_HINT =
  "inspect the failed main session and start a clean main-session turn " +
  "to clear stale restart-recovery flags";

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

export function inferLegacyMainRestartRecoveryAttemptFloorFromRunMarkers(
  entry: SessionEntry,
): number {
  if (entry.mainRestartRecovery !== undefined) {
    return 0;
  }
  return Math.max(0, normalizeRestartRecoveryRunMarkers(entry.restartRecoveryRuns) - 1);
}

export function isMainRestartRecoveryWedgedEntry(entry: unknown): boolean {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    isRecoveryWedged((entry as SessionEntry).mainRestartRecovery),
  );
}

export function formatMainRestartRecoveryWedgedReason(entry: SessionEntry): string {
  return formatRecoveryWedgedReason(
    entry.mainRestartRecovery,
    MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON,
  );
}

export function evaluateMainRestartRecoveryGate(
  entry: SessionEntry,
  now: number,
): MainRestartRecoveryGate {
  return evaluateRecoveryFuse(entry.mainRestartRecovery, now, {
    maxAutomaticAttempts: MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS,
    rewedgeWindowMs: MAIN_RESTART_RECOVERY_REWEDGE_WINDOW_MS,
    ownerLabel: "main-session restart recovery",
    remediationHint: MAIN_RESTART_RECOVERY_REMEDIATION_HINT,
    legacyAttemptFloor: inferLegacyMainRestartRecoveryAttemptFloorFromRunMarkers(entry),
  });
}

export function markMainRestartRecoveryAttempt(params: {
  entry: SessionEntry;
  now: number;
  runId: string;
  attempt: number;
}): void {
  params.entry.mainRestartRecovery = markRecoveryAttempt({
    state: params.entry.mainRestartRecovery,
    now: params.now,
    runId: params.runId,
    attempt: params.attempt,
  });
  params.entry.updatedAt = params.now;
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
  params.entry.mainRestartRecovery = markRecoveryWedged({
    state: params.entry.mainRestartRecovery,
    now: params.now,
    runId: params.runId,
    reason: params.reason,
    maxAutomaticAttempts: MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS,
  });
  params.entry.updatedAt = params.now;
}

export function clearWedgedMainRestartRecoveryAbort(entry: SessionEntry, now: number): boolean {
  if (!isMainRestartRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) {
    return false;
  }
  entry.abortedLastRun = false;
  entry.updatedAt = now;
  return true;
}
