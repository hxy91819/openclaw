package main

import (
	"context"
	"errors"
	"log"
	"strings"
)

const (
	maxStructuredBatchFields = 12
	maxStructuredBatchBytes  = 1200
)

type structuredField struct {
	Start        string
	End          string
	Core         string
	Lead         string
	Tail         string
	Raw          string
	Placeholders []string
	Mapping      map[string]string
}

func translateStructuredFields(ctx context.Context, translator docsTranslator, srcLang, tgtLang string, texts []string) ([]string, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	if len(texts) == 1 {
		return translateStructuredFieldBatch(ctx, translator, srcLang, tgtLang, texts)
	}

	out := make([]string, 0, len(texts))
	batch := make([]string, 0, minInt(len(texts), maxStructuredBatchFields))
	batchBytes := 0

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		translated, err := translateStructuredFieldBatch(ctx, translator, srcLang, tgtLang, batch)
		if err != nil {
			if isPlaceholderTranslateError(err) {
				log.Printf("docs-i18n: batch fallback split fields=%d", len(batch))
				translated, err = translateStructuredFieldsIndividually(ctx, translator, srcLang, tgtLang, batch)
			}
			if err != nil {
				return err
			}
		}
		out = append(out, translated...)
		batch = batch[:0]
		batchBytes = 0
		return nil
	}

	for _, text := range texts {
		estimated := len(text) + 64
		if len(batch) > 0 && (len(batch) >= maxStructuredBatchFields || batchBytes+estimated > maxStructuredBatchBytes) {
			if err := flush(); err != nil {
				return nil, err
			}
		}
		batch = append(batch, text)
		batchBytes += estimated
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return out, nil
}

func translateStructuredFieldBatch(ctx context.Context, translator docsTranslator, srcLang, tgtLang string, texts []string) ([]string, error) {
	state := NewPlaceholderState(strings.Join(texts, "\n"))
	fields := make([]structuredField, 0, len(texts))
	var placeholders []string
	var payload strings.Builder

	for _, text := range texts {
		lead, core, tail := splitWhitespace(text)
		if core == "" {
			fields = append(fields, structuredField{Raw: text})
			continue
		}
		fieldPlaceholders := make([]string, 0, 8)
		mapping := map[string]string{}
		maskedCore := maskMarkdown(core, state.Next, &fieldPlaceholders, mapping)
		start := state.Next()
		end := state.Next()
		fields = append(fields, structuredField{
			Start:        start,
			End:          end,
			Core:         maskedCore,
			Lead:         lead,
			Tail:         tail,
			Raw:          text,
			Placeholders: fieldPlaceholders,
			Mapping:      mapping,
		})
		payload.WriteString(start)
		payload.WriteString("\n")
		payload.WriteString(maskedCore)
		payload.WriteString("\n")
		payload.WriteString(end)
		payload.WriteString("\n\n")
		placeholders = append(placeholders, fieldPlaceholders...)
		placeholders = append(placeholders, start, end)
	}

	if len(placeholders) == 0 {
		return append([]string(nil), texts...), nil
	}

	log.Printf("docs-i18n: batch fields=%d prompt_bytes=%d", len(fields), len(strings.TrimRight(payload.String(), "\n")))

	translated, err := translator.TranslateRaw(ctx, strings.TrimRight(payload.String(), "\n"), srcLang, tgtLang)
	if err != nil {
		return nil, err
	}
	if err := validatePlaceholders(translated, placeholders); err != nil {
		return nil, err
	}

	out := make([]string, 0, len(fields))
	for _, field := range fields {
		if field.Core == "" {
			out = append(out, field.Raw)
			continue
		}
		value, err := extractMarkerValue(translated, field.Start, field.End)
		if err != nil {
			return nil, err
		}
		unmasked := unmaskMarkdown(strings.Trim(value, "\n"), field.Placeholders, field.Mapping)
		if shouldRetryStructuredField(field.Raw, unmasked) {
			log.Printf("docs-i18n: batch fallback single-field bytes=%d", len(field.Raw))
			retryValue, err := translateStructuredFieldStrict(ctx, translator, srcLang, tgtLang, field.Raw)
			if err != nil {
				return nil, err
			}
			unmasked = retryValue
		}
		out = append(out, field.Lead+unmasked+field.Tail)
	}
	return out, nil
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func translateStructuredFieldsIndividually(ctx context.Context, translator docsTranslator, srcLang, tgtLang string, texts []string) ([]string, error) {
	out := make([]string, 0, len(texts))
	for _, text := range texts {
		translated, err := translator.Translate(ctx, text, srcLang, tgtLang)
		if err != nil {
			return nil, err
		}
		if shouldRetryStructuredField(text, translated) {
			translated, err = translateStructuredFieldStrict(ctx, translator, srcLang, tgtLang, text)
			if err != nil {
				return nil, err
			}
		}
		out = append(out, translated)
	}
	return out, nil
}

func shouldRetryStructuredField(original, translated string) bool {
	if normalizeText(original) == normalizeText(translated) {
		return looksLikeEnglishProse(original)
	}
	return looksMostlyEnglish(translated)
}

func looksLikeEnglishProse(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	letters := 0
	words := 0
	for _, field := range strings.Fields(trimmed) {
		hasLetter := false
		for _, r := range field {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				letters++
				hasLetter = true
			}
		}
		if hasLetter {
			words++
		}
	}
	if words < 3 || letters < 12 {
		return false
	}
	return true
}

func looksMostlyEnglish(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}

	englishWords := 0
	cjkRunes := 0
	for _, field := range strings.Fields(trimmed) {
		hasASCIIWord := false
		for _, r := range field {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
				hasASCIIWord = true
			}
			if r >= 0x4E00 && r <= 0x9FFF {
				cjkRunes++
			}
		}
		if hasASCIIWord {
			englishWords++
		}
	}
	return englishWords >= 4 && cjkRunes < 6
}

func translateStructuredFieldStrict(ctx context.Context, translator docsTranslator, srcLang, tgtLang, text string) (string, error) {
	lead, core, tail := splitWhitespace(text)
	if core == "" {
		return text, nil
	}

	state := NewPlaceholderState(core)
	placeholders := make([]string, 0, 8)
	mapping := map[string]string{}
	masked := maskMarkdown(core, state.Next, &placeholders, mapping)
	start := state.Next()
	end := state.Next()
	allPlaceholders := append(append([]string{}, placeholders...), start, end)

	prompt := strings.Join([]string{
		"Translate only the text between the markers into the target language.",
		"Return the markers unchanged, preserve placeholders exactly, and keep Markdown formatting intact.",
		start,
		masked,
		end,
	}, "\n")

	translated, err := translator.TranslateRaw(ctx, prompt, srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	if err := validatePlaceholders(translated, allPlaceholders); err != nil {
		return "", err
	}
	value, err := extractMarkerValue(translated, start, end)
	if err != nil {
		return "", err
	}
	unmasked := unmaskMarkdown(strings.Trim(value, "\n"), placeholders, mapping)
	return lead + unmasked + tail, nil
}

func isPlaceholderTranslateError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "placeholder missing") || errors.Is(err, errEmptyTranslation)
}
