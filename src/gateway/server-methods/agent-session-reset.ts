import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import { resolveAgentMainSessionKey, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentDeliveryPlanWithSessionRoute } from "../../infra/outbound/agent-delivery.js";
import type { PluginHookSessionEndReason } from "../../plugins/hook-types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  emitGatewaySessionEndPluginHook,
  emitGatewaySessionStartPluginHook,
  performGatewaySessionReset,
} from "../session-reset-service.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type BareSessionResetDeliveryRequest = {
  replyTo?: string;
  to?: string;
  replyChannel?: string;
  channel?: string;
  replyAccountId?: string;
  accountId?: string;
  threadId?: string | number;
  bestEffortDeliver?: boolean;
};

export type AgentSendSessionLifecycleTransition = {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  previousSessionId?: string;
  previousSessionFile?: string;
  previousEndReason?: PluginHookSessionEndReason;
};

export function emitAgentSendSessionLifecycleTransition(
  transition: AgentSendSessionLifecycleTransition | undefined,
): void {
  if (!transition) {
    return;
  }
  if (transition.previousSessionId) {
    emitGatewaySessionEndPluginHook({
      cfg: transition.cfg,
      sessionKey: transition.sessionKey,
      sessionId: transition.previousSessionId,
      storePath: transition.storePath,
      sessionFile: transition.previousSessionFile,
      agentId: transition.agentId,
      reason: transition.previousEndReason ?? "unknown",
      nextSessionId: transition.sessionId,
      nextSessionKey: transition.sessionKey,
    });
  }
  emitGatewaySessionStartPluginHook({
    cfg: transition.cfg,
    sessionKey: transition.sessionKey,
    sessionId: transition.sessionId,
    resumedFrom: transition.previousSessionId,
    storePath: transition.storePath,
    sessionFile: transition.sessionFile,
    agentId: transition.agentId,
  });
}

export async function runSessionResetFromAgent(params: {
  key: string;
  agentId?: string;
  reason: "new" | "reset";
  assertCurrent?: () => void;
  onCommitted?: (commit: { key: string; sessionId: string }) => void;
}): Promise<
  | { ok: true; key: string; sessionId?: string }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const result = await performGatewaySessionReset({
    key: params.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    reason: params.reason,
    commandSource: "gateway:agent",
    assertCurrent: params.assertCurrent,
    onCommitted: params.onCommitted,
  });
  return result.ok ? { ok: true, key: result.key, sessionId: result.entry.sessionId } : result;
}

export function sessionResetAckText(reason: "new" | "reset"): string {
  return reason === "new" ? "✅ New session started." : "✅ Session reset.";
}

export function buildBareSessionResetResult(params: {
  reason: "new" | "reset";
  sessionId?: string;
  ackText?: string;
}) {
  return {
    payloads: [{ text: params.ackText ?? sessionResetAckText(params.reason) }],
    meta: {
      durationMs: 0,
      ...(params.sessionId ? { agentMeta: { sessionId: params.sessionId } } : {}),
    },
  };
}

export function buildBareSessionResetResponse(params: { runId: string; result: unknown }) {
  return {
    runId: params.runId,
    status: "ok" as const,
    summary: "completed",
    result: params.result,
  };
}

async function deliverBareSessionResetResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestHandlerOptions["context"];
  reason: "new" | "reset";
  sessionId?: string;
  sessionKey: string;
  agentId?: string;
  sessionEntry?: SessionEntry;
  request: BareSessionResetDeliveryRequest;
  bestEffortDeliver?: boolean;
  deliveryTargetMode?: AgentCommandOpts["deliveryTargetMode"];
  originMessageChannel?: string;
  runId: string;
  assertCurrent?: () => void;
  ackText?: string;
}) {
  const { deliverAgentCommandResult } = await import("../../agents/command/delivery.runtime.js");
  params.assertCurrent?.();
  const result = buildBareSessionResetResult(params);
  return await deliverAgentCommandResult({
    cfg: params.cfg,
    deps: params.context.deps,
    runtime: defaultRuntime,
    opts: {
      message: params.ackText ?? sessionResetAckText(params.reason),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      sessionKey: params.sessionKey,
      deliver: true,
      replyTo: params.request.replyTo,
      to: params.request.to,
      replyChannel: params.request.replyChannel,
      channel: params.request.channel,
      replyAccountId: params.request.replyAccountId,
      accountId: params.request.accountId,
      threadId: params.request.threadId,
      deliveryTargetMode: params.deliveryTargetMode,
      bestEffortDeliver: params.bestEffortDeliver,
      runId: params.runId,
      messageChannel: params.originMessageChannel,
      runContext: {
        messageChannel: params.originMessageChannel,
        accountId: params.request.replyAccountId ?? params.request.accountId,
        currentThreadTs:
          params.request.threadId != null ? String(params.request.threadId) : undefined,
      },
      allowModelOverride: false,
    },
    outboundSession: undefined,
    sessionEntry: params.sessionEntry,
    result: result as never,
    payloads: result.payloads as never,
    assertDeliveryCurrent: params.assertCurrent,
  });
}

