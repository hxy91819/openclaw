import type { SessionEntry } from "../config/sessions.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import {
  evaluateRecoveryFuse,
  formatRecoveryWedgedReason,
  isRecoveryWedged,
  markRecoveryAttempt,
  markRecoveryWedged,
  type RestartRecoveryFuseGate,
} from "./restart-recovery-fuse.js";

export const MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 3;

const MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON =
  "main-session restart recovery is tombstoned for this session";
const MAIN_RESTART_RECOVERY_REMEDIATION_HINT =
  "inspect the failed main session and use /new or reset to start a replacement session";

export function isMainRestartRecoveryCandidate(entry: SessionEntry, sessionKey: string): boolean {
  if (typeof entry.spawnDepth === "number" && entry.spawnDepth > 0) {
    return false;
  }
  if (entry.subagentRole != null) {
    return false;
  }
  return (
    !isSubagentSessionKey(sessionKey) &&
    !isCronSessionKey(sessionKey) &&
    !isAcpSessionKey(sessionKey)
  );
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
): RestartRecoveryFuseGate {
  return evaluateRecoveryFuse(entry.mainRestartRecovery, now, {
    maxAutomaticAttempts: MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS,
    ownerLabel: "main-session restart recovery",
    remediationHint: MAIN_RESTART_RECOVERY_REMEDIATION_HINT,
  });
}

export function markMainRestartRecoveryAttempt(params: {
  entry: SessionEntry;
  now: number;
  runId: string;
  attempt: number;
}): void {
  params.entry.mainRestartRecovery = markRecoveryAttempt({
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
