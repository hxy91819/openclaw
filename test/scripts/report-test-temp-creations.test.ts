import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectTempCreationFindingsFromDiff } from "../../scripts/report-test-temp-creations.mjs";

const repoRoot = process.cwd();

describe("report-test-temp-creations", () => {
  it("reports only added bare temp creation lines in test files", () => {
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -10,0 +11,3 @@",
      "+" + "const tempRoot = fs." + "mkdtemp" + "Sync(path.join(os." + 'tmpdir(), "case-"));',
      '+const helperRoot = makeTempDir(tempDirs, "case-");',
      "+console.log(tempRoot, helperRoot);",
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -4,0 +5,1 @@",
      "+" + "const productionTemp = fs." + "mkdtemp" + 'Sync("case-");',
    ].join("\n");

    expect(collectTempCreationFindingsFromDiff(diff)).toEqual([
      {
        file: "src/example.test.ts",
        line: 11,
        reason: "new mkdtemp temp directory creation",
        source: 'const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "case-"));',
      },
    ]);
  });

  it("prints help with usage, outputs, and examples", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"), "--help"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(output).toContain("Usage: node scripts/report-test-temp-creations.mjs");
    expect(output).toContain("Outputs:");
    expect(output).toContain("Examples:");
  });
});
