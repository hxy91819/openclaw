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

changelog_file_hash() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

normalize_changelog_section_arg() {
  local section="$1"
  case "$section" in
    [Bb]reaking)
      printf 'breaking\n'
      ;;
    [Cc]hanges)
      printf 'changes\n'
      ;;
    [Ff]ixes)
      printf 'fixes\n'
      ;;
    *)
      echo "Unsupported changelog section: $section"
      exit 1
      ;;
  esac
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
  before_hash=$(changelog_file_hash CHANGELOG.md)

  local changelog_output
  local section_arg
  section_arg=$(normalize_changelog_section_arg "$section")
  changelog_output=$(node --import tsx scripts/changelog-add-unreleased.ts --section "$section_arg" "$entry")
  echo "$changelog_output"

  normalize_pr_changelog_entries "$pr"
  validate_changelog_merge_hygiene
  validate_changelog_entry_for_pr "$pr" "$contrib"

  local after_hash
  after_hash=$(changelog_file_hash CHANGELOG.md)
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

  # Non-interactive contexts (CI, pipe, or explicit opt-in) use the default entry
  if [ ! -t 0 ] || [ -n "${CI:-}" ] || [ "${OPENCLAW_MERGE_NONINTERACTIVE:-}" = "1" ]; then
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

normalize_pr_changelog_section() {
  local raw_section="${1:-Changes}"
  local normalized
  normalized=$(printf '%s' "$raw_section" | tr '[:upper:]' '[:lower:]')

  case "$normalized" in
    fixes|fix)
      printf '%s\n' "Fixes"
      ;;
    changes|change|enhancement|feature)
      printf '%s\n' "Changes"
      ;;
    *)
      echo "Unsupported changelog section override: $raw_section"
      exit 1
      ;;
  esac
}

resolve_pr_changelog_section() {
  local pr_json="$1"

  if [ -n "${OPENCLAW_PR_CHANGELOG_SECTION:-}" ]; then
    normalize_pr_changelog_section "$OPENCLAW_PR_CHANGELOG_SECTION"
    return 0
  fi

  local label_names
  label_names=$(printf '%s\n' "$pr_json" | jq -r '.labels[]?.name // empty' | tr '[:upper:]' '[:lower:]')

  if printf '%s\n' "$label_names" | rg -q '(^|[-_[:space:]])(bug|fix|bugfix|hotfix)([-_[:space:]]|$)'; then
    printf '%s\n' "Fixes"
    return 0
  fi

  if printf '%s\n' "$label_names" | rg -q '(^|[-_[:space:]])(feature|enhancement)([-_[:space:]]|$)'; then
    printf '%s\n' "Changes"
    return 0
  fi

  local pr_title_lower
  pr_title_lower=$(printf '%s\n' "$pr_json" | jq -r '.title // empty' | tr '[:upper:]' '[:lower:]')
  if [ -n "$pr_title_lower" ]; then
    if printf '%s\n' "$pr_title_lower" | rg -q '^(fix|bugfix|hotfix)([[:space:]]*[(:!])'; then
      printf '%s\n' "Fixes"
      return 0
    fi
    if printf '%s\n' "$pr_title_lower" | rg -q '^(feat|feature|enhance|enhancement)([[:space:]]*[(:!])'; then
      printf '%s\n' "Changes"
      return 0
    fi
  fi

  printf '%s\n' "Changes"
}

changelog_entry_for_pr_exists() {
  local pr="$1"

  [ -f CHANGELOG.md ] || return 1

  local pr_pattern
  pr_pattern="(#$pr|openclaw#$pr)"

  awk -v pr_pattern="$pr_pattern" '
function is_active_release(line) {
  return line ~ /^##[[:space:]]+(Unreleased|.+[[:space:]]+\(Unreleased\))[[:space:]]*$/
}
{
  if ($0 ~ /^## /) {
    current_release = $0
    current_section = ""
  } else if ($0 ~ /^### /) {
    current_section = $0
  }

  if ($0 ~ pr_pattern && is_active_release(current_release) && current_section != "") {
    found = 1
  }
}
END {
  exit found ? 0 : 1
}
' CHANGELOG.md
}

normalize_pr_changelog_entries() {
  local pr="$1"
  local changelog_path="CHANGELOG.md"

  [ -f "$changelog_path" ] || return 0

  local changelog_helper_root
  changelog_helper_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  local tsx_import
  tsx_import="$changelog_helper_root/node_modules/tsx/dist/esm/index.mjs"

  PR_NUMBER_FOR_CHANGELOG="$pr" OPENCLAW_CHANGELOG_HELPER_ROOT="$changelog_helper_root" node --import "$tsx_import" --input-type=module <<'EOF_NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const helperRoot = process.env.OPENCLAW_CHANGELOG_HELPER_ROOT;
if (!helperRoot) {
  throw new Error("Missing OPENCLAW_CHANGELOG_HELPER_ROOT.");
}
const helperUrl = pathToFileURL(`${helperRoot}/src/infra/changelog-unreleased.ts`).href;
const { normalizeUnreleasedChangelogPrEntry } = await import(helperUrl);

const prNumber = Number.parseInt(process.env.PR_NUMBER_FOR_CHANGELOG ?? "", 10);
if (!Number.isFinite(prNumber)) {
  throw new Error(`Invalid PR number for changelog normalization: ${process.env.PR_NUMBER_FOR_CHANGELOG ?? ""}`);
}

const path = "CHANGELOG.md";
const original = readFileSync(path, "utf8");
const updated = normalizeUnreleasedChangelogPrEntry(original, { prNumber });
if (updated !== original) {
  writeFileSync(path, updated);
}
EOF_NODE
}

