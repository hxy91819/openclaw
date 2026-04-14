export type UnreleasedSection = "Breaking" | "Changes" | "Fixes";

function normalizePrRefToken(value: string): string {
  const match = value.match(/(?:^|\()#(\d+)(?:\)|$)|openclaw#(\d+)/i);
  const prNumber = match?.[1] ?? match?.[2];
  return prNumber ? `#${prNumber}` : value.trim().toLowerCase();
}

function stripBullet(line: string): string {
  return line.trim().replace(/^-\s+/, "");
}

function findPrReference(line: string): string | undefined {
  const match = line.match(/(?:\(#\d+\)|openclaw#\d+)/i);
  return match?.[0];
}

function entriesAreEquivalent(existingLine: string, newBullet: string): boolean {
  const existingBody = stripBullet(existingLine);
  const newBody = stripBullet(newBullet);
  if (existingBody === newBody) {
    return true;
  }

  const existingPrRef = findPrReference(existingBody);
  const newPrRef = findPrReference(newBody);
  if (!existingPrRef || !newPrRef) {
    return false;
  }

  if (normalizePrRefToken(existingPrRef) !== normalizePrRefToken(newPrRef)) {
    return false;
  }

  const existingWithoutRef = existingBody.replace(/(?:\s*\(#\d+\)|\s*openclaw#\d+)/gi, "").trim();
  const newWithoutRef = newBody.replace(/(?:\s*\(#\d+\)|\s*openclaw#\d+)/gi, "").trim();
  return existingWithoutRef === newWithoutRef;
}

function findSectionRange(
  lines: string[],
  section: UnreleasedSection,
): {
  start: number;
  insertAt: number;
} {
  const unreleasedIndex = lines.findIndex((line) => line.trim() === "## Unreleased");
  if (unreleasedIndex === -1) {
    throw new Error("CHANGELOG.md is missing the '## Unreleased' heading.");
  }

  const sectionHeading = `### ${section}`;
  let sectionIndex = -1;
  for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) {
      break;
    }
    if (line.trim() === sectionHeading) {
      sectionIndex = index;
      break;
    }
  }
  if (sectionIndex === -1) {
    throw new Error(`CHANGELOG.md is missing the '${sectionHeading}' section under Unreleased.`);
  }

  let insertAt = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("### ") || line.startsWith("## ")) {
      insertAt = index;
      break;
    }
  }

  while (insertAt > sectionIndex + 1 && lines[insertAt - 1]?.trim() === "") {
    insertAt -= 1;
  }

  return { start: sectionIndex, insertAt };
}

export function appendUnreleasedChangelogEntry(
  content: string,
  params: {
    section: UnreleasedSection;
    entry: string;
  },
): string {
  const entry = params.entry.trim();
  if (!entry) {
    throw new Error("Changelog entry must not be empty.");
  }

  const lines = content.split("\n");
  const bullet = entry.startsWith("- ") ? entry : `- ${entry}`;
  if (lines.some((line) => entriesAreEquivalent(line, bullet))) {
    return content;
  }

  const { insertAt } = findSectionRange(lines, params.section);
  lines.splice(insertAt, 0, bullet, "");
  return lines.join("\n");
}
