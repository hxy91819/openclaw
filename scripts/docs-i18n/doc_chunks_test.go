package main

import (
	"strings"
	"testing"
)

func TestSplitDocBodyForTranslationSplitsAccordionItems(t *testing.T) {
	t.Parallel()

	body := strings.Join([]string{
		"# FAQ",
		"",
		"<AccordionGroup>",
		`  <Accordion title="One">`,
		"    Alpha paragraph.",
		"  </Accordion>",
		"",
		`  <Accordion title="Two">`,
		"    Beta paragraph.",
		"  </Accordion>",
		"</AccordionGroup>",
		"",
	}, "\n")

	chunks := splitDocBodyAtomicChunks(body)
	if len(chunks) < 5 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}
	if !chunks[0].Translate {
		t.Fatalf("expected heading chunk to be translatable")
	}
	if chunks[1].Translate {
		t.Fatalf("expected AccordionGroup wrapper chunk to be passthrough")
	}
	if !chunks[2].Translate || !strings.Contains(chunks[2].Text, `title="One"`) {
		t.Fatalf("expected first accordion chunk, got %#v", chunks[2])
	}
	if !chunks[4].Translate || !strings.Contains(chunks[4].Text, `title="Two"`) {
		t.Fatalf("expected second accordion chunk, got %#v", chunks[4])
	}
}

func TestSplitDocBodyForTranslationKeepsCodeFencesPassthrough(t *testing.T) {
	t.Parallel()

	body := strings.Join([]string{
		"Before fence.",
		"",
		"```bash",
		"openclaw status",
		"```",
		"",
		"After fence.",
		"",
	}, "\n")

	chunks := splitDocBodyAtomicChunks(body)
	if !chunks[0].Translate {
		t.Fatalf("expected prose chunk before fence to translate")
	}
	fenceIndex := -1
	for index, chunk := range chunks {
		if strings.Contains(chunk.Text, "```bash") {
			fenceIndex = index
			if chunk.Translate {
				t.Fatalf("expected fence chunk to be passthrough")
			}
			break
		}
	}
	if fenceIndex == -1 {
		t.Fatalf("expected fenced code chunk in %#v", chunks)
	}
	if !chunks[len(chunks)-1].Translate {
		t.Fatalf("expected prose chunk after fence to translate")
	}
}
