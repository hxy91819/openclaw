import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

describe("buildSystemPrompt", () => {
  it("asks for a brief preamble before tools on complex work", () => {
    const prompt = buildSystemPrompt({
      cwd: "/tmp/openclaw",
    });

    expect(prompt).toContain("send one brief user-visible preamble before the first tool call");
    expect(prompt).toContain("Skip the preamble for direct answers");
  });
});
