import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const prScriptPath = path.join(process.cwd(), "scripts", "pr");

describe("scripts/pr", () => {
  it("does not require Bun for every PR workflow subcommand", () => {
    const source = readFileSync(prScriptPath, "utf8");

    expect(source).toContain("for cmd in git gh jq rg pnpm node; do");
    expect(source).not.toContain("for cmd in git gh jq rg pnpm node bun; do");
  });
});
