import type { SessionEntry } from "../config/sessions.js";
import {
  evaluateRecoveryFuse,
  formatRecoveryWedgedReason,
  isRecoveryWedged,
  markRecoveryAttempt,
  markRecoveryWedged,
  type RestartRecoveryFuseGate,
} from "./restart-recovery-fuse.js";

const SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 2;
const SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS = 2 * 60_000;

export function isSubagentRecoveryWedgedEntry(entry: unknown): boolean {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    isRecoveryWedged((entry as SessionEntry).subagentRecovery),
  );
}

export function formatSubagentRecoveryWedgedReason(entry: SessionEntry): string {
  return formatRecoveryWedgedReason(
    entry.subagentRecovery,
    "subagent orphan recovery is tombstoned for this session",
  );
}

export function evaluateSubagentRecoveryGate(
  entry: SessionEntry,
  now: number,
): RestartRecoveryFuseGate {
  return evaluateRecoveryFuse(entry.subagentRecovery, now, {
    maxAutomaticAttempts: SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS,
    rewedgeWindowMs: SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS,
    ownerLabel: "subagent orphan recovery",
    remediationHint: `run "openclaw tasks maintenance --apply" or "openclaw doctor --fix" to reconcile it`,
  });
}

export function markSubagentRecoveryAttempt(params: {
  entry: SessionEntry;
  now: number;
  runId: string;
  attempt: number;
}): void {
  params.entry.subagentRecovery = markRecoveryAttempt({
    now: params.now,
    runId: params.runId,
    attempt: params.attempt,
  });
}

export function markSubagentRecoveryWedged(params: {
  entry: SessionEntry;
  now: number;
  runId?: string;
  reason: string;
}): void {
  params.entry.abortedLastRun = false;
  params.entry.subagentRecovery = markRecoveryWedged({
    state: params.entry.subagentRecovery,
    now: params.now,
    runId: params.runId,
    reason: params.reason,
    maxAutomaticAttempts: SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS,
  });
  params.entry.updatedAt = params.now;
}

export function clearWedgedSubagentRecoveryAbort(entry: SessionEntry, now: number): boolean {
  if (!isSubagentRecoveryWedgedEntry(entry) || entry.abortedLastRun !== true) {
    return false;
  }
  entry.abortedLastRun = false;
  entry.updatedAt = now;
  return true;
}
