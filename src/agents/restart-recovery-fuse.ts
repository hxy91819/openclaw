import type { RestartRecoveryFuseState } from "../config/sessions/types.js";

export type RestartRecoveryFuseGate =
  | {
      allowed: true;
      nextAttempt: number;
    }
  | {
      allowed: false;
      reason: string;
      shouldMarkWedged: boolean;
    };

type RecoveryFuseOptions = {
  maxAutomaticAttempts: number;
  rewedgeWindowMs?: number;
  ownerLabel: string;
  remediationHint: string;
  legacyAttemptFloor?: number;
};

function normalizeAttempts(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function shouldRetainRecoveryAttempts(
  state: RestartRecoveryFuseState | undefined,
  now: number,
  rewedgeWindowMs: number | undefined,
): boolean {
  if (rewedgeWindowMs === undefined) {
    return true;
  }
  const lastAttemptAt = state?.lastAttemptAt;
  return (
    typeof lastAttemptAt === "number" &&
    Number.isFinite(lastAttemptAt) &&
    now - lastAttemptAt <= rewedgeWindowMs
  );
}

export function isRecoveryWedged(state: RestartRecoveryFuseState | undefined): boolean {
  return (
    typeof state?.wedgedAt === "number" && Number.isFinite(state.wedgedAt) && state.wedgedAt > 0
  );
}

export function formatRecoveryWedgedReason(
  state: RestartRecoveryFuseState | undefined,
  fallbackReason: string,
): string {
  return state?.wedgedReason?.trim() || fallbackReason;
}

export function evaluateRecoveryFuse(
  state: RestartRecoveryFuseState | undefined,
  now: number,
  options: RecoveryFuseOptions,
): RestartRecoveryFuseGate {
  if (isRecoveryWedged(state)) {
    return {
      allowed: false,
      reason: formatRecoveryWedgedReason(state, `${options.ownerLabel} recovery is tombstoned`),
      shouldMarkWedged: false,
    };
  }

  const retainedAttempts = shouldRetainRecoveryAttempts(state, now, options.rewedgeWindowMs)
    ? normalizeAttempts(state?.automaticAttempts)
    : 0;
  const previousAttempts = Math.max(
    retainedAttempts,
    normalizeAttempts(options.legacyAttemptFloor),
  );
  if (previousAttempts >= options.maxAutomaticAttempts) {
    const attemptDescription =
      options.rewedgeWindowMs === undefined
        ? "accepted resume attempts"
        : "rapid accepted resume attempts";
    return {
      allowed: false,
      reason:
        `${options.ownerLabel} blocked after ${previousAttempts} ${attemptDescription}; ` +
        options.remediationHint,
      shouldMarkWedged: true,
    };
  }

  return {
    allowed: true,
    nextAttempt: previousAttempts + 1,
  };
}

export function markRecoveryAttempt(params: {
  state: RestartRecoveryFuseState | undefined;
  now: number;
  runId: string;
  attempt: number;
}): RestartRecoveryFuseState {
  return {
    automaticAttempts: Math.max(1, params.attempt),
    lastAttemptAt: params.now,
    lastRunId: params.runId,
  };
}

export function markRecoveryWedged(params: {
  state: RestartRecoveryFuseState | undefined;
  now: number;
  runId?: string;
  reason: string;
  maxAutomaticAttempts: number;
}): RestartRecoveryFuseState {
  return {
    ...params.state,
    automaticAttempts: Math.max(params.state?.automaticAttempts ?? 0, params.maxAutomaticAttempts),
    lastAttemptAt: params.state?.lastAttemptAt ?? params.now,
    ...(params.runId ? { lastRunId: params.runId } : {}),
    wedgedAt: params.now,
    wedgedReason: params.reason,
  };
}
