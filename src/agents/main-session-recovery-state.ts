import {
  PENDING_FINAL_DELIVERY_CLEAR_PATCH,
  sanitizePendingFinalDeliveryText,
} from "../auto-reply/reply/pending-final-delivery.js";
import type {
  MainRestartRecoveryState,
  RestartRecoveryRun,
  SessionEntry,
} from "../config/sessions.js";
import { isAcpSessionKey, isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";

const MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 3;

const MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON =
  "main-session restart recovery is tombstoned for this session";
const MAIN_RESTART_RECOVERY_REMEDIATION_HINT =
  "inspect the failed main session and use /new or reset to start a replacement session";

export type MainSessionRecoveryObservation = {
  sessionId: string;
  cycleId: string;
  revision: number;
};

export type MainSessionRecoveryReservation = {
  sessionId: string;
  cycleId: string;
  lifecycleGeneration: string;
  runId: string;
  attempt: number;
};

export type MainSessionRecoveryOwnerClaim = {
  cycleId: string;
  lifecycleGeneration: string;
  token: string;
  sessionKey: string;
};

type MainSessionRecoveryView =
  | { status: "inactive" }
  | { status: "blocked" }
  | {
      status: "recoverable";
      observation: MainSessionRecoveryObservation;
      nextAttempt: number;
    }
  | {
      status: "exhausted";
      observation: MainSessionRecoveryObservation;
      reason: string;
    }
  | { status: "tombstoned" };

type MainSessionRecoveryConflict =
  | "already_tombstoned"
  | "foreground_active"
  | "not_interrupted"
  | "reservation_active"
  | "session_replaced"
  | "stale_cycle"
  | "stale_generation"
  | "stale_reservation"
  | "stale_revision";

export type MainSessionRecoveryCommand =
  | {
      kind: "mark_interrupted";
      cycleId: string;
      now: number;
      runs?: RestartRecoveryRun[];
      resetRuntime?: boolean;
    }
  | {
      kind: "observe";
      cycleId: string;
      lifecycleGeneration: string;
      sessionKey: string;
    }
  | {
      kind: "prepare_attempt";
      attempt: number;
      lifecycleGeneration: string;
      now: number;
      observation: MainSessionRecoveryObservation;
      runId: string;
    }
  | { kind: "cancel_reservation"; reservation: MainSessionRecoveryReservation }
  | {
      kind: "validate_recovery";
      lifecycleGeneration: string;
      runId: string;
      sessionId: string;
    }
  | {
      kind: "admit_recovery";
      lifecycleGeneration: string;
      now: number;
      runId: string;
      sessionId: string;
    }
  | {
      kind: "mark_admitted_recovery_interrupted";
      lifecycleGeneration: string;
      now: number;
      runId: string;
      sessionId: string;
    }
  | {
      kind: "claim_foreground";
      cycleId: string;
      lifecycleGeneration: string;
      sessionId: string;
      sessionKey: string;
      token: string;
    }
  | { kind: "release_foreground"; claim: MainSessionRecoveryOwnerClaim }
  | {
      kind: "tombstone";
      now: number;
      observation: MainSessionRecoveryObservation;
      reason: string;
    }
  | {
      kind: "fail_recovery";
      now: number;
      observation: MainSessionRecoveryObservation;
    }
  | { kind: "doctor_repair"; now: number }
  | { kind: "clear" };

export type MainSessionRecoveryTransitionResult =
  | { kind: "admitted_recovery" }
  | { kind: "applied" }
  | { kind: "doctor_repaired" }
  | { kind: "failed"; noticeEntry: SessionEntry }
  | { kind: "foreground_claimed"; claim: MainSessionRecoveryOwnerClaim }
  | { kind: "no_change" }
  | { kind: "observed"; view: MainSessionRecoveryView }
  | { kind: "rejected"; reason: MainSessionRecoveryConflict }
  | { kind: "recovery_validated" }
  | { kind: "reserved"; reservation: MainSessionRecoveryReservation }
  | { kind: "tombstoned" };

type MainRecoveryLifecycleEvent = {
  runId?: string;
  lifecycleGeneration?: string;
  data?: { phase?: unknown; stopReason?: unknown };
};

function nextRevision(state: MainRestartRecoveryState): number {
  return state.revision + 1;
}

function createCycle(cycleId: string): MainRestartRecoveryState {
  return {
    cycleId,
    revision: 1,
    chargedAttempts: 0,
  };
}

function observationFor(entry: SessionEntry): MainSessionRecoveryObservation | undefined {
  const state = entry.mainRestartRecovery;
  if (!state) {
    return undefined;
  }
  return {
    sessionId: entry.sessionId,
    cycleId: state.cycleId,
    revision: state.revision,
  };
}

function matchesObservation(
  entry: SessionEntry,
  observation: MainSessionRecoveryObservation,
): MainSessionRecoveryConflict | null {
  if (entry.sessionId !== observation.sessionId) {
    return "session_replaced";
  }
  if (entry.mainRestartRecovery?.cycleId !== observation.cycleId) {
    return "stale_cycle";
  }
  return entry.mainRestartRecovery.revision === observation.revision ? null : "stale_revision";
}

function hasCurrentForegroundClaim(
  state: MainRestartRecoveryState,
  lifecycleGeneration: string,
): boolean {
  return (
    state.foregroundClaims?.lifecycleGeneration === lifecycleGeneration &&
    state.foregroundClaims.tokens.length > 0
  );
}

function validateRecoveryAdmission(
  entry: SessionEntry,
  command: {
    lifecycleGeneration: string;
    runId: string;
    sessionId: string;
  },
): MainSessionRecoveryConflict | null {
  const state = entry.mainRestartRecovery;
  if (entry.sessionId !== command.sessionId) {
    return "session_replaced";
  }
  if (entry.status !== "running" || entry.abortedLastRun !== true || !state) {
    return "not_interrupted";
  }
  if (
    state.reservation?.runId !== command.runId ||
    state.reservation.lifecycleGeneration !== command.lifecycleGeneration
  ) {
    return "stale_reservation";
  }
  return hasCurrentForegroundClaim(state, command.lifecycleGeneration) ? "foreground_active" : null;
}

function recordLifecycleFence(entry: SessionEntry, run: RestartRecoveryRun): void {
  // Lifecycle fences can overlap and are consumed independently by their matching events.
  const runs = new Map<string, RestartRecoveryRun>();
  for (const existing of entry.restartRecoveryRuns ?? []) {
    runs.set(`${existing.runId}\u0000${existing.lifecycleGeneration}`, existing);
  }
  runs.set(`${run.runId}\u0000${run.lifecycleGeneration}`, run);
  entry.restartRecoveryRuns = [...runs.values()].toSorted((a, b) =>
    a.runId === b.runId
      ? a.lifecycleGeneration.localeCompare(b.lifecycleGeneration)
      : a.runId.localeCompare(b.runId),
  );
}

function hasLifecycleFence(entry: SessionEntry, run: RestartRecoveryRun): boolean {
  return Boolean(
    entry.restartRecoveryRuns?.some(
      (candidate) =>
        candidate.runId === run.runId && candidate.lifecycleGeneration === run.lifecycleGeneration,
    ),
  );
}

function formatAttemptBudgetReason(attempts: number): string {
  return (
    `main-session restart recovery blocked after ${attempts} charged automatic resume attempts; ` +
    MAIN_RESTART_RECOVERY_REMEDIATION_HINT
  );
}

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

function inspectMainSessionRecovery(params: {
  entry: SessionEntry;
  lifecycleGeneration: string;
  sessionKey: string;
}): MainSessionRecoveryView {
  const { entry } = params;
  if (
    entry.status !== "running" ||
    entry.abortedLastRun !== true ||
    !isMainRestartRecoveryCandidate(entry, params.sessionKey)
  ) {
    return { status: "inactive" };
  }
  const state = entry.mainRestartRecovery;
  const observation = observationFor(entry);
  if (!state || !observation) {
    return { status: "inactive" };
  }
  if (state.tombstone) {
    return { status: "tombstoned" };
  }
  if (hasCurrentForegroundClaim(state, params.lifecycleGeneration)) {
    return { status: "blocked" };
  }
  if (state.reservation) {
    return { status: "blocked" };
  }
  if (state.chargedAttempts >= MAIN_RESTART_RECOVERY_MAX_AUTOMATIC_ATTEMPTS) {
    return {
      status: "exhausted",
      observation,
      reason: formatAttemptBudgetReason(state.chargedAttempts),
    };
  }
  return {
    status: "recoverable",
    observation,
    nextAttempt: state.chargedAttempts + 1,
  };
}

export function transitionMainSessionRecovery(
  entry: SessionEntry,
  command: MainSessionRecoveryCommand,
): MainSessionRecoveryTransitionResult {
  switch (command.kind) {
    case "mark_interrupted": {
      if (!entry.mainRestartRecovery) {
        entry.mainRestartRecovery = createCycle(command.cycleId);
      }
      entry.status = "running";
      entry.abortedLastRun = true;
      if (command.resetRuntime) {
        entry.startedAt = undefined;
        entry.endedAt = undefined;
        entry.runtimeMs = undefined;
      }
      for (const run of command.runs ?? []) {
        recordLifecycleFence(entry, run);
      }
      entry.updatedAt = command.now;
      return { kind: "applied" };
    }
    case "observe": {
      if (
        entry.status === "running" &&
        entry.abortedLastRun === true &&
        isMainRestartRecoveryCandidate(entry, command.sessionKey) &&
        !entry.mainRestartRecovery
      ) {
        // Rows interrupted by an older shipped version acquire identity before scanning.
        entry.mainRestartRecovery = createCycle(command.cycleId);
      }
      const state = entry.mainRestartRecovery;
      if (
        state?.reservation &&
        state.reservation.lifecycleGeneration !== command.lifecycleGeneration
      ) {
        // A process restart makes dispatch outcome unknowable: retain the charge,
        // but release the stale slot so the next bounded attempt can proceed.
        entry.mainRestartRecovery = {
          ...state,
          revision: nextRevision(state),
          reservation: undefined,
        };
      }
      return {
        kind: "observed",
        view: inspectMainSessionRecovery({
          entry,
          lifecycleGeneration: command.lifecycleGeneration,
          sessionKey: command.sessionKey,
        }),
      };
    }
    case "prepare_attempt": {
      const conflict = matchesObservation(entry, command.observation);
      if (conflict) {
        return { kind: "rejected", reason: conflict };
      }
      const state = entry.mainRestartRecovery!;
      if (entry.status !== "running" || entry.abortedLastRun !== true) {
        return { kind: "rejected", reason: "not_interrupted" };
      }
      if (state.tombstone) {
        return { kind: "rejected", reason: "already_tombstoned" };
      }
      if (state.reservation) {
        return { kind: "rejected", reason: "reservation_active" };
      }
      if (command.attempt !== state.chargedAttempts + 1) {
        return { kind: "rejected", reason: "stale_revision" };
      }
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        chargedAttempts: command.attempt,
        reservation: {
          runId: command.runId,
          attempt: command.attempt,
          lifecycleGeneration: command.lifecycleGeneration,
        },
      };
      entry.updatedAt = command.now;
      return {
        kind: "reserved",
        reservation: {
          sessionId: entry.sessionId,
          cycleId: state.cycleId,
          lifecycleGeneration: command.lifecycleGeneration,
          runId: command.runId,
          attempt: command.attempt,
        },
      };
    }
    case "cancel_reservation": {
      const state = entry.mainRestartRecovery;
      const reserved = state?.reservation;
      if (
        !state ||
        entry.sessionId !== command.reservation.sessionId ||
        state.cycleId !== command.reservation.cycleId ||
        reserved?.runId !== command.reservation.runId ||
        reserved.attempt !== command.reservation.attempt ||
        reserved.lifecycleGeneration !== command.reservation.lifecycleGeneration
      ) {
        return { kind: "rejected", reason: "stale_reservation" };
      }
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        chargedAttempts: Math.max(0, command.reservation.attempt - 1),
        reservation: undefined,
      };
      return { kind: "applied" };
    }
    case "validate_recovery": {
      const conflict = validateRecoveryAdmission(entry, command);
      return conflict ? { kind: "rejected", reason: conflict } : { kind: "recovery_validated" };
    }
    case "admit_recovery": {
      const conflict = validateRecoveryAdmission(entry, command);
      if (conflict) {
        return { kind: "rejected", reason: conflict };
      }
      const state = entry.mainRestartRecovery!;
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        reservation: undefined,
        foregroundClaims: undefined,
      };
      entry.abortedLastRun = false;
      recordLifecycleFence(entry, {
        runId: command.runId,
        lifecycleGeneration: command.lifecycleGeneration,
      });
      if (entry.pendingFinalDelivery || entry.pendingFinalDeliveryText) {
        const pendingText = sanitizePendingFinalDeliveryText(entry.pendingFinalDeliveryText ?? "");
        if (pendingText) {
          entry.pendingFinalDeliveryLastAttemptAt = command.now;
          entry.pendingFinalDeliveryAttemptCount =
            (entry.pendingFinalDeliveryAttemptCount ?? 0) + 1;
          entry.pendingFinalDeliveryLastError = null;
          entry.pendingFinalDeliveryText = pendingText;
        } else {
          Object.assign(entry, PENDING_FINAL_DELIVERY_CLEAR_PATCH);
        }
      }
      return { kind: "admitted_recovery" };
    }
    case "mark_admitted_recovery_interrupted": {
      const state = entry.mainRestartRecovery;
      if (entry.sessionId !== command.sessionId) {
        return { kind: "rejected", reason: "session_replaced" };
      }
      if (
        !state ||
        state.reservation ||
        !hasLifecycleFence(entry, {
          runId: command.runId,
          lifecycleGeneration: command.lifecycleGeneration,
        })
      ) {
        return { kind: "rejected", reason: "stale_reservation" };
      }
      entry.status = "running";
      entry.abortedLastRun = true;
      entry.startedAt = undefined;
      entry.endedAt = undefined;
      entry.runtimeMs = undefined;
      entry.updatedAt = command.now;
      return { kind: "applied" };
    }
    case "claim_foreground": {
      if (
        entry.sessionId !== command.sessionId ||
        entry.status !== "running" ||
        entry.abortedLastRun !== true ||
        !isMainRestartRecoveryCandidate(entry, command.sessionKey)
      ) {
        return { kind: "no_change" };
      }
      const state = entry.mainRestartRecovery ?? createCycle(command.cycleId);
      if (state.tombstone) {
        return { kind: "rejected", reason: "already_tombstoned" };
      }
      const currentTokens =
        state.foregroundClaims?.lifecycleGeneration === command.lifecycleGeneration
          ? state.foregroundClaims.tokens
          : [];
      const tokens = [...new Set([...currentTokens, command.token])].toSorted();
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        foregroundClaims: {
          lifecycleGeneration: command.lifecycleGeneration,
          tokens,
        },
      };
      return {
        kind: "foreground_claimed",
        claim: {
          cycleId: state.cycleId,
          lifecycleGeneration: command.lifecycleGeneration,
          token: command.token,
          sessionKey: command.sessionKey,
        },
      };
    }
    case "release_foreground": {
      const state = entry.mainRestartRecovery;
      const claims = state?.foregroundClaims;
      if (
        !state ||
        state.cycleId !== command.claim.cycleId ||
        claims?.lifecycleGeneration !== command.claim.lifecycleGeneration ||
        !claims.tokens.includes(command.claim.token)
      ) {
        return { kind: "no_change" };
      }
      const tokens = claims.tokens.filter((token) => token !== command.claim.token);
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        foregroundClaims:
          tokens.length > 0
            ? { lifecycleGeneration: command.claim.lifecycleGeneration, tokens }
            : undefined,
      };
      return { kind: "applied" };
    }
    case "tombstone": {
      const conflict = matchesObservation(entry, command.observation);
      if (conflict) {
        return { kind: "rejected", reason: conflict };
      }
      const state = entry.mainRestartRecovery!;
      if (state.reservation) {
        return { kind: "rejected", reason: "reservation_active" };
      }
      if (state.tombstone) {
        return { kind: "rejected", reason: "already_tombstoned" };
      }
      entry.mainRestartRecovery = {
        ...state,
        revision: nextRevision(state),
        tombstone: {
          reason: command.reason,
        },
      };
      entry.abortedLastRun = false;
      entry.status = "failed";
      entry.endedAt = command.now;
      entry.runtimeMs = Math.max(0, command.now - (entry.startedAt ?? command.now));
      entry.updatedAt = command.now;
      return { kind: "tombstoned" };
    }
    case "fail_recovery": {
      const conflict = matchesObservation(entry, command.observation);
      if (conflict) {
        return { kind: "rejected", reason: conflict };
      }
      const noticeEntry = structuredClone(entry);
      entry.status = "failed";
      entry.abortedLastRun = true;
      entry.endedAt = command.now;
      entry.updatedAt = command.now;
      Object.assign(entry, PENDING_FINAL_DELIVERY_CLEAR_PATCH);
      entry.restartRecoveryDeliveryContext = undefined;
      entry.restartRecoveryDeliveryRunId = undefined;
      entry.mainRestartRecovery = undefined;
      return { kind: "failed", noticeEntry };
    }
    case "doctor_repair": {
      if (!entry.mainRestartRecovery?.tombstone || entry.abortedLastRun !== true) {
        return { kind: "no_change" };
      }
      entry.abortedLastRun = false;
      entry.updatedAt = command.now;
      return { kind: "doctor_repaired" };
    }
    case "clear": {
      const patch = buildMainSessionRecoveryClearPatch(entry);
      if (Object.keys(patch).length === 0) {
        return { kind: "no_change" };
      }
      Object.assign(entry, patch);
      return { kind: "applied" };
    }
    default:
      return command satisfies never;
  }
}

