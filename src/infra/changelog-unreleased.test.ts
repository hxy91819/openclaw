import { describe, expect, it } from "vitest";
import { appendUnreleasedChangelogEntry } from "./changelog-unreleased.js";

const baseChangelog = `# Changelog

## Unreleased

### Breaking

- Existing breaking entry.

### Changes

- Existing change.

### Fixes

- Existing fix.

## 2026.4.5
`;

describe("appendUnreleasedChangelogEntry", () => {
  it("appends to the end of the requested unreleased section", () => {
    const next = appendUnreleasedChangelogEntry(baseChangelog, {
      section: "Fixes",
      entry: "New fix entry.",
    });

    expect(next).toContain(`### Fixes

- Existing fix.
- New fix entry.`);
    expect(next).toContain("## 2026.4.5");
  });

  it("avoids duplicating an existing entry", () => {
    const next = appendUnreleasedChangelogEntry(baseChangelog, {
      section: "Changes",
      entry: "- Existing change.",
    });

    expect(next).toBe(baseChangelog);
  });

  it("avoids duplicating an equivalent entry with the same PR reference", () => {
    const content = `# Changelog

## Unreleased

### Fixes

- Fix onboarding timeout handling (#123). Thanks @alice

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Fixes",
      entry: "Fix onboarding timeout handling openclaw#123. Thanks @alice",
    });

    expect(next).toBe(content);
  });

  it("throws when the unreleased section is missing", () => {
    expect(() =>
      appendUnreleasedChangelogEntry("# Changelog\n", {
        section: "Fixes",
        entry: "New fix entry.",
      }),
    ).toThrow("## Unreleased");
  });
});
