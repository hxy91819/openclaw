build_default_pr_changelog_entry() {
  local pr="$1"
  local contrib="$2"
  local title="$3"

  local trimmed_title
  trimmed_title=$(printf '%s' "$title" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -z "$trimmed_title" ]; then
    echo "Cannot build changelog entry: missing PR title."
    exit 1
  fi

  if [ -n "$contrib" ] && [ "$contrib" != "null" ]; then
    printf '%s (#%s). Thanks @%s\n' "$trimmed_title" "$pr" "$contrib"
    return 0
  fi

  printf '%s (#%s).\n' "$trimmed_title" "$pr"
}

ensure_pr_changelog_entry() {
  local pr="$1"
  local contrib="$2"
  local title="$3"
  local section="${4:-Changes}"
  local explicit_entry="${5:-}"

  [ -f CHANGELOG.md ] || {
    echo "CHANGELOG.md is missing."
    exit 1
  }

  local entry
  if [ -n "$explicit_entry" ]; then
    entry="$explicit_entry"
  else
    entry=$(build_default_pr_changelog_entry "$pr" "$contrib" "$title")
  fi
  local before_hash
  before_hash=$(sha256sum CHANGELOG.md | awk '{print $1}')

  local changelog_output
  changelog_output=$(bun scripts/changelog-add-unreleased.ts --section "${section,,}" "$entry")
  echo "$changelog_output"

  normalize_pr_changelog_entries "$pr"
  validate_changelog_merge_hygiene
  validate_changelog_entry_for_pr "$pr" "$contrib"

  local after_hash
  after_hash=$(sha256sum CHANGELOG.md | awk '{print $1}')
  if [ "$before_hash" = "$after_hash" ]; then
    echo "pr_changelog_changed=false"
  else
    echo "pr_changelog_changed=true"
  fi
}

resolve_pr_changelog_entry() {
  local pr="$1"
  local contrib="$2"
  local title="$3"

  local default_entry
  default_entry=$(build_default_pr_changelog_entry "$pr" "$contrib" "$title")

  if [ -n "${OPENCLAW_PR_CHANGELOG_ENTRY:-}" ]; then
    printf '%s\n' "$OPENCLAW_PR_CHANGELOG_ENTRY"
    return 0
  fi

  if [ ! -t 0 ]; then
    printf '%s\n' "$default_entry"
    return 0
  fi

  echo "Default changelog entry:"
  echo "  $default_entry"
  echo "Press Enter to accept, or paste a replacement single-line entry."

  local answer
  read -r answer
  if [ -n "$answer" ]; then
    printf '%s\n' "$answer"
    return 0
  fi

  printf '%s\n' "$default_entry"
}