type MainRecoveryStateFields = Pick<
  SessionEntry,
  "abortedLastRun" | "restartRecoveryRuns" | "mainRestartRecovery"
>;

export function buildMainSessionRecoveryClearPatch(
  entry?: Partial<MainRecoveryStateFields> | null,
): Partial<MainRecoveryStateFields> {
  if (
    entry?.abortedLastRun !== true &&
    entry?.restartRecoveryRuns === undefined &&
    entry?.mainRestartRecovery === undefined
  ) {
    return {};
  }
  return {
    abortedLastRun: false,
    restartRecoveryRuns: undefined,
    mainRestartRecovery: undefined,
  };
}

export function inspectMainSessionRecoveryHealth(entry: SessionEntry):
  | { status: "none" }
  | { status: "active" }
  | {
      status: "tombstoned";
      reason: string;
      repair: "clear_stale_abort" | null;
    } {
  const state = entry.mainRestartRecovery;
  if (!state) {
    return { status: "none" };
  }
  if (!state.tombstone) {
    return { status: "active" };
  }
  return {
    status: "tombstoned",
    reason: state.tombstone.reason.trim() || MAIN_RESTART_RECOVERY_WEDGED_FALLBACK_REASON,
    repair: entry.abortedLastRun === true ? "clear_stale_abort" : null,
  };
}