export async function resolveBareSessionResetResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestHandlerOptions["context"];
  reason: "new" | "reset";
  sessionId?: string;
  sessionKey: string;
  agentId?: string;
  sessionEntry?: SessionEntry;
  request: Parameters<GatewayRequestHandlers["agent"]>[0]["params"];
  originMessageChannel?: string;
  runId: string;
  assertCurrent?: () => void;
  ackText?: string;
}) {
  params.assertCurrent?.();
  if (params.request.deliver !== true) {
    return buildBareSessionResetResult(params);
  }
  if (
    resolveSendPolicy({
      cfg: params.cfg,
      entry: params.sessionEntry,
      sessionKey: params.sessionKey,
      channel: params.sessionEntry?.channel,
      chatType: params.sessionEntry?.chatType,
    }) === "deny"
  ) {
    throw new Error("send blocked by session policy");
  }
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const deliveryPlan = await resolveAgentDeliveryPlanWithSessionRoute({
    cfg: params.cfg,
    agentId,
    currentSessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    requestedChannel:
      normalizeOptionalString(params.request.replyChannel) ??
      normalizeOptionalString(params.request.channel),
    explicitTo:
      normalizeOptionalString(params.request.replyTo) ?? normalizeOptionalString(params.request.to),
    explicitThreadId: normalizeOptionalString(params.request.threadId),
    accountId:
      normalizeOptionalString(params.request.replyAccountId) ??
      normalizeOptionalString(params.request.accountId),
    wantsDelivery: true,
    turnSourceChannel: normalizeOptionalString(params.request.channel),
    turnSourceTo: normalizeOptionalString(params.request.to),
    turnSourceAccountId: normalizeOptionalString(params.request.accountId),
    turnSourceThreadId: normalizeOptionalString(params.request.threadId),
  });
  params.assertCurrent?.();
  const mainSessionKey = resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
  const bestEffortDeliver =
    typeof params.request.bestEffortDeliver === "boolean"
      ? params.request.bestEffortDeliver
      : params.sessionKey === mainSessionKey || params.sessionKey === "global"
        ? true
        : undefined;
  return await deliverBareSessionResetResult({
    ...params,
    request: {
      replyTo: normalizeOptionalString(params.request.replyTo),
      channel: deliveryPlan.resolvedChannel,
      to: deliveryPlan.resolvedTo ?? deliveryPlan.baseDelivery.to,
      replyChannel: normalizeOptionalString(params.request.replyChannel),
      replyAccountId: normalizeOptionalString(params.request.replyAccountId),
      accountId: deliveryPlan.resolvedAccountId ?? deliveryPlan.baseDelivery.accountId,
      threadId: deliveryPlan.resolvedThreadId,
      bestEffortDeliver:
        typeof params.request.bestEffortDeliver === "boolean"
          ? params.request.bestEffortDeliver
          : undefined,
    },
    bestEffortDeliver,
    deliveryTargetMode: deliveryPlan.deliveryTargetMode ?? deliveryPlan.baseDelivery.mode,
    originMessageChannel: params.originMessageChannel ?? deliveryPlan.resolvedChannel,
  });
}

export function loadBareSessionResetDeliverySession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): { cfg: OpenClawConfig; entry?: SessionEntry; agentId: string } {
  const selectedGlobalAgentId =
    params.sessionKey === "global" && params.agentId ? params.agentId : undefined;
  const loaded = loadSessionEntry(params.sessionKey, {
    clone: false,
    ...(selectedGlobalAgentId ? { agentId: selectedGlobalAgentId } : {}),
  });
  const cfg = loaded?.cfg ?? params.cfg;
  return {
    cfg,
    entry: loaded?.entry,
    agentId:
      selectedGlobalAgentId ??
      resolveAgentIdFromSessionKey(params.sessionKey) ??
      resolveDefaultAgentId(cfg),
  };
}
