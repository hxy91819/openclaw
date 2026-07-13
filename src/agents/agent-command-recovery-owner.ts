import path from "node:path";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AgentCommandOpts } from "./command/types.js";
import { isMainRestartRecoveryCandidate } from "./main-session-recovery-state.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
  type MainSessionRecoveryOwnerLease,
} from "./main-session-recovery-store.js";

const log = createSubsystemLogger("agents/agent-command");
const recoveryCandidateByPreparation = new WeakMap<object, SessionEntry | undefined>();

type PreparedRecoveryOwnerTarget = object & {
  isNewSession: boolean;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
  runLease?: { release: () => Promise<void> };
};

export function rememberAgentCommandRecoveryCandidate(
  prepared: object,
  entry: SessionEntry | undefined,
): void {
  // Weak keys keep abandoned testing preparations bounded without publishing this state.
  recoveryCandidateByPreparation.set(prepared, entry);
}

async function claimAgentCommandRecoveryOwner(params: {
  lifecycleGeneration: string;
  mode: "claim" | "reject_uncoordinated";
  opts: AgentCommandOpts;
  prepared: PreparedRecoveryOwnerTarget;
  recoveryCandidateEntry?: SessionEntry;
}): Promise<MainSessionRecoveryOwnerLease | undefined> {
  const transferredLease = params.opts.mainRestartRecoveryOwnerLease;
  if (transferredLease) {
    const state = params.recoveryCandidateEntry?.mainRestartRecovery;
    const claims = state?.foregroundClaims;
    const matchesPreparedTarget =
      transferredLease.lifecycleGeneration === params.lifecycleGeneration &&
      (transferredLease.sessionId === params.prepared.sessionId || params.prepared.isNewSession) &&
      transferredLease.sessionKey === params.prepared.sessionKey &&
      path.resolve(transferredLease.storePath) === path.resolve(params.prepared.storePath);
    const matchesPersistedClaim =
      params.recoveryCandidateEntry?.sessionId === transferredLease.sessionId &&
      state?.cycleId === transferredLease.cycleId &&
      claims?.lifecycleGeneration === transferredLease.lifecycleGeneration &&
      claims.tokens.includes(transferredLease.claimId);
    if (!matchesPreparedTarget || !matchesPersistedClaim) {
      // Gateway transfers a persisted fence before preparation; bind it again after
      // session resolution so rollover or rerouting cannot execute under another row's lease.
      throw new Error("main-session recovery owner changed during ingress preparation; retry");
    }
    return transferredLease;
  }
  if (params.opts.sessionEffects === "internal") {
    return undefined;
  }
  const entry = params.recoveryCandidateEntry;
  const sessionKey = params.prepared.sessionKey;
  if (
    !entry ||
    entry.status !== "running" ||
    entry.abortedLastRun !== true ||
    !sessionKey ||
    !isMainRestartRecoveryCandidate(entry, sessionKey)
  ) {
    return undefined;
  }
  if (params.mode === "reject_uncoordinated") {
    // Standalone processes cannot share Gateway lifecycle fencing.
    throw new Error(
      `Session "${sessionKey}" has interrupted work pending restart recovery; retry through a healthy Gateway or choose a fresh --session-id.`,
    );
  }
  const claim = await claimMainSessionRecoveryOwner({
    lifecycleGeneration: params.lifecycleGeneration,
    sessionId: entry.sessionId,
    target: { sessionKey, storePath: params.prepared.storePath },
  });
  if (claim.kind === "invalidated") {
    throw new Error(
      `main-session recovery owner changed during admission (${claim.reason}); retry`,
    );
  }
  return claim.kind === "claimed" ? claim.lease : undefined;
}

export async function runWithAgentCommandRecoveryOwner<
  TPrepared extends PreparedRecoveryOwnerTarget,
  TResult,
>(params: {
  lifecycleGeneration: string;
  mode: "claim" | "reject_uncoordinated";
  opts: AgentCommandOpts;
  prepare: (opts: AgentCommandOpts) => Promise<TPrepared>;
  run: (prepared: TPrepared) => Promise<TResult>;
}): Promise<TResult> {
  // Gateway may preclaim before dispatch, so every preparation outcome must release ownership.
  let lease = params.opts.mainRestartRecoveryOwnerLease;
  let prepared: TPrepared | undefined;
  try {
    prepared = await params.prepare(params.opts);
    const recoveryCandidateEntry = recoveryCandidateByPreparation.get(prepared);
    recoveryCandidateByPreparation.delete(prepared);
    lease = await claimAgentCommandRecoveryOwner({ ...params, prepared, recoveryCandidateEntry });
    return await params.run(prepared);
  } finally {
    try {
      await releaseMainSessionRecoveryOwner(lease);
    } catch (error) {
      log.warn(`failed to release main-session recovery owner: ${formatErrorMessage(error)}`);
    }
    await prepared?.runLease?.release();
  }
}
