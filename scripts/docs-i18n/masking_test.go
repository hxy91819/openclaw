package main

import "testing"

func TestMaskMarkdownMasksFencedCodeBlocks(t *testing.T) {
	t.Helper()

	nextIndex := 0
	nextPlaceholder := func() string {
		value := "__OC_I18N_TEST_" + string(rune('A'+nextIndex)) + "__"
		nextIndex++
		return value
	}

	var placeholders []string
	mapping := map[string]string{}
	input := "Run this:\n\n```bash\nopenclaw configure --section web\n```\n\nThen select the provider."

	masked := maskMarkdown(input, nextPlaceholder, &placeholders, mapping)
	if masked == input {
		t.Fatalf("expected fenced code block to be masked")
	}
	if len(placeholders) == 0 {
		t.Fatalf("expected placeholders to be recorded")
	}
	if got := unmaskMarkdown(masked, placeholders, mapping); got != input {
		t.Fatalf("expected unmaskMarkdown to restore original text\nwant: %q\ngot:  %q", input, got)
	}
}
