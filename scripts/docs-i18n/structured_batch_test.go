package main

import (
	"context"
	"strings"
	"testing"
)

func TestTranslateStructuredFieldsPreservesOuterWhitespace(t *testing.T) {
	t.Parallel()

	translator := &recorderTranslator{
		translateFn: func(text string) string {
			return "ZH:" + text
		},
	}

	got, err := translateStructuredFields(context.Background(), translator, "en", "zh-CN", []string{
		"  Alpha paragraph.\n",
		"\n  Beta line.\n",
	})
	if err != nil {
		t.Fatalf("translateStructuredFields returned error: %v", err)
	}
	if want := "  ZH:Alpha paragraph.\n"; got[0] != want {
		t.Fatalf("expected %q, got %q", want, got[0])
	}
	if want := "\n  ZH:Beta line.\n"; got[1] != want {
		t.Fatalf("expected %q, got %q", want, got[1])
	}
}

func TestTranslateStructuredFieldsPreservesMaskedMarkdown(t *testing.T) {
	t.Parallel()

	translator := &recorderTranslator{
		rawFn: func(text string) string {
			text = strings.ReplaceAll(text, "See ", "参见 ")
			text = strings.ReplaceAll(text, " and ", " 和 ")
			return text
		},
	}

	got, err := translateStructuredFields(context.Background(), translator, "en", "zh-CN", []string{
		"See [Getting Started](/start/getting-started) and `openclaw doctor`.",
	})
	if err != nil {
		t.Fatalf("translateStructuredFields returned error: %v", err)
	}
	if got[0] != "参见 [Getting Started](/start/getting-started) 和 `openclaw doctor`." {
		t.Fatalf("unexpected translated markdown field: %q", got[0])
	}
}

func TestTranslateStructuredFieldsFallsBackForUnchangedEnglish(t *testing.T) {
	t.Parallel()

	translator := &recorderTranslator{
		rawFn: func(text string) string {
			if strings.Contains(text, "Translate only the text between the markers") {
				return applyStructuredTestTranslation(text, func(value string) string {
					return strings.ReplaceAll(value, "The manifest declares", "该清单声明")
				})
			}
			return text
		},
		translateFn: func(text string) string {
			return text
		},
	}

	got, err := translateStructuredFields(context.Background(), translator, "en", "zh-CN", []string{
		"The manifest declares providerAuthEnvVars so OpenClaw can detect credentials.",
	})
	if err != nil {
		t.Fatalf("translateStructuredFields returned error: %v", err)
	}
	if !strings.Contains(got[0], "该清单声明") {
		t.Fatalf("expected fallback translation, got %q", got[0])
	}
	if translator.rawCalls < 2 {
		t.Fatalf("expected batched raw call plus strict raw retry, got %d", translator.rawCalls)
	}
}

func TestTranslateStructuredFieldsFallsBackToIndividualOnPlaceholderLoss(t *testing.T) {
	t.Parallel()

	translator := &recorderTranslator{
		rawFn: func(text string) string {
			return placeholderRe.ReplaceAllString(text, "")
		},
		translateFn: func(text string) string {
			return "ZH:" + text
		},
	}

	got, err := translateStructuredFields(context.Background(), translator, "en", "zh-CN", []string{
		"Alpha [one](/one).",
		"Beta [two](/two).",
	})
	if err != nil {
		t.Fatalf("translateStructuredFields returned error: %v", err)
	}
	if len(got) != 2 || got[0] != "ZH:Alpha [one](/one)." || got[1] != "ZH:Beta [two](/two)." {
		t.Fatalf("unexpected fallback output: %#v", got)
	}
	if translator.rawCalls == 0 {
		t.Fatal("expected batched raw attempt before fallback")
	}
	if len(translator.seenText) < 2 {
		t.Fatalf("expected individual Translate fallback calls, got %d", len(translator.seenText))
	}
}

func TestShouldRetryStructuredFieldForMostlyEnglishOutput(t *testing.T) {
	t.Parallel()

	original := "Run this command and then select the provider."
	translated := "`bun.lock` / `bun.lockb` are gitignored, so there is no repo churn. To skip lockfile writes entirely:"

	if !shouldRetryStructuredField(original, translated) {
		t.Fatalf("expected mostly-English translated output to trigger strict retry")
	}
}