validate_changelog_attribution_policy() {
  node scripts/check-changelog-attributions.mjs CHANGELOG.md
}

changelog_thanks_required_for_contributor() {
  local contrib="${1:-}"
  local normalized
  normalized=$(printf '%s' "$contrib" | tr '[:upper:]' '[:lower:]')

  case "$normalized" in
    ""|"null"|"app/"*|"codex"|"openclaw"|"clawsweeper"|"openclaw-clawsweeper"|"clawsweeper[bot]"|"openclaw-clawsweeper[bot]"|"steipete")
      return 1
      ;;
  esac

  return 0
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
  local diff
  diff=$(git diff --unified=0 "$diff_range" -- CHANGELOG.md 2>/dev/null || true)

  local added_lines
  added_lines=$(printf '%s\n' "$diff" | awk '
    /^\+\+\+/ { next }
    /^\+/ { print substr($0, 2) }
  ')

  if [ -n "$added_lines" ]; then
    local with_pr
    with_pr=$(printf '%s\n' "$added_lines" | rg -in "$pr_pattern" || true)
    if [ -z "$with_pr" ]; then
      echo "CHANGELOG.md update must reference PR #$pr (for example, (#$pr))."
      exit 1
    fi

    local diff_file
    diff_file=$(mktemp)
    printf '%s\n' "$diff" > "$diff_file"

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
      with_pr_and_thanks=$(printf '%s\n' "$added_lines" | rg -in "$pr_pattern" | awk -v contrib="$contrib" 'tolower($0) ~ tolower("@" contrib) && tolower($0) ~ "thanks" {print; found=1} END {exit !found}')
      if [ -z "$with_pr_and_thanks" ]; then
        echo "CHANGELOG.md update must include both PR #$pr and thanks @$contrib on the changelog entry line."
        exit 1
      fi
      echo "changelog validated: found PR #$pr + thanks @$contrib"
      return 0
    fi

    echo "changelog validated: found PR #$pr (contributor handle unavailable, skipping thanks check)"
    return 0
  fi

  local validation_output
  if ! validation_output=$(awk -v pr_pattern="$pr_pattern" '
function is_active_release(line) {
  heading = tolower(line)
  return heading ~ /^##[[:space:]]+(unreleased|.+[[:space:]]+\(unreleased\))[[:space:]]*$/
}
{
  if ($0 ~ /^## /) {
    current_release = $0
    current_section = ""
  } else if ($0 ~ /^### /) {
    current_section = $0
  }

  if ($0 ~ pr_pattern && is_active_release(current_release)) {
    pr_lines[++pr_count] = FNR
    pr_text[FNR] = $0
    pr_sections[FNR] = current_section
  }
}
END {
  if (pr_count == 0) {
    printf "CHANGELOG.md update must reference PR pattern %s under an Unreleased heading.\n", pr_pattern
    exit 1
  }

  for (idx = 1; idx <= pr_count; idx++) {
    entry_line = pr_lines[idx]
    if (pr_sections[entry_line] == "") {
      printf "CHANGELOG.md entry must be inside a subsection (### ...): line %d: %s\n", entry_line, pr_text[entry_line]
      issue_count++
    }
  }

  if (issue_count > 0) {
    exit 1
  }

  print "changelog placement validated: PR-linked entry exists under the active Unreleased section in a subsection"
}
' CHANGELOG.md); then
    printf '%s\n' "$validation_output"
    exit 1
  fi
  printf '%s\n' "$validation_output"

  if changelog_thanks_required_for_contributor "$contrib"; then
    local with_pr_and_thanks
    with_pr_and_thanks=$(awk -v pr_pattern="$pr_pattern" '
function is_active_release(line) {
  heading = tolower(line)
  return heading ~ /^##[[:space:]]+(unreleased|.+[[:space:]]+\(unreleased\))[[:space:]]*$/
}
/^## / { current_release = $0 }
is_active_release(current_release) && $0 ~ pr_pattern { print }
' CHANGELOG.md | awk -v contrib="$contrib" 'tolower($0) ~ tolower("@" contrib) && tolower($0) ~ "thanks" {print; found=1} END {exit !found}' || true)
    if [ -z "$with_pr_and_thanks" ]; then
      echo "CHANGELOG.md update must include both PR #$pr and thanks @$contrib on the changelog entry line."
      exit 1
    fi
    echo "changelog validated: found PR #$pr + thanks @$contrib"
    return 0
  fi

  echo "changelog validated: found PR #$pr (no eligible human contributor handle, skipping thanks check)"
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
