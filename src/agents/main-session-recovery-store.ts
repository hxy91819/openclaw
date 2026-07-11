import type { SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import {
  transitionMainSessionRecovery,
  type MainSessionRecoveryCommand,
  type MainSessionRecoveryReservation,
  type MainSessionRecoveryTransitionResult,
} from "./main-session-recovery-state.js";

export type MainSessionRecoveryStoreTarget = {
  sessionKey: string;
  storePath: string;
};

export type MainSessionRecoveryStoreResult = {
  entry?: SessionEntry;
  transition: MainSessionRecoveryTransitionResult;
};

function transitionChanged(result: MainSessionRecoveryTransitionResult): boolean {
  return result.kind !== "no_change" && result.kind !== "observed" && result.kind !== "rejected";
}

function matchesReservation(entry: SessionEntry, reservation: MainSessionRecoveryReservation) {
  const state = entry.mainRestartRecovery;
  return (
    entry.sessionId === reservation.sessionId &&
    state?.cycleId === reservation.cycleId &&
    state.reservation?.runId === reservation.runId &&
    state.reservation.lifecycleGeneration === reservation.lifecycleGeneration
  );
}

export async function commitMainSessionRecovery(params: {
  command: MainSessionRecoveryCommand;
  requireWriteSuccess?: boolean;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryStoreResult> {
  const cancellation =
    params.command.kind === "cancel_reservation" ? params.command.reservation : undefined;
  return await applySessionEntryReplacements<MainSessionRecoveryStoreResult>({
    requireWriteSuccess: params.requireWriteSuccess,
    ...(cancellation ? {} : { sessionKeys: [params.target.sessionKey] }),
    storePath: params.target.storePath,
    update: (entries) => {
      const selected = entries.find(({ sessionKey }) => sessionKey === params.target.sessionKey);
      const candidate = cancellation
        ? (entries.find(({ entry }) => matchesReservation(entry, cancellation)) ?? selected)
        : selected;
      if (!candidate) {
        return {
          result: {
            transition: { kind: "rejected", reason: "session_replaced" },
          },
        };
      }
      const entry = candidate.entry;
      const previousRecoveryState = entry.mainRestartRecovery;
      const transition = transitionMainSessionRecovery(entry, params.command);
      const changed =
        transitionChanged(transition) || previousRecoveryState !== entry.mainRestartRecovery;
      return {
        result: { entry, transition },
        ...(changed ? { replacements: [{ sessionKey: candidate.sessionKey, entry }] } : {}),
      };
    },
  });
}
