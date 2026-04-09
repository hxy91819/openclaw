package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Tool definition:
// - Validates localized docs output against the English source tree after docs-i18n runs.
// - Designed for full-site preflight checks before publish or rollout; also supports targeted files.
// - Fails closed on structural drift such as missing files, malformed frontmatter, tag imbalance,
//   or mismatched component/code-fence counts. English residue and suspicious size deltas are warnings.
//
// Parameter definition:
// - --source-root <path>: English docs root. Required. Example: /data/tmp/docs-i18n-sample/site
// - --translated-root <path>: Localized docs root. Required. Example: /data/tmp/docs-i18n-sample/site/zh-CN
// - --lang <locale>: Target locale label for reports. Default: zh-CN
// - --report-json <path>: Optional JSON report path. Default: ./translated-docs-report.json
// - --summary-md <path>: Optional Markdown summary path. Default: ./translated-docs-summary.md
// - --file <relpath>: Optional relative file to validate. Repeatable. When omitted, validates all source docs.
//
// Output definition:
// - Writes a machine-readable JSON report and a human-readable Markdown summary.
// - Prints a short stdout summary with fail/warn/pass counts and output paths.
// - Exit codes:
//   - 0: validation completed with no fail findings
//   - 1: validation completed and found fail findings
//   - 2: usage or runtime error

const (
	exitOK      = 0
	exitFail    = 1
	exitRuntime = 2
)

var (
	localeDirRe      = regexp.MustCompile(`^[a-z]{2}(?:-[A-Z]{2})?$`)
	asciiWordRe      = regexp.MustCompile(`[A-Za-z]{3,}`)
	translatableTags = []string{
		"Accordion",
		"AccordionGroup",
		"Card",
		"CardGroup",
		"CodeGroup",
		"Columns",
		"Check",
		"Info",
		"Note",
		"Step",
		"Steps",
		"Tab",
		"Tabs",
		"Tip",
		"Warning",
	}
)

type stringListFlag []string

func (f *stringListFlag) String() string {
	return strings.Join(*f, ",")
}

func (f *stringListFlag) Set(value string) error {
	*f = append(*f, value)
	return nil
}

type report struct {
	GeneratedAt    string       `json:"generated_at"`
	SourceRoot     string       `json:"source_root"`
	TranslatedRoot string       `json:"translated_root"`
	Lang           string       `json:"lang"`
	FilesChecked   int          `json:"files_checked"`
	FailCount      int          `json:"fail_count"`
	WarnCount      int          `json:"warn_count"`
	PassCount      int          `json:"pass_count"`
	Files          []fileResult `json:"files"`
}

type fileResult struct {
	RelPath   string    `json:"rel_path"`
	Source    fileStats `json:"source"`
	Target    fileStats `json:"target"`
	Findings  []finding `json:"findings"`
	FailCount int       `json:"fail_count"`
	WarnCount int       `json:"warn_count"`
	Status    string    `json:"status"`
}

type fileStats struct {
	Bytes        int               `json:"bytes"`
	Lines        int               `json:"lines"`
	FenceCount   int               `json:"fence_count"`
	HasFront     bool              `json:"has_frontmatter"`
	HasXI18N     bool              `json:"has_x_i18n"`
	TagOpenClose map[string][2]int `json:"tag_open_close"`
}