normalize_pr_changelog_entries() {
  local pr="$1"
  local changelog_path="CHANGELOG.md"

  [ -f "$changelog_path" ] || return 0

  PR_NUMBER_FOR_CHANGELOG="$pr" node <<'EOF_NODE'
const fs = require("node:fs");

const pr = process.env.PR_NUMBER_FOR_CHANGELOG;
const path = "CHANGELOG.md";
const original = fs.readFileSync(path, "utf8");
const lines = original.split("\n");
const prPattern = new RegExp(`(?:\\(#${pr}\\)|openclaw#${pr})`, "i");

function findActiveSectionIndex(arr) {
  const versionUnreleasedIndex = arr.findIndex((line) =>
    /^##\s+.+\(\s*unreleased\s*\)\s*$/i.test(line.trim()),
  );
  if (versionUnreleasedIndex !== -1) {
    return versionUnreleasedIndex;
  }
  return arr.findIndex((line) => line.trim().toLowerCase() === "## unreleased");
}

function findSectionEnd(arr, start) {
  for (let i = start + 1; i < arr.length; i += 1) {
    if (/^## /.test(arr[i])) {
      return i;
    }
  }
  return arr.length;
}

function ensureActiveSection(arr) {
  let activeIndex = findActiveSectionIndex(arr);
  if (activeIndex !== -1) {
    return activeIndex;
  }

  let insertAt = arr.findIndex((line, idx) => idx > 0 && /^## /.test(line));
  if (insertAt === -1) {
    insertAt = arr.length;
  }

  const block = ["## Unreleased", "", "### Changes", ""];
  if (insertAt > 0 && arr[insertAt - 1] !== "") {
    block.unshift("");
  }
  arr.splice(insertAt, 0, ...block);
  return findActiveSectionIndex(arr);
}

function contextFor(arr, index) {
  let major = "";
  let minor = "";
  for (let i = index; i >= 0; i -= 1) {
    const line = arr[i];
    if (!minor && /^### /.test(line)) {
      minor = line.trim();
    }
    if (/^## /.test(line)) {
      major = line.trim();
      break;
    }
  }
  return { major, minor };
}

function ensureSubsection(arr, subsection) {
  const activeIndex = ensureActiveSection(arr);
  const activeEnd = findSectionEnd(arr, activeIndex);
  const desired = subsection && /^### /.test(subsection) ? subsection : "### Changes";
  for (let i = activeIndex + 1; i < activeEnd; i += 1) {
    if (arr[i].trim() === desired) {
      return i;
    }
  }

  let insertAt = activeEnd;
  while (insertAt > activeIndex + 1 && arr[insertAt - 1] === "") {
    insertAt -= 1;
  }
  const block = ["", desired, ""];
  arr.splice(insertAt, 0, ...block);
  return insertAt + 1;
}

function sectionTailInsertIndex(arr, subsectionIndex) {
  let nextHeading = arr.length;
  for (let i = subsectionIndex + 1; i < arr.length; i += 1) {
    if (/^### /.test(arr[i]) || /^## /.test(arr[i])) {
      nextHeading = i;
      break;
    }
  }

  let insertAt = nextHeading;
  while (insertAt > subsectionIndex + 1 && arr[insertAt - 1] === "") {
    insertAt -= 1;
  }
  return insertAt;
}

const activeHeading = lines[ensureActiveSection(lines)]?.trim() || "## Unreleased";

function extractPrNumberFromLine(line) {
  // Align with the TS helper: use only the first PR reference as the sort key.
  const match = line.match(/(?:\(#(\d+)\)|openclaw#(\d+))/i);
  const raw = match && (match[1] || match[2]);
  if (!raw) {
    return undefined;
  }
  const num = Number.parseInt(raw, 10);
  return Number.isFinite(num) ? num : undefined;
}

function orderedInsertIndex(arr, subsectionIndex, nextHeading, newPr) {
  // Entries without a PR reference keep the previous tail-insert behavior.
  if (newPr === undefined) {
    return sectionTailInsertIndex(arr, subsectionIndex);
  }
  for (let i = subsectionIndex + 1; i < nextHeading; i += 1) {
    const line = arr[i];
    if (!/^- /.test(line)) {
      continue;
    }
    const existing = extractPrNumberFromLine(line);
    if (existing === undefined) {
      continue;
    }
    if (existing > newPr) {
      return i;
    }
  }
  return sectionTailInsertIndex(arr, subsectionIndex);
}

const moved = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!prPattern.test(lines[i])) {
    continue;
  }
  const ctx = contextFor(lines, i);
  if (ctx.major === activeHeading) {
    continue;
  }
  moved.push({
    line: lines[i],
    subsection: ctx.minor || "### Changes",
    index: i,
  });
}

if (moved.length === 0) {
  process.exit(0);
}

const removeIndexes = new Set(moved.map((entry) => entry.index));
const nextLines = lines.filter((_, idx) => !removeIndexes.has(idx));

for (const entry of moved) {
  const subsectionIndex = ensureSubsection(nextLines, entry.subsection);

  let nextHeading = nextLines.length;
  for (let i = subsectionIndex + 1; i < nextLines.length; i += 1) {
    if (/^### /.test(nextLines[i]) || /^## /.test(nextLines[i])) {
      nextHeading = i;
      break;
    }
  }

  const alreadyPresent = nextLines
    .slice(subsectionIndex + 1, nextHeading)
    .some((line) => line === entry.line);
  if (alreadyPresent) {
    continue;
  }

  const newPr = extractPrNumberFromLine(entry.line);
  const insertAt = orderedInsertIndex(nextLines, subsectionIndex, nextHeading, newPr);
  nextLines.splice(insertAt, 0, entry.line);
}

const updated = nextLines.join("\n");
if (updated !== original) {
  fs.writeFileSync(path, updated);
}
EOF_NODE
}

resolve_changelog_diff_range() {
  local env_file
  for env_file in .local/prep.env .local/prep-context.env; do
    [ -s "$env_file" ] || continue

    local candidate
    candidate=$(
      (
        set +u
        # shellcheck disable=SC1090
        source "$env_file" >/dev/null 2>&1 || exit 0
        printf '%s' "${PR_HEAD_SHA_BEFORE:-}"
      )
    )

    if [ -n "$candidate" ] \
      && git cat-file -e "${candidate}^{commit}" 2>/dev/null \
      && git merge-base --is-ancestor "$candidate" HEAD 2>/dev/null; then
      printf '%s\n' "${candidate}..HEAD"
      return 0
    fi
  done

  printf '%s\n' 'origin/main...HEAD'
}

validate_changelog_entry_for_pr() {
  local pr="$1"
  local contrib="$2"

  local diff_range
  diff_range=$(resolve_changelog_diff_range)

  local pr_pattern
  pr_pattern="(#$pr|openclaw#$pr)"

  # Validate only the changed PR entry shape. PR-number ordering is an insertion
  # strategy, not a historical invariant for the whole section.
  local added_lines
  added_lines=$(git diff --unified=0 "$diff_range" -- CHANGELOG.md | awk '
    /^\+\+\+/ { next }
    /^\+/ { print substr($0, 2) }
  ')

  if [ -z "$added_lines" ]; then
    echo "CHANGELOG.md is in diff but no added lines were detected."
    exit 1
  fi

  local with_pr
  with_pr=$(printf '%s\n' "$added_lines" | rg -in "$pr_pattern" || true)
  if [ -z "$with_pr" ]; then
    echo "CHANGELOG.md update must reference PR #$pr (for example, (#$pr))."
    exit 1
  fi

  local diff_file
  diff_file=$(mktemp)
  git diff --unified=0 "$diff_range" -- CHANGELOG.md > "$diff_file"

  if ! awk -v pr_pattern="$pr_pattern" '
BEGIN {
  line_no = 0
  file_line_count = 0
  issue_count = 0
  pr_count = 0
}
FNR == NR {
  if ($0 ~ /^@@ /) {
    if (match($0, /\+[0-9]+/)) {
      line_no = substr($0, RSTART + 1, RLENGTH - 1) + 0
    } else {
      line_no = 0
    }
    next
  }
  if ($0 ~ /^\+\+\+/) {
    next
  }
  if ($0 ~ /^\+/) {
    if (line_no > 0) {
      added[line_no] = 1
      added_text = substr($0, 2)
      if (added_text ~ pr_pattern) {
        pr_added_lines[++pr_added_count] = line_no
        pr_added_text[line_no] = added_text
      }
      line_no++
    }
    next
  }
  if ($0 ~ /^-/) {
    next
  }
  if (line_no > 0) {
    line_no++
  }
  next
}
{
  changelog[FNR] = $0
  file_line_count = FNR
}
END {
  active_release_line = 0
  bare_release_line = 0
  active_release_name = "unreleased"
  for (i = 1; i <= file_line_count; i++) {
    if (changelog[i] !~ /^## /) {
      continue
    }
    heading = tolower(changelog[i])
    if (heading ~ /^##[[:space:]]+.+\([[:space:]]*unreleased[[:space:]]*\)[[:space:]]*$/) {
      active_release_line = i
      active_release_name = changelog[i]
      break
    }
    if (heading == "## unreleased" && bare_release_line == 0) {
      bare_release_line = i
    }
  }
  if (active_release_line == 0 && bare_release_line != 0) {
    active_release_line = bare_release_line
    active_release_name = changelog[bare_release_line]
  }

  for (idx = 1; idx <= pr_added_count; idx++) {
    entry_line = pr_added_lines[idx]
    release_line = 0
    section_line = 0
    for (i = entry_line; i >= 1; i--) {
      if (section_line == 0 && changelog[i] ~ /^### /) {
        section_line = i
        continue
      }
      if (changelog[i] ~ /^## /) {
        release_line = i
        break
      }
    }
    if (release_line == 0 || release_line != active_release_line) {
      printf "CHANGELOG.md PR-linked entry must be in %s: line %d: %s\n", active_release_name, entry_line, pr_added_text[entry_line]
      issue_count++
      continue
    }
    if (section_line == 0) {
      printf "CHANGELOG.md entry must be inside a subsection (### ...): line %d: %s\n", entry_line, pr_added_text[entry_line]
      issue_count++
    }
  }

  if (issue_count > 0) {
    exit 1
  }
}
' "$diff_file" CHANGELOG.md; then
    rm -f "$diff_file"
    exit 1
  fi
  rm -f "$diff_file"
  echo "changelog placement validated: PR-linked entry exists under the active Unreleased section in a subsection"

  if [ -n "$contrib" ] && [ "$contrib" != "null" ]; then
    local with_pr_and_thanks
    with_pr_and_thanks=$(printf '%s\n' "$added_lines" | rg -in "$pr_pattern" | rg -i "thanks @$contrib" || true)
    if [ -z "$with_pr_and_thanks" ]; then
      echo "CHANGELOG.md update must include both PR #$pr and thanks @$contrib on the changelog entry line."
      exit 1
    fi
    echo "changelog validated: found PR #$pr + thanks @$contrib"
    return 0
  fi

  echo "changelog validated: found PR #$pr (contributor handle unavailable, skipping thanks check)"
}

validate_changelog_merge_hygiene() {
  local diff_range
  diff_range=$(resolve_changelog_diff_range)

  local diff
  diff=$(git diff --unified=0 "$diff_range" -- CHANGELOG.md)

  local removed_lines
  removed_lines=$(printf '%s\n' "$diff" | awk '
    /^---/ { next }
    /^-/ { print substr($0, 2) }
  ')
  if [ -z "$removed_lines" ]; then
    return 0
  fi

  local removed_refs
  removed_refs=$(printf '%s\n' "$removed_lines" | rg -o '#[0-9]+' | sort -u || true)
  if [ -z "$removed_refs" ]; then
    return 0
  fi

  local added_lines
  added_lines=$(printf '%s\n' "$diff" | awk '
    /^\+\+\+/ { next }
    /^\+/ { print substr($0, 2) }
  ')

  local ref
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    if ! printf '%s\n' "$added_lines" | rg -q -F "$ref"; then
      echo "CHANGELOG.md drops existing entry reference $ref without re-adding it."
      echo "Likely merge conflict loss; restore the dropped entry (or keep the same PR ref in rewritten text)."
      exit 1
    fi
  done <<<"$removed_refs"

  echo "changelog merge hygiene validated: no dropped PR references"
}
