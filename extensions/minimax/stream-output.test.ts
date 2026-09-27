// MiniMax stream-output tests keep the provider-only message-end marker from
// leaking through streaming while preserving literal text in continuing turns.
import type { AssistantMessage, AssistantMessageEvent } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createMiniMaxMessageEndMarkerWrapper } from "./stream-output.js";

const MESSAGE_END_MARKER = "[e~[";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "minimax",
    model: "MiniMax-M2.7",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function createSource(events: AssistantMessageEvent[]) {
  const output = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) {
      output.push(event);
    }
    output.end();
  });
  return output;
}

async function collectEvents(
  events: AssistantMessageEvent[],
  model = { provider: "minimax", id: "MiniMax-M2.7" },
) {
  const wrapper = createMiniMaxMessageEndMarkerWrapper(() => createSource(events));
  const stream = await Promise.resolve(
    wrapper({ ...model, api: "anthropic-messages" } as never, { messages: [] } as never, {}),
  );
  const received: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    received.push(event);
  }
  return received;
}

describe("createMiniMaxMessageEndMarkerWrapper", () => {
  it("removes the split terminal marker before downstream streaming consumers see it", async () => {
    const partialBeforeMarker = assistant([{ type: "text", text: "answer [e" }]);
    const terminal = assistant([{ type: "text", text: `answer ${MESSAGE_END_MARKER}` }]);
    const events = await collectEvents([
      { type: "start", partial: assistant([]) },
      { type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }]) },
      { type: "text_delta", contentIndex: 0, delta: "answer [e", partial: partialBeforeMarker },
      { type: "text_delta", contentIndex: 0, delta: "~[", partial: terminal },
      {
        type: "text_end",
        contentIndex: 0,
        content: `answer ${MESSAGE_END_MARKER}`,
        partial: terminal,
      },
      { type: "done", reason: "stop", message: terminal },
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(events[2]).toMatchObject({ type: "text_delta", delta: "answer " });
    expect(events[3]).toMatchObject({ type: "text_end", content: "answer " });
    expect((events[4] as Extract<AssistantMessageEvent, { type: "done" }>).message.content).toEqual(
      [{ type: "text", text: "answer " }],
    );
  });

  it("preserves the marker when later events prove it was normal content", async () => {
    const firstText = assistant([{ type: "text", text: MESSAGE_END_MARKER }]);
    const continuing = assistant([
      { type: "text", text: MESSAGE_END_MARKER },
      { type: "text", text: "more" },
    ]);
    const events = await collectEvents([
      { type: "start", partial: assistant([]) },
      { type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }]) },
      { type: "text_delta", contentIndex: 0, delta: MESSAGE_END_MARKER, partial: firstText },
      { type: "text_end", contentIndex: 0, content: MESSAGE_END_MARKER, partial: firstText },
      {
        type: "text_start",
        contentIndex: 1,
        partial: assistant([
          { type: "text", text: MESSAGE_END_MARKER },
          { type: "text", text: "" },
        ]),
      },
      { type: "text_delta", contentIndex: 1, delta: "more", partial: continuing },
      { type: "text_end", contentIndex: 1, content: "more", partial: continuing },
      { type: "done", reason: "stop", message: continuing },
    ]);

    expect(
      events
        .filter(
          (event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> =>
            event.type === "text_delta",
        )
        .map((event) => event.delta),
    ).toEqual([MESSAGE_END_MARKER, "more"]);
    expect(
      (events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>).message.content,
    ).toEqual(continuing.content);
  });

  it("does not alter Ollama Cloud's MiniMax M2.7 text", async () => {
    const terminal = assistant([{ type: "text", text: MESSAGE_END_MARKER }]);
    const events = await collectEvents(
      [
        { type: "text_delta", contentIndex: 0, delta: MESSAGE_END_MARKER, partial: terminal },
        { type: "text_end", contentIndex: 0, content: MESSAGE_END_MARKER, partial: terminal },
        { type: "done", reason: "stop", message: terminal },
      ],
      { provider: "ollama-cloud", id: "minimax-m2.7:cloud" },
    );

    expect(events).toEqual([
      { type: "text_delta", contentIndex: 0, delta: MESSAGE_END_MARKER, partial: terminal },
      { type: "text_end", contentIndex: 0, content: MESSAGE_END_MARKER, partial: terminal },
      { type: "done", reason: "stop", message: terminal },
    ]);
  });
});
