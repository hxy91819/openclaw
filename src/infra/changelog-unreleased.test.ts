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
  it("falls back to appending when the new entry has no PR ref", () => {
    const next = appendUnreleasedChangelogEntry(baseChangelog, {
      section: "Fixes",
      entry: "New fix entry.",
    });

    expect(next).toContain(`### Fixes

- Existing fix.
- New fix entry.`);
    expect(next).toContain("## 2026.4.5");
  });

  it("inserts a PR-linked entry into the numeric gap between neighboring PRs", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Later change (#300). Thanks @carol
- Earlier change (#100). Thanks @alice

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Middle change (#200). Thanks @bob",
    });

    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Later change (#300). Thanks @carol
- Middle change (#200). Thanks @bob
- Earlier change (#100). Thanks @alice

## 2026.4.5
`);
  });

  it("inserts into a numeric gap even when nearby entries are ascending", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Earlier change (#100). Thanks @alice
- Later change (#300). Thanks @carol

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Middle change (#200). Thanks @bob",
    });

    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Earlier change (#100). Thanks @alice
- Middle change (#200). Thanks @bob
- Later change (#300). Thanks @carol

## 2026.4.5
`);
  });

  it("uses a dated Unreleased release block as the active section", () => {
    const content = `# Changelog

## 2026.4.24 (Unreleased)

### Changes

- Earlier change (#100). Thanks @alice

### Fixes

## 2026.4.23
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Fixes",
      entry: "Fix release check inputs (#66884). Thanks @alexlomt",
    });

    expect(next).toContain("## 2026.4.24 (Unreleased)");
    expect(next).not.toContain("## Unreleased\n\n### Changes");
    expect(next.indexOf("- Fix release check inputs (#66884). Thanks @alexlomt")).toBeLessThan(
      next.indexOf("## 2026.4.23"),
    );
  });

  it("inserts a PR-linked entry with the largest number at the top of the section", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Earlier change (#50). Thanks @alice

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Later change (#300). Thanks @carol",
    });

    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Later change (#300). Thanks @carol
- Earlier change (#50). Thanks @alice

## 2026.4.5
`);
  });

  it("inserts a PR-linked entry with the smallest number at the tail of the section", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Newest change (#500). Thanks @carol
- Later change (#200). Thanks @bob

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Earlier change (#100). Thanks @alice",
    });

    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Newest change (#500). Thanks @carol
- Later change (#200). Thanks @bob
- Earlier change (#100). Thanks @alice

## 2026.4.5
`);
  });

  it("inserts into an empty sub-section while preserving surrounding spacing", () => {
    const content = `# Changelog

## Unreleased

### Changes

### Fixes

- Existing fix.

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "First change (#42). Thanks @alice",
    });

    expect(next).toContain("- First change (#42). Thanks @alice");
    // The new bullet stays inside the empty Changes block before Fixes.
    const changesIdx = next.indexOf("### Changes");
    const firstIdx = next.indexOf("- First change");
    const fixesIdx = next.indexOf("### Fixes");
    expect(changesIdx).toBeLessThan(firstIdx);
    expect(firstIdx).toBeLessThan(fixesIdx);
    // Existing Fixes bullets remain untouched.
    expect(next).toContain(`### Fixes

- Existing fix.`);
  });

  it("skips historical bullets without PR refs when deciding order", () => {
    const content = `# Changelog

## Unreleased

### Changes

- Legacy unlinked entry without a PR ref.
- Linked change (#150). Thanks @bob

## 2026.4.5
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "Linked change (#300). Thanks @carol",
    });

    // PR-less historical bullets do not become ordering anchors.
    expect(next).toBe(`# Changelog

## Unreleased

### Changes

- Legacy unlinked entry without a PR ref.
- Linked change (#300). Thanks @carol
- Linked change (#150). Thanks @bob

## 2026.4.5
`);
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

  it("blocks a merge-stage re-insert even when new text and section differ (PR #67679 regression)", () => {
    // The detailed entry already exists in ### Fixes from prepare time.
    const content = `# Changelog

## Unreleased

### Changes

- macOS/gateway: add screen.snapshot support. (#67954) Thanks @BunsDev.

### Fixes

- Config/redact: add \`browser.cdpUrl\` and \`browser.profiles.*.cdpUrl\` to sensitive URL config paths so embedded credentials are properly redacted. (#67679) Thanks @Ziy1-Tan.

## 2026.4.15
`;

    // Merge-time ensure runs again with the PR title in ### Changes.
    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "fix: redact credentials in browser.cdpUrl config paths (#67679). Thanks @Ziy1-Tan",
    });

    // The same PR must not be inserted twice under Unreleased.
    expect(next).toBe(content);
  });

  it("blocks a merge-stage re-insert when the active section is date-stamped", () => {
    const content = `# Changelog

## 2026.4.24 (Unreleased)

### Changes

### Fixes

- CI/release-checks: harden workflow inputs. (#66884) Thanks @alexlomt.

## 2026.4.23
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Fixes",
      entry: "fix(ci): harden release checks workflow inputs (#66884). Thanks @alexlomt",
    });

    expect(next).toBe(content);
  });

  it("still inserts a new Unreleased entry when the same PR number exists only in a released block", () => {
    // A released block with the same PR number must not block a new Unreleased entry.
    const content = `# Changelog

## Unreleased

### Changes

### Fixes

## 2026.4.15

### Fixes

- old released fix (#500). Thanks @alice
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "brand new change (#500). Thanks @alice",
    });

    expect(next).not.toBe(content);
    expect(next).toContain("- brand new change (#500). Thanks @alice");
    expect(next).toContain("- old released fix (#500). Thanks @alice");
  });

  it("does not treat #67 as a duplicate of #6767 (PR number prefix collision)", () => {
    const content = `# Changelog

## Unreleased

### Changes

- longer PR (#6767). Thanks @alice

## 2026.4.15
`;

    const next = appendUnreleasedChangelogEntry(content, {
      section: "Changes",
      entry: "shorter PR (#67). Thanks @bob",
    });

    expect(next).toContain("- longer PR (#6767)");
    expect(next).toContain("- shorter PR (#67)");
  });

  it("throws when the unreleased section is missing", () => {
    expect(() =>
      appendUnreleasedChangelogEntry("# Changelog\n", {
        section: "Fixes",
        entry: "New fix entry.",
      }),
    ).toThrow("Unreleased heading");
  });
});
