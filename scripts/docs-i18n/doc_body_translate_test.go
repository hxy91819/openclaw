package main

import (
	"context"
	"strings"
	"testing"
)

type recorderTranslator struct {
	rawCalls    int
	seenRaw     []string
	seenText    []string
	translateFn func(string) string
	rawFn       func(string) string
}

func (t *recorderTranslator) Translate(_ context.Context, text, _, _ string) (string, error) {
	t.seenText = append(t.seenText, text)
	if t.translateFn != nil {
		return t.translateFn(text), nil
	}
	return text, nil
}

func (t *recorderTranslator) TranslateRaw(_ context.Context, text, _, _ string) (string, error) {
	t.rawCalls++
	t.seenRaw = append(t.seenRaw, text)
	if t.rawFn != nil {
		return t.rawFn(text), nil
	}
	if t.translateFn != nil {
		return applyStructuredTestTranslation(text, t.translateFn), nil
	}
	return text, nil
}

func (t *recorderTranslator) Close() {}

func applyStructuredTestTranslation(text string, translateFn func(string) string) string {
	hits := placeholderRe.FindAllStringIndex(text, -1)
	if len(hits) < 2 || len(hits)%2 != 0 {
		return translateFn(text)
	}

	var out strings.Builder
	pos := 0
	for index := 0; index < len(hits); index += 2 {
		startSpan := hits[index]
		endSpan := hits[index+1]
		if startSpan[0] < pos || endSpan[0] < startSpan[1] {
			return translateFn(text)
		}

		startMarker := text[startSpan[0]:startSpan[1]]
		endMarker := text[endSpan[0]:endSpan[1]]
		value := strings.Trim(text[startSpan[1]:endSpan[0]], "\n")

		out.WriteString(text[pos:startSpan[0]])
		out.WriteString(startMarker)
		out.WriteString("\n")
		out.WriteString(translateFn(value))
		out.WriteString("\n")
		out.WriteString(endMarker)
		pos = endSpan[1]
	}
	out.WriteString(text[pos:])
	return out.String()
}

func TestTranslateAccordionChunkPreservesWrapperAndTranslatesTitleAndBody(t *testing.T) {
	t.Parallel()

	translator := &recorderTranslator{
		translateFn: func(text string) string {
			switch strings.TrimSpace(text) {
			case "First question":
				return "第一个问题"
			case "Alpha paragraph.":
				return "阿尔法段落。"
			default:
				return "ZH:" + text
			}
		},
	}

	input := strings.Join([]string{
		`  <Accordion title="First question">`,
		"    Alpha paragraph.",
		"  </Accordion>",
	}, "\n")

	got, err := translateAccordionChunk(context.Background(), translator, "help/faq.md.body-001", "en", "zh-CN", input)
	if err != nil {
		t.Fatalf("translateAccordionChunk returned error: %v", err)
	}
	if !strings.Contains(got, `<Accordion title="第一个问题">`) {
		t.Fatalf("expected translated title in output:\n%s", got)
	}
	if !strings.Contains(got, "阿尔法段落。") {
		t.Fatalf("expected translated body in output:\n%s", got)
	}
	if !strings.Contains(got, "</Accordion>") {
		t.Fatalf("expected closing tag to stay intact:\n%s", got)
	}
	if translator.rawCalls != 1 {
		t.Fatalf("expected a single batched raw call for accordion body, got %d", translator.rawCalls)
	}
}

func TestRepairEnglishResidueLinesTranslatesPlainEnglishOutsideCodeFences(t *testing.T) {
	t.Parallel()

	translator := &recorderTranslator{
		rawFn: func(text string) string {
			if strings.Contains(text, "Translate only the text between the markers") {
				return applyStructuredTestTranslation(text, func(value string) string {
					return strings.ReplaceAll(value, "Then select **Ollama Web Search** as the provider.", "然后选择 **Ollama Web 搜索** 作为提供商。")
				})
			}
			return text
		},
	}

	input := "```bash\nopenclaw configure --section web\n```\n\nThen select **Ollama Web Search** as the provider.\n"
	got, err := repairEnglishResidueLines(context.Background(), translator, "en", "zh-CN", input)
	if err != nil {
		t.Fatalf("repairEnglishResidueLines returned error: %v", err)
	}
	if !strings.Contains(got, "然后选择 **Ollama Web 搜索** 作为提供商。") {
		t.Fatalf("expected English residue line to be translated, got %q", got)
	}
	if !strings.Contains(got, "```bash\nopenclaw configure --section web\n```") {
		t.Fatalf("expected fenced code block to remain unchanged, got %q", got)
	}
}
