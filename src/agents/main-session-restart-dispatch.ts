import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandLane } from "../process/lanes.js";
import { MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL } from "../sessions/input-provenance.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import {
  deliveryContextFromSession,
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import type {
  MainSessionRecoveryObservation,
  MainSessionRecoveryReservation,
} from "./main-session-recovery-state.js";
import { commitMainSessionRecovery } from "./main-session-recovery-store.js";

const log = createSubsystemLogger("main-session-restart-recovery");
const RESTART_RECOVERY_RESUME_MESSAGE =
  "[System] Your previous turn was interrupted by a gateway restart while " +
  "OpenClaw was waiting on tool/model work. Continue from the existing " +
  "transcript and finish the interrupted response.";

function buildResumeMessage(pendingFinalDeliveryText?: string | null): string {
  const sanitizedPendingText =
    typeof pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(pendingFinalDeliveryText)
      : "";
  if (sanitizedPendingText) {
    return `${RESTART_RECOVERY_RESUME_MESSAGE}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`;
  }
  return RESTART_RECOVERY_RESUME_MESSAGE;
}

export function resolveRestartRecoveryDeliveryContext(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  includeSessionDeliveryFallback?: boolean;
  sessionKey: string;
}): DeliveryContext | undefined {
  const activeRunDeliveryContext = normalizeDeliveryContext(
    params.entry.restartRecoveryDeliveryContext,
  );
  // A claim with no context is intentionally transcript-only. Only legacy
  // rows without a claim may fall back to the session delivery route.
  const hasActiveRunDeliveryClaim =
    normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId) !== undefined;
  const deliveryContext =
    normalizeDeliveryContext(params.entry.pendingFinalDeliveryContext) ??
    activeRunDeliveryContext ??
    (params.includeSessionDeliveryFallback && !hasActiveRunDeliveryClaim
      ? deliveryContextFromSession(params.entry)
      : undefined);
  const channel = normalizeOptionalString(deliveryContext?.channel);
  const to = normalizeOptionalString(deliveryContext?.to);
  if (!channel || !to || !isDeliverableMessageChannel(channel)) {
    return undefined;
  }
  if (
    params.cfg &&
    resolveSendPolicy({
      cfg: params.cfg,
      entry: params.entry,
      sessionKey: params.sessionKey,
      channel,
      chatType: params.entry.chatType,
    }) === "deny"
  ) {
    return undefined;
  }
  return { ...deliveryContext, channel, to };
}