type finding struct {
	Level   string `json:"level"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func usage() {
	fmt.Fprintf(os.Stdout, `Usage:
  cd scripts/docs-i18n && go run ./cmd/validate-translated-docs --source-root <path> --translated-root <path> [options]

Description:
  Validate translated docs output against English source docs before rollout.
  This command checks structural parity, frontmatter, fenced code blocks, and
  suspicious untranslated English residue. It is intended for full-site or
  representative-sample preflight validation after docs-i18n completes.

Outputs:
  - JSON report: machine-readable validation results
  - Markdown summary: human-readable fail/warn overview
  - Stdout summary with fail/warn/pass counts
  - Exit 0 on no fail findings, 1 on fail findings, 2 on usage/runtime errors

Options:
  --source-root <path>       English docs root to compare from
  --translated-root <path>   Localized docs root to compare to
  --lang <locale>            Locale label for reports (default: zh-CN)
  --report-json <path>       JSON report path (default: ./translated-docs-report.json)
  --summary-md <path>        Markdown summary path (default: ./translated-docs-summary.md)
  --file <relpath>           Relative file to validate; repeatable
  -h, --help                 Show this help

Examples:
  cd scripts/docs-i18n && go run ./cmd/validate-translated-docs \
    --source-root /data/tmp/docs-i18n-sample/site \
    --translated-root /data/tmp/docs-i18n-sample/site/zh-CN \
    --lang zh-CN

  cd scripts/docs-i18n && go run ./cmd/validate-translated-docs \
    --source-root /data/tmp/docs-i18n-sample/site \
    --translated-root /data/tmp/docs-i18n-sample/site/zh-CN \
    --file index.md \
    --file plugins/sdk-provider-plugins.md
`)
}

func main() {
	var (
		sourceRoot     = flag.String("source-root", "", "English docs root")
		translatedRoot = flag.String("translated-root", "", "Localized docs root")
		lang           = flag.String("lang", "zh-CN", "Locale label for reports")
		reportJSON     = flag.String("report-json", "translated-docs-report.json", "JSON report output path")
		summaryMD      = flag.String("summary-md", "translated-docs-summary.md", "Markdown summary output path")
		files          stringListFlag
	)
	flag.Var(&files, "file", "relative file to validate; repeatable")
	flag.Usage = usage
	flag.Parse()

	if *sourceRoot == "" || *translatedRoot == "" {
		usage()
		os.Exit(exitRuntime)
	}

	if err := run(*sourceRoot, *translatedRoot, *lang, *reportJSON, *summaryMD, files); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(exitRuntime)
	}
}

func run(sourceRoot, translatedRoot, lang, reportJSON, summaryMD string, files []string) error {
	sourceRootAbs, err := filepath.Abs(sourceRoot)
	if err != nil {
		return err
	}
	translatedRootAbs, err := filepath.Abs(translatedRoot)
	if err != nil {
		return err
	}
	if sourceRootAbs == translatedRootAbs {
		return errors.New("source-root and translated-root must be different paths")
	}

	relPaths, err := collectSourceFiles(sourceRootAbs, files)
	if err != nil {
		return err
	}
	if len(relPaths) == 0 {
		return errors.New("no source files found")
	}

	rep := report{
		GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
		SourceRoot:     sourceRootAbs,
		TranslatedRoot: translatedRootAbs,
		Lang:           lang,
		Files:          make([]fileResult, 0, len(relPaths)),
	}

	for _, relPath := range relPaths {
		result, err := validateFile(sourceRootAbs, translatedRootAbs, relPath)
		if err != nil {
			return err
		}
		rep.Files = append(rep.Files, result)
		rep.FilesChecked++
		rep.FailCount += result.FailCount
		rep.WarnCount += result.WarnCount
		switch result.Status {
		case "pass":
			rep.PassCount++
		}
	}

	sort.Slice(rep.Files, func(i, j int) bool {
		if rep.Files[i].FailCount != rep.Files[j].FailCount {
			return rep.Files[i].FailCount > rep.Files[j].FailCount
		}
		if rep.Files[i].WarnCount != rep.Files[j].WarnCount {
			return rep.Files[i].WarnCount > rep.Files[j].WarnCount
		}
		return rep.Files[i].RelPath < rep.Files[j].RelPath
	})

	if err := writeJSON(reportJSON, rep); err != nil {
		return err
	}
	if err := writeSummary(summaryMD, rep); err != nil {
		return err
	}

	fmt.Fprintf(os.Stdout, "validated files=%d fail=%d warn=%d pass=%d\n", rep.FilesChecked, rep.FailCount, rep.WarnCount, rep.PassCount)
	fmt.Fprintf(os.Stdout, "json=%s\n", reportJSON)
	fmt.Fprintf(os.Stdout, "summary=%s\n", summaryMD)

	if rep.FailCount > 0 {
		os.Exit(exitFail)
	}
	return nil
}

func collectSourceFiles(sourceRoot string, files []string) ([]string, error) {
	if len(files) > 0 {
		out := make([]string, 0, len(files))
		for _, rel := range files {
			normalized := filepath.Clean(filepath.ToSlash(rel))
			if normalized == "." || strings.HasPrefix(normalized, "../") {
				return nil, fmt.Errorf("invalid --file value: %s", rel)
			}
			full := filepath.Join(sourceRoot, filepath.FromSlash(normalized))
			info, err := os.Stat(full)
			if err != nil {
				return nil, fmt.Errorf("source file missing: %s", normalized)
			}
			if info.IsDir() {
				return nil, fmt.Errorf("--file points to directory: %s", normalized)
			}
			out = append(out, normalized)
		}
		sort.Strings(out)
		return out, nil
	}

	out := []string{}
	err := filepath.WalkDir(sourceRoot, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path == sourceRoot {
				return nil
			}
			rel, relErr := filepath.Rel(sourceRoot, path)
			if relErr != nil {
				return relErr
			}
			rel = filepath.ToSlash(rel)
			if !strings.Contains(rel, "/") && localeDirRe.MatchString(rel) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".md") && !strings.HasSuffix(path, ".mdx") {
			return nil
		}
		rel, relErr := filepath.Rel(sourceRoot, path)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		if strings.Contains(rel, "/") {
			first := strings.SplitN(rel, "/", 2)[0]
			if localeDirRe.MatchString(first) {
				return nil
			}
		}
		out = append(out, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

func validateFile(sourceRoot, translatedRoot, relPath string) (fileResult, error) {
	sourcePath := filepath.Join(sourceRoot, filepath.FromSlash(relPath))
	targetPath := filepath.Join(translatedRoot, filepath.FromSlash(relPath))

	result := fileResult{RelPath: relPath, Findings: []finding{}}

	sourceBytes, err := os.ReadFile(sourcePath)
	if err != nil {
		return result, err
	}
	sourceText := string(sourceBytes)
	result.Source = collectStats(sourceText)

	targetBytes, err := os.ReadFile(targetPath)
	if err != nil {
		addFinding(&result, "fail", "missing_target", fmt.Sprintf("missing translated file: %s", relPath))
		result.Status = "fail"
		return result, nil
	}
	targetText := string(targetBytes)
	result.Target = collectStats(targetText)

	checkFrontmatter(&result)
	checkTagParity(&result)
	checkFenceParity(&result)
	checkSuspiciousShrink(&result)
	checkEnglishResidue(&result, targetText)

	switch {
	case result.FailCount > 0:
		result.Status = "fail"
	case result.WarnCount > 0:
		result.Status = "warn"
	default:
		result.Status = "pass"
	}
	return result, nil
}

func collectStats(text string) fileStats {
	stats := fileStats{
		Bytes:        len(text),
		Lines:        countLines(text),
		FenceCount:   strings.Count(text, "```"),
		HasFront:     hasFrontmatter(text),
		HasXI18N:     strings.Contains(text, "\nx-i18n:") || strings.HasPrefix(text, "x-i18n:"),
		TagOpenClose: map[string][2]int{},
	}
	for _, tag := range translatableTags {
		stats.TagOpenClose[tag] = [2]int{
			countOpeningTags(text, tag),
			strings.Count(text, "</"+tag+">"),
		}
	}
	return stats
}

