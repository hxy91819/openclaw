package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseTaggedDocumentRejectsMissingBodyCloseAtEOF(t *testing.T) {
	t.Parallel()

	input := "<frontmatter>\ntitle: Test\n</frontmatter>\n<body>\nTranslated body\n"

	_, _, err := parseTaggedDocument(input)
	if err == nil {
		t.Fatal("expected error for missing closing </body> tag")
	}
}

func TestParseTaggedDocumentRejectsTrailingTextOutsideTags(t *testing.T) {
	t.Parallel()

	input := "<frontmatter>\ntitle: Test\n</frontmatter>\n<body>\nTranslated body\n</body>\nextra"

	_, _, err := parseTaggedDocument(input)
	if err == nil {
		t.Fatal("expected error for trailing text")
	}
}

func TestParseTaggedDocumentRejectsTruncatedAccordionBody(t *testing.T) {
	t.Parallel()

	input := strings.Join([]string{
		"<frontmatter>",
		"title: FAQ",
		"</frontmatter>",
		"<body>",
		"<AccordionGroup>",
		`  <Accordion title="What does this mean?">`,
		"    This translation was truncated mid-block.",
		"",
	}, "\n")

	_, _, err := parseTaggedDocument(input)
	if err == nil {
		t.Fatal("expected error for truncated tagged output")
	}
}

type sizeLimitedDocTranslator struct {
	maxBodyBytes   int
	maxSeen        int
	rawCalls       int
	translateCalls int
}

func (t *sizeLimitedDocTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	t.translateCalls++
	return text, nil
}

func (t *sizeLimitedDocTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	t.rawCalls++
	size := len(text)
	if _, body, err := parseTaggedDocument(text); err == nil {
		size = len(body)
	}
	if size > t.maxSeen {
		t.maxSeen = size
	}
	if size > t.maxBodyBytes {
		return "", context.DeadlineExceeded
	}
	return text, nil
}

func (t *sizeLimitedDocTranslator) Close() {}

func TestProcessFileDocChunksLongAccordionGroups(t *testing.T) {
	t.Parallel()

	docsRoot := t.TempDir()
	longA := strings.Repeat("Alpha sentence about Gateway and providers. ", 180)
	longB := strings.Repeat("Beta sentence about troubleshooting and auth. ", 180)
	source := strings.Join([]string{
		"---",
		"title: FAQ",
		"summary: Common answers",
		"---",
		"",
		"# FAQ",
		"",
		"<AccordionGroup>",
		`  <Accordion title="First question">`,
		"    " + longA,
		"  </Accordion>",
		"",
		`  <Accordion title="Second question">`,
		"    " + longB,
		"  </Accordion>",
		"</AccordionGroup>",
		"",
	}, "\n")

	sourcePath := filepath.Join(docsRoot, "help", "faq.md")
	if err := os.MkdirAll(filepath.Dir(sourcePath), 0o755); err != nil {
		t.Fatalf("mkdir source dir: %v", err)
	}
	if err := os.WriteFile(sourcePath, []byte(source), 0o644); err != nil {
		t.Fatalf("write source doc: %v", err)
	}

	translator := &sizeLimitedDocTranslator{maxBodyBytes: 12000}
	_, outputPath, err := processFileDoc(context.Background(), translator, docsRoot, sourcePath, "en", "zh-CN", true)
	if err != nil {
		t.Fatalf("processFileDoc returned error: %v", err)
	}
	if translator.rawCalls == 0 {
		t.Fatal("expected structured batching to use TranslateRaw")
	}
	if translator.maxSeen > translator.maxBodyBytes {
		t.Fatalf("expected chunking to stay under byte limit; saw %d > %d", translator.maxSeen, translator.maxBodyBytes)
	}
	output, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("read output doc: %v", err)
	}
	if !strings.Contains(string(output), `<Accordion title="First question">`) {
		t.Fatalf("expected first accordion in output:\n%s", string(output))
	}
	if !strings.Contains(string(output), `<Accordion title="Second question">`) {
		t.Fatalf("expected second accordion in output:\n%s", string(output))
	}
}

func TestTranslateDocFrontMatterBatchesFields(t *testing.T) {
	t.Parallel()

	translator := &recorderTranslator{
		translateFn: func(text string) string {
			switch text {
			case "Gateway":
				return "网关"
			case "Common answers":
				return "常见答案"
			case "Read this first":
				return "先读这个"
			default:
				return "ZH:" + text
			}
		},
	}
	data := map[string]any{
		"title":     "Gateway",
		"summary":   "Common answers",
		"read_when": []any{"Read this first"},
	}

	if err := translateDocFrontMatter(context.Background(), translator, data, "en", "zh-CN"); err != nil {
		t.Fatalf("translateDocFrontMatter returned error: %v", err)
	}
	if translator.rawCalls != 0 {
		t.Fatalf("expected frontmatter translation to avoid raw batching, got %d raw calls", translator.rawCalls)
	}
	if len(translator.seenText) != 3 {
		t.Fatalf("expected per-field Translate calls for frontmatter, got %d", len(translator.seenText))
	}
	if got := data["title"]; got != "网关" {
		t.Fatalf("expected translated title, got %#v", got)
	}
	if got := data["summary"]; got != "常见答案" {
		t.Fatalf("expected translated summary, got %#v", got)
	}
	readWhen, _ := data["read_when"].([]any)
	if len(readWhen) != 1 || readWhen[0] != "先读这个" {
		t.Fatalf("expected translated read_when, got %#v", data["read_when"])
	}
}

func TestCanAcceptBareBodyResponse(t *testing.T) {
	t.Parallel()

	if !canAcceptBareBodyResponse("如果 RPC 不可用，请回退到：") {
		t.Fatal("expected bare translated body response to be accepted")
	}
	if canAcceptBareBodyResponse("<body>translated</body>") {
		t.Fatal("tagged body should not use bare-body fallback")
	}
	if canAcceptBareBodyResponse("   \n") {
		t.Fatal("blank response should not use bare-body fallback")
	}
}