function lifecyclePhase(event: MainRecoveryLifecycleEvent): "start" | "end" | "error" | null {
  const phase = event.data?.phase;
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

export function isMainSessionRecoveryLifecycleEvent(params: {
  entry?: Partial<Pick<SessionEntry, "restartRecoveryRuns">> | null;
  event: MainRecoveryLifecycleEvent;
}): boolean {
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const phase = lifecyclePhase(params.event);
  const interrupted = params.event.data?.stopReason === "restart";
  const matchesFence = Boolean(
    runId &&
    lifecycleGeneration &&
    params.entry?.restartRecoveryRuns?.some(
      (run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration,
    ),
  );
  return (
    matchesFence && (phase === "start" || ((phase === "end" || phase === "error") && interrupted))
  );
}

export function projectMainSessionRecoveryLifecycle(params: {
  entry?: Partial<MainRecoveryStateFields> | null;
  event: MainRecoveryLifecycleEvent;
  snapshotPatch: Partial<SessionEntry>;
}): { action: "suppress" } | { action: "apply"; patch: Partial<SessionEntry> } {
  if (isMainSessionRecoveryLifecycleEvent(params)) {
    return { action: "suppress" };
  }
  const patch = { ...params.snapshotPatch };
  if (params.snapshotPatch.status === "done") {
    Object.assign(patch, buildMainSessionRecoveryClearPatch(params.entry));
  }
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const runs = params.entry?.restartRecoveryRuns;
  if (
    lifecyclePhase(params.event) === "start" ||
    !runId ||
    !lifecycleGeneration ||
    !runs?.some((run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration)
  ) {
    return { action: "apply", patch };
  }
  const remaining = runs.filter(
    (run) => run.runId !== runId || run.lifecycleGeneration !== lifecycleGeneration,
  );
  if (params.entry?.abortedLastRun === true && remaining.length > 0) {
    return { action: "apply", patch: { restartRecoveryRuns: remaining } };
  }
  if (params.snapshotPatch.status !== "done") {
    patch.restartRecoveryRuns = remaining.length > 0 ? remaining : undefined;
  }
  return { action: "apply", patch };
}