func checkFrontmatter(result *fileResult) {
	if result.Source.HasFront != result.Target.HasFront {
		addFinding(result, "fail", "frontmatter_mismatch", "frontmatter presence differs from source")
	}
	if result.Source.HasFront && !result.Target.HasXI18N {
		addFinding(result, "warn", "missing_x_i18n", "translated frontmatter is missing x-i18n metadata")
	}
}

func checkTagParity(result *fileResult) {
	for _, tag := range translatableTags {
		sourcePair := result.Source.TagOpenClose[tag]
		targetPair := result.Target.TagOpenClose[tag]
		if sourcePair != targetPair {
			addFinding(result, "fail", "tag_count_mismatch", fmt.Sprintf("%s count mismatch: source open/close=%d/%d target open/close=%d/%d", tag, sourcePair[0], sourcePair[1], targetPair[0], targetPair[1]))
		}
		if targetPair[0] != targetPair[1] {
			addFinding(result, "fail", "tag_unbalanced", fmt.Sprintf("%s open/close mismatch inside translated file: %d/%d", tag, targetPair[0], targetPair[1]))
		}
	}
}

func checkFenceParity(result *fileResult) {
	if result.Source.FenceCount != result.Target.FenceCount {
		addFinding(result, "fail", "code_fence_mismatch", fmt.Sprintf("code fence count mismatch: source=%d target=%d", result.Source.FenceCount, result.Target.FenceCount))
	}
}

func checkSuspiciousShrink(result *fileResult) {
	if result.Source.Bytes < 800 {
		return
	}
	if result.Target.Bytes*100 < result.Source.Bytes*55 {
		addFinding(result, "warn", "suspicious_shrink", fmt.Sprintf("translated bytes unexpectedly small: source=%d target=%d", result.Source.Bytes, result.Target.Bytes))
	}
	if result.Target.Lines*100 < result.Source.Lines*60 {
		addFinding(result, "warn", "suspicious_line_drop", fmt.Sprintf("translated line count unexpectedly small: source=%d target=%d", result.Source.Lines, result.Target.Lines))
	}
}

