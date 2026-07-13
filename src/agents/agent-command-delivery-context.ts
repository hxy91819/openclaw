import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../infra/outbound/channel-selection.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL, isDeliverableMessageChannel } from "../utils/message-channel.js";
import type { AgentCommandOpts } from "./command/types.js";

export async function resolveCurrentRunDeliveryContext(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
}): Promise<DeliveryContext | undefined> {
  const { cfg, opts, sessionEntry } = params;
  if (opts.deliver !== true) {
    return undefined;
  }
  const deliveryPlan = resolveAgentDeliveryPlan({
    sessionEntry,
    requestedChannel: opts.replyChannel ?? opts.channel,
    explicitTo: opts.replyTo ?? opts.to,
    explicitThreadId: opts.threadId,
    accountId: opts.replyAccountId ?? opts.accountId,
    wantsDelivery: true,
    turnSourceChannel: opts.runContext?.messageChannel ?? opts.messageChannel,
    turnSourceTo: opts.runContext?.currentChannelId ?? opts.to,
    turnSourceAccountId: opts.runContext?.accountId ?? opts.accountId,
    turnSourceThreadId: opts.runContext?.currentThreadTs ?? opts.threadId,
  });
  const explicitChannelHint = normalizeOptionalString(opts.replyChannel ?? opts.channel);
  const explicitThreadId =
    opts.threadId != null && opts.threadId !== "" ? opts.threadId : undefined;
  let effectivePlan = deliveryPlan;
  if (deliveryPlan.resolvedChannel === INTERNAL_MESSAGE_CHANNEL && !explicitChannelHint) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      effectivePlan = {
        ...deliveryPlan,
        resolvedChannel: selection.channel,
        deliveryTargetMode: deliveryPlan.deliveryTargetMode ?? "implicit",
      };
    } catch {
      return undefined;
    }
  }
  if (!isDeliverableMessageChannel(effectivePlan.resolvedChannel)) {
    return undefined;
  }
  const targetMode =
    opts.deliveryTargetMode ??
    effectivePlan.deliveryTargetMode ??
    (opts.to ? "explicit" : "implicit");
  const resolvedTo =
    effectivePlan.resolvedTo ??
    resolveAgentOutboundTarget({
      cfg,
      plan: effectivePlan,
      targetMode,
      validateExplicitTarget: false,
    }).resolvedTo;
  if (!resolvedTo) {
    return undefined;
  }
  const threadId =
    targetMode === "explicit"
      ? (explicitThreadId ??
        (effectivePlan.baseDelivery.threadIdSource === "explicit"
          ? effectivePlan.resolvedThreadId
          : undefined))
      : effectivePlan.resolvedThreadId;
  return normalizeDeliveryContext({
    channel: effectivePlan.resolvedChannel,
    to: resolvedTo,
    accountId: effectivePlan.resolvedAccountId,
    threadId,
  });
}
