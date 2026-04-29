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

function extractPrNumber(line: string): number | undefined {
  // Use the first PR reference on the line as the sort key so "(#123, #456)"
  // is anchored by #123 instead of the later reference.
  const match = line.match(/(?:\(#(\d+)\)|openclaw#(\d+))/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) {
    return undefined;
  }
  const num = Number.parseInt(raw, 10);
  return Number.isFinite(num) ? num : undefined;
}

function isUnreleasedHeading(line: string): boolean {
  return /^##\s+(?:Unreleased|.+\s+\(Unreleased\))\s*$/.test(line.trim());
}

function findUnreleasedHeadingIndex(lines: string[]): number {
  return lines.findIndex((line) => isUnreleasedHeading(line));
}

function findSectionRange(
  lines: string[],
  section: UnreleasedSection,
): {
  start: number;
  bodyStart: number;
  bodyEnd: number;
} {
  const unreleasedIndex = findUnreleasedHeadingIndex(lines);
  if (unreleasedIndex === -1) {
    throw new Error("CHANGELOG.md is missing an Unreleased heading.");
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

  // bodyEnd points at the next heading (### or ##); bodyStart is the line
  // immediately after the subsection heading.
  let bodyEnd = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("### ") || line.startsWith("## ")) {
      bodyEnd = index;
      break;
    }
  }
  while (bodyEnd > sectionIndex + 1 && lines[bodyEnd - 1]?.trim() === "") {
    bodyEnd -= 1;
  }

  return { start: sectionIndex, bodyStart: sectionIndex + 1, bodyEnd };
}

function resolveOrderedInsertIndex(
  lines: string[],
  bodyStart: number,
  bodyEnd: number,
  newPr: number | undefined,
): number {
  // Keep the existing append behavior for handwritten entries without a PR ref.
  if (newPr === undefined) {
    return bodyEnd;
  }

  // Prefer inserting into the first local numeric gap that brackets the new PR,
  // regardless of whether nearby history is ascending or descending. That lets a
  // new entry land between neighboring PRs without reordering existing bullets.
  let firstLinkedIndex: number | undefined;
  let firstLinkedPr: number | undefined;
  let previousLinkedPr: number | undefined;
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    const line = lines[index];
    if (!line.startsWith("- ")) {
      continue;
    }
    const existingPr = extractPrNumber(line);
    if (existingPr === undefined) {
      continue;
    }

    if (firstLinkedIndex === undefined) {
      firstLinkedIndex = index;
      firstLinkedPr = existingPr;
    }

    if (
      previousLinkedPr !== undefined &&
      ((previousLinkedPr >= newPr && newPr >= existingPr) ||
        (previousLinkedPr <= newPr && newPr <= existingPr))
    ) {
      return index;
    }

    previousLinkedPr = existingPr;
  }

  // If no local gap brackets the new PR, only then fall back to top or tail.
  if (firstLinkedIndex !== undefined && firstLinkedPr !== undefined && newPr > firstLinkedPr) {
    return firstLinkedIndex;
  }
  return bodyEnd;
}

function findUnreleasedRange(lines: string[]): { start: number; end: number } | undefined {
  const unreleasedIndex = findUnreleasedHeadingIndex(lines);
  if (unreleasedIndex === -1) {
    return undefined;
  }
  let end = lines.length;
  for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  return { start: unreleasedIndex, end };
}

function unreleasedHasPrEntry(lines: string[], prNumber: number): boolean {
  const range = findUnreleasedRange(lines);
  if (!range) {
    return false;
  }
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index];
    if (!line.startsWith("- ")) {
      continue;
    }
    if (extractPrNumber(line) === prNumber) {
      return true;
    }
  }
  return false;
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

  // De-duplicate by PR number across all Unreleased subsections so merge-time
  // ensure calls do not add a second short-form entry for the same PR.
  const newPr = extractPrNumber(bullet);
  if (newPr !== undefined && unreleasedHasPrEntry(lines, newPr)) {
    return content;
  }

  // Keep a text-level duplicate guard for handwritten entries without PR refs
  // and for exact line matches.
  if (lines.some((line) => entriesAreEquivalent(line, bullet))) {
    return content;
  }

  const { bodyStart, bodyEnd } = findSectionRange(lines, params.section);
  const insertAt = resolveOrderedInsertIndex(lines, bodyStart, bodyEnd, newPr);

  // Preserve the existing blank-line shape for empty subsections.
  if (bodyEnd === bodyStart) {
    lines.splice(insertAt, 0, bullet, "");
    return lines.join("\n");
  }

  // Non-empty subsections only need the new bullet line.
  lines.splice(insertAt, 0, bullet);
  return lines.join("\n");
}
