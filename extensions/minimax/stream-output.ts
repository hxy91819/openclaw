// MiniMax stream output normalization stays in the provider boundary because
// `[e~[` is MiniMax's message-end marker, not a generic model-text token.
import type { AssistantMessage, AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

const MINIMAX_MESSAGE_END_MARKER = "[e~[";

type ProviderStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;
type TextDeltaEvent = Extract<AssistantMessageEvent, { type: "text_delta" }>;
type TextEndEvent = Extract<AssistantMessageEvent, { type: "text_end" }>;

function isMiniMaxModel(model: Parameters<ProviderStreamFn>[0]): boolean {
  return model.provider === "minimax" || model.provider === "minimax-portal";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<AssistantMessageEvent> {
  return (
    Boolean(value) &&
    typeof (value as AsyncIterable<AssistantMessageEvent>)[Symbol.asyncIterator] === "function"
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && typeof (value as PromiseLike<unknown>).then === "function";
}

function splitTrailingMarkerCandidate(text: string): { emitted: string; pending: string } {
  for (let length = MINIMAX_MESSAGE_END_MARKER.length; length > 0; length -= 1) {
    const candidate = MINIMAX_MESSAGE_END_MARKER.slice(0, length);
    if (text.endsWith(candidate)) {
      return { emitted: text.slice(0, -length), pending: candidate };
    }
  }
  return { emitted: text, pending: "" };
}

function replaceTextAtIndex(
  message: AssistantMessage,
  contentIndex: number,
  replace: (text: string) => string,
): AssistantMessage {
  const block = message.content[contentIndex];
  if (!block || block.type !== "text") {
    return message;
  }
  const text = replace(block.text);
  if (text === block.text) {
    return message;
  }
  return {
    ...message,
    content: message.content.map((entry, index) =>
      index === contentIndex ? { ...entry, text } : entry,
    ),
  };
}

function removeTrailingSuffix(
  message: AssistantMessage,
  contentIndex: number,
  suffix: string,
): AssistantMessage {
  if (!suffix) {
    return message;
  }
  return replaceTextAtIndex(message, contentIndex, (text) =>
    text.endsWith(suffix) ? text.slice(0, -suffix.length) : text,
  );
}

function removeTerminalMarker(message: AssistantMessage): AssistantMessage {
  return removeTrailingSuffix(message, message.content.length - 1, MINIMAX_MESSAGE_END_MARKER);
}

function removeTerminalMarkerFromTextEnd(event: TextEndEvent): TextEndEvent {
  return {
    ...event,
    content: event.content.endsWith(MINIMAX_MESSAGE_END_MARKER)
      ? event.content.slice(0, -MINIMAX_MESSAGE_END_MARKER.length)
      : event.content,
    partial: removeTrailingSuffix(event.partial, event.contentIndex, MINIMAX_MESSAGE_END_MARKER),
  };
}

/**
 * Removes MiniMax's documented message-end marker without letting it reach
 * streaming consumers. A trailing candidate is held until the next event so
 * literal marker text remains intact when the message continues.
 */
export function createMiniMaxMessageEndMarkerWrapper(
  underlying: ProviderStreamFn,
): ProviderStreamFn {
  return (model, context, options) => {
    if (!isMiniMaxModel(model)) {
      return underlying(model, context, options);
    }

    const output = createAssistantMessageEventStream();
    const pendingByContentIndex = new Map<number, string>();
    let delayedTextEnd: TextEndEvent | undefined;

    const flushPending = (contentIndex: number, discardMarker: boolean) => {
      const pending = pendingByContentIndex.get(contentIndex);
      pendingByContentIndex.delete(contentIndex);
      if (!pending || (discardMarker && pending === MINIMAX_MESSAGE_END_MARKER)) {
        return;
      }
      output.push({ type: "text_delta", contentIndex, delta: pending });
    };

    const flushDelayedTextEnd = (terminal: boolean) => {
      if (!delayedTextEnd) {
        return;
      }
      const event = delayedTextEnd;
      delayedTextEnd = undefined;
      flushPending(event.contentIndex, terminal);
      output.push(terminal ? removeTerminalMarkerFromTextEnd(event) : event);
    };

    const flushAllPending = (discardMarker: boolean) => {
      for (const contentIndex of [...pendingByContentIndex.keys()]) {
        flushPending(contentIndex, discardMarker);
      }
    };

    const sourceResult = underlying(model, context, options);
    if (!isPromiseLike(sourceResult) && !isAsyncIterable(sourceResult)) {
      return sourceResult;
    }
    void (async () => {
      try {
        const source = await Promise.resolve(sourceResult);
        if (!isAsyncIterable(source)) {
          return;
        }
        for await (const event of source) {
          if (event.type === "done") {
            flushDelayedTextEnd(true);
            flushAllPending(true);
            const message = removeTerminalMarker(event.message);
            output.push({ ...event, message });
            output.end(message);
            return;
          }
          if (event.type === "error") {
            flushDelayedTextEnd(true);
            flushAllPending(true);
            output.push({ ...event, error: removeTerminalMarker(event.error) });
            output.end();
            return;
          }

          // A following non-terminal event proves that a held marker was literal text.
          flushDelayedTextEnd(false);

          if (event.type === "text_delta") {
            const combined = `${pendingByContentIndex.get(event.contentIndex) ?? ""}${event.delta}`;
            const { emitted, pending } = splitTrailingMarkerCandidate(combined);
            if (pending) {
              pendingByContentIndex.set(event.contentIndex, pending);
            } else {
              pendingByContentIndex.delete(event.contentIndex);
            }
            if (emitted) {
              const deltaEvent: TextDeltaEvent = {
                ...event,
                delta: emitted,
                ...(pending && event.partial
                  ? { partial: removeTrailingSuffix(event.partial, event.contentIndex, pending) }
                  : {}),
              };
              output.push(deltaEvent);
            }
            continue;
          }

          if (event.type === "text_end") {
            if (event.content.endsWith(MINIMAX_MESSAGE_END_MARKER)) {
              delayedTextEnd = event;
            } else {
              flushPending(event.contentIndex, false);
              output.push(event);
            }
            continue;
          }

          output.push(event);
        }
      } finally {
        // A malformed source stream without a terminal event must not strand
        // consumers. Treat a held suffix as ordinary text because completion
        // was never proven.
        flushDelayedTextEnd(false);
        flushAllPending(false);
        output.end();
      }
    })();

    return output;
  };
}