async function reserveMainRestartRecoveryAttempt(params: {
  observation: MainSessionRecoveryObservation;
  recoveryAttempt: number;
  reservationRunId: string;
  sessionKey: string;
  storePath: string;
}): Promise<MainSessionRecoveryReservation | null> {
  const reservation = await commitMainSessionRecovery({
    command: {
      kind: "prepare_attempt",
      attempt: params.recoveryAttempt,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      now: Date.now(),
      observation: params.observation,
      runId: params.reservationRunId,
    },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  return reservation.transition.kind === "reserved" ? reservation.transition.reservation : null;
}

async function rollbackMainRestartRecoveryAttempt(params: {
  reservation: MainSessionRecoveryReservation;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await commitMainSessionRecovery({
    command: { kind: "cancel_reservation", reservation: params.reservation },
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
}

export type MainSessionResumeResult = "resumed" | "skipped" | "failed";

export async function resumeMainSession(params: {
  canonicalSessionKey?: string;
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  observation: MainSessionRecoveryObservation;
  recoveryAttempt: number;
  storePath: string;
  sessionKey: string;
  pendingFinalDeliveryText?: string | null;
  forceRestartSafeTools?: boolean;
  sessionWorkAdmissionHandoffId?: string;
}): Promise<MainSessionResumeResult> {
  const sanitizedPendingText =
    typeof params.pendingFinalDeliveryText === "string"
      ? sanitizePendingFinalDeliveryText(params.pendingFinalDeliveryText)
      : "";
  const deliveryContext = resolveRestartRecoveryDeliveryContext({
    cfg: params.cfg,
    entry: params.entry,
    sessionKey: params.sessionKey,
  });
  const recoveryRunId = randomUUID();
  const dispatchSessionKey = params.canonicalSessionKey ?? params.sessionKey;
  let reservation: MainSessionRecoveryReservation | null = null;
  let dispatchStarted = false;
  try {
    reservation = await reserveMainRestartRecoveryAttempt({
      observation: params.observation,
      recoveryAttempt: params.recoveryAttempt,
      reservationRunId: recoveryRunId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    if (!reservation) {
      return "skipped";
    }
    const recoveryStatePrepared = await applySessionEntryReplacements({
      sessionKeys: [params.sessionKey],
      storePath: params.storePath,
      update: (entries) => {
        const current = entries.find((entry) => entry.sessionKey === params.sessionKey);
        const entry = current?.entry as SessionEntry | undefined;
        if (
          !entry ||
          entry.sessionId !== params.entry.sessionId ||
          entry.status !== "running" ||
          entry.abortedLastRun !== true ||
          entry.mainRestartRecovery?.reservation?.runId !== recoveryRunId ||
          normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !==
            normalizeOptionalString(params.entry.restartRecoveryDeliveryRunId) ||
          normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !==
            normalizeOptionalString(params.entry.restartRecoveryDeliverySourceRunId)
        ) {
          return { result: false };
        }
        if (params.forceRestartSafeTools) {
          entry.restartRecoveryForceSafeTools = true;
          entry.updatedAt = Date.now();
          return {
            result: true,
            replacements: [{ sessionKey: params.sessionKey, entry }],
          };
        }
        return { result: true };
      },
    });
    if (!recoveryStatePrepared) {
      await rollbackMainRestartRecoveryAttempt({
        reservation,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
      });
      reservation = null;
      return "skipped";
    }
    const agentParams: Record<string, unknown> = {
      message: buildResumeMessage(sanitizedPendingText),
      sessionKey: dispatchSessionKey,
      sessionId: params.entry.sessionId,
      expectedExistingSessionId: params.entry.sessionId,
      ...(params.sessionWorkAdmissionHandoffId
        ? { internalRuntimeHandoffId: params.sessionWorkAdmissionHandoffId }
        : {}),
      idempotencyKey: recoveryRunId,
      deliver: Boolean(deliveryContext),
      lane: CommandLane.Main,
      ...(params.forceRestartSafeTools ? { forceRestartSafeTools: true } : {}),
      inputProvenance: {
        kind: "internal_system",
        sourceSessionKey: dispatchSessionKey,
        sourceTool: MAIN_SESSION_RESTART_RECOVERY_SOURCE_TOOL,
      },
    };
    if (deliveryContext) {
      agentParams.channel = deliveryContext.channel;
      agentParams.to = deliveryContext.to;
      agentParams.bestEffortDeliver = true;
      if (deliveryContext.accountId) {
        agentParams.accountId = deliveryContext.accountId;
      }
      if (deliveryContext.threadId != null) {
        agentParams.threadId = String(deliveryContext.threadId);
      }
    }
    if (params.forceRestartSafeTools) {
      log.info(`dispatching restart-safe recovery for ${params.sessionKey}`);
    }
    await callGateway<{ runId: string; status?: unknown }>({
      method: "agent",
      params: agentParams,
      timeoutMs: 10_000,
      onDispatched: () => {
        dispatchStarted = true;
      },
    });
    log.info(
      `resumed interrupted main session: ${params.sessionKey}${
        sanitizedPendingText ? " (with pending payload)" : ""
      }`,
    );
    return "resumed";
  } catch (error) {
    // Once bytes were sent, only an explicit Gateway rejection proves that
    // acceptance did not happen. Keep uncertain charges to prevent replay.
    const shouldRollbackReservation =
      !dispatchStarted || error instanceof GatewayClientRequestError;
    if (shouldRollbackReservation && reservation) {
      try {
        await rollbackMainRestartRecoveryAttempt({
          reservation,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
      } catch (rollbackError) {
        log.warn(
          `failed to roll back interrupted main session recovery attempt ${params.sessionKey}: ${String(rollbackError)}`,
        );
      }
    }
    log.warn(`failed to resume interrupted main session ${params.sessionKey}: ${String(error)}`);
    return "failed";
  }
}
