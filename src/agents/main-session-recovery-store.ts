import type { SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import {
  transitionMainSessionRecovery,
  type MainSessionRecoveryCommand,
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

export async function commitMainSessionRecovery(params: {
  command: MainSessionRecoveryCommand;
  requireWriteSuccess?: boolean;
  target: MainSessionRecoveryStoreTarget;
}): Promise<MainSessionRecoveryStoreResult> {
  return await applySessionEntryReplacements<MainSessionRecoveryStoreResult>({
    requireWriteSuccess: params.requireWriteSuccess,
    sessionKeys: [params.target.sessionKey],
    storePath: params.target.storePath,
    update: (entries) => {
      const entry = entries[0]?.entry;
      if (!entry) {
        return {
          result: {
            transition: { kind: "rejected", reason: "session_replaced" },
          },
        };
      }
      const previousRecoveryState = entry.mainRestartRecovery;
      const transition = transitionMainSessionRecovery(entry, params.command);
      const changed =
        transitionChanged(transition) || previousRecoveryState !== entry.mainRestartRecovery;
      return {
        result: { entry, transition },
        ...(changed ? { replacements: [{ sessionKey: params.target.sessionKey, entry }] } : {}),
      };
    },
  });
}