func checkEnglishResidue(result *fileResult, text string) {
	lines := splitLintLines(text)
	hits := make([]string, 0, 4)
	inFence := false
	inFrontmatter := false
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		switch {
		case index == 0 && trimmed == "---":
			inFrontmatter = true
			continue
		case inFrontmatter && trimmed == "---":
			inFrontmatter = false
			continue
		case strings.HasPrefix(trimmed, "```"):
			inFence = !inFence
			continue
		}
		if inFence || inFrontmatter || trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "<") || strings.HasPrefix(trimmed, ">") {
			continue
		}
		if looksLikeResidualEnglish(trimmed) {
			hits = append(hits, fmt.Sprintf("line %d: %s", index+1, trimmed))
			if len(hits) >= 3 {
				break
			}
		}
	}
	if len(hits) > 0 {
		addFinding(result, "warn", "english_residue", "suspicious untranslated English: "+strings.Join(hits, " | "))
	}
}

func looksLikeResidualEnglish(line string) bool {
	if strings.Contains(line, "```") {
		return false
	}
	lower := strings.ToLower(line)
	for _, marker := range []string{"src=", "href=", "class=", "width=", "height=", "alt=", "icon="} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	if strings.HasPrefix(line, "|") {
		return true
	}
	words := asciiWordRe.FindAllString(line, -1)
	if len(words) < 3 {
		return false
	}
	letters := 0
	nonASCII := 0
	for _, word := range words {
		letters += len(word)
	}
	for _, r := range line {
		if r > 127 {
			nonASCII++
		}
	}
	if letters < 12 {
		return false
	}
	if nonASCII > letters {
		return false
	}
	return true
}

func splitLintLines(text string) []string {
	return strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
}

func hasFrontmatter(text string) bool {
	return strings.HasPrefix(text, "---\n")
}

func countLines(text string) int {
	if text == "" {
		return 0
	}
	return strings.Count(text, "\n") + 1
}

func countOpeningTags(text, tagName string) int {
	count := 0
	search := text
	openPrefix := "<" + tagName
	closePrefix := "</" + tagName
	for {
		index := strings.Index(search, openPrefix)
		if index == -1 {
			return count
		}
		fragment := search[index:]
		if strings.HasPrefix(fragment, closePrefix) {
			search = fragment[len(closePrefix):]
			continue
		}
		if len(fragment) > len(openPrefix) {
			next := fragment[len(openPrefix)]
			if !isTagBoundary(next) {
				search = fragment[len(openPrefix):]
				continue
			}
		}
		endIndex := strings.Index(fragment, ">")
		if endIndex == -1 {
			count++
			return count
		}
		count++
		if strings.HasSuffix(strings.TrimSpace(fragment[:endIndex+1]), "/>") {
			count--
		}
		search = fragment[endIndex+1:]
	}
}

func isTagBoundary(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r', '>', '/':
		return true
	default:
		return false
	}
}

func addFinding(result *fileResult, level, code, message string) {
	result.Findings = append(result.Findings, finding{
		Level:   level,
		Code:    code,
		Message: message,
	})
	switch level {
	case "fail":
		result.FailCount++
	case "warn":
		result.WarnCount++
	}
}

func writeJSON(path string, rep report) error {
	data, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func writeSummary(path string, rep report) error {
	var out strings.Builder
	out.WriteString("# Translated Docs Validation Summary\n\n")
	out.WriteString(fmt.Sprintf("- Generated at: `%s`\n", rep.GeneratedAt))
	out.WriteString(fmt.Sprintf("- Locale: `%s`\n", rep.Lang))
	out.WriteString(fmt.Sprintf("- Files checked: `%d`\n", rep.FilesChecked))
	out.WriteString(fmt.Sprintf("- Fail findings: `%d`\n", rep.FailCount))
	out.WriteString(fmt.Sprintf("- Warn findings: `%d`\n", rep.WarnCount))
	out.WriteString(fmt.Sprintf("- Pass files: `%d`\n\n", rep.PassCount))

	for _, status := range []string{"fail", "warn", "pass"} {
		title := strings.ToUpper(status[:1]) + status[1:]
		out.WriteString("## " + title + "\n\n")
		matched := 0
		for _, file := range rep.Files {
			if file.Status != status {
				continue
			}
			matched++
			out.WriteString(fmt.Sprintf("- `%s`", file.RelPath))
			if len(file.Findings) > 0 {
				out.WriteString(": ")
				summaries := make([]string, 0, len(file.Findings))
				for _, finding := range file.Findings {
					summaries = append(summaries, fmt.Sprintf("[%s] %s", finding.Code, finding.Message))
				}
				out.WriteString(strings.Join(summaries, "; "))
			}
			out.WriteString("\n")
		}
		if matched == 0 {
			out.WriteString("- none\n")
		}
		out.WriteString("\n")
	}
	return os.WriteFile(path, []byte(out.String()), 0o644)
}
