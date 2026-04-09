package main

import (
	"context"
	"fmt"
	"strings"
)

func translateStructuredDocChunk(ctx context.Context, translator docsTranslator, relPath, srcLang, tgtLang, text string) (string, error) {
	if isAccordionBlock(text) {
		return translateAccordionChunk(ctx, translator, relPath, srcLang, tgtLang, text)
	}
	return translateMarkdownChunk(ctx, translator, relPath, srcLang, tgtLang, text)
}

func translateMarkdownChunk(ctx context.Context, translator docsTranslator, relPath, srcLang, tgtLang, body string) (string, error) {
	translatedHTML, err := translateHTMLBlocks(ctx, translator, body, srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	segments, err := extractSegments(translatedHTML, relPath)
	if err != nil {
		return "", err
	}
	if len(segments) == 0 {
		return translatedHTML, nil
	}
	texts := make([]string, 0, len(segments))
	for _, segment := range segments {
		texts = append(texts, segment.Text)
	}
	translatedSegments, err := translateStructuredFields(ctx, translator, srcLang, tgtLang, texts)
	if err != nil {
		return "", err
	}
	for index := range segments {
		segments[index].Translated = translatedSegments[index]
	}
	return applyTranslations(translatedHTML, segments), nil
}

func translateAccordionChunk(ctx context.Context, translator docsTranslator, relPath, srcLang, tgtLang, chunk string) (string, error) {
	openEnd := strings.Index(chunk, ">")
	closeStart := strings.LastIndex(chunk, "</Accordion>")
	if openEnd == -1 || closeStart == -1 || closeStart < openEnd {
		return "", fmt.Errorf("invalid accordion chunk for %s", relPath)
	}

	openTag := chunk[:openEnd+1]
	body := chunk[openEnd+1 : closeStart]
	closeTag := chunk[closeStart:]

	translatedOpenTag, err := translateAccordionOpenTag(ctx, translator, srcLang, tgtLang, openTag)
	if err != nil {
		return "", err
	}
	dedentedBody, indent := stripSharedIndent(body)
	translatedBody, err := translateMarkdownChunk(ctx, translator, relPath, srcLang, tgtLang, dedentedBody)
	if err != nil {
		return "", err
	}
	translatedBody = applySharedIndent(translatedBody, indent)
	return translatedOpenTag + translatedBody + closeTag, nil
}

func translateAccordionOpenTag(ctx context.Context, translator docsTranslator, srcLang, tgtLang, openTag string) (string, error) {
	valueStart, valueEnd, ok := findQuotedAttributeValue(openTag, "title")
	if !ok {
		return openTag, nil
	}
	value := openTag[valueStart:valueEnd]
	translated, err := translator.Translate(ctx, value, srcLang, tgtLang)
	if err != nil {
		return "", err
	}
	return openTag[:valueStart] + translated + openTag[valueEnd:], nil
}

func isAccordionBlock(text string) bool {
	trimmed := strings.TrimSpace(text)
	return isAccordionOpen(trimmed) && strings.Contains(trimmed, "</Accordion>")
}

func findQuotedAttributeValue(tag, attribute string) (int, int, bool) {
	search := attribute
	index := strings.Index(tag, search)
	if index == -1 {
		return 0, 0, false
	}
	cursor := index + len(search)
	for cursor < len(tag) && (tag[cursor] == ' ' || tag[cursor] == '\t' || tag[cursor] == '\n' || tag[cursor] == '\r') {
		cursor++
	}
	if cursor >= len(tag) || tag[cursor] != '=' {
		return 0, 0, false
	}
	cursor++
	for cursor < len(tag) && (tag[cursor] == ' ' || tag[cursor] == '\t' || tag[cursor] == '\n' || tag[cursor] == '\r') {
		cursor++
	}
	if cursor >= len(tag) {
		return 0, 0, false
	}
	quote := tag[cursor]
	if quote != '"' && quote != '\'' {
		return 0, 0, false
	}
	valueStart := cursor + 1
	valueEnd := strings.IndexByte(tag[valueStart:], quote)
	if valueEnd == -1 {
		return 0, 0, false
	}
	valueEnd += valueStart
	return valueStart, valueEnd, true
}

func stripSharedIndent(text string) (string, string) {
	lines := splitLinesWithEndings(text)
	indent := ""
	first := true
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lineIndent := leadingWhitespace(line)
		if first {
			indent = lineIndent
			first = false
			continue
		}
		indent = commonPrefix(indent, lineIndent)
		if indent == "" {
			break
		}
	}
	if first || indent == "" {
		return text, ""
	}

	trimmedLines := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			trimmedLines = append(trimmedLines, line)
			continue
		}
		trimmedLines = append(trimmedLines, strings.TrimPrefix(line, indent))
	}
	return joinLines(trimmedLines), indent
}

func applySharedIndent(text, indent string) string {
	if indent == "" || text == "" {
		return text
	}
	lines := splitLinesWithEndings(text)
	indented := make([]string, 0, len(lines))
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			indented = append(indented, line)
			continue
		}
		indented = append(indented, indent+line)
	}
	return joinLines(indented)
}

func leadingWhitespace(line string) string {
	end := 0
	for end < len(line) {
		if line[end] != ' ' && line[end] != '\t' {
			break
		}
		end++
	}
	return line[:end]
}

func commonPrefix(left, right string) string {
	max := len(left)
	if len(right) < max {
		max = len(right)
	}
	index := 0
	for index < max && left[index] == right[index] {
		index++
	}
	return left[:index]
}

func repairEnglishResidueLines(ctx context.Context, translator docsTranslator, srcLang, tgtLang, text string) (string, error) {
	lines := splitLinesWithEndings(text)
	if len(lines) == 0 {
		return text, nil
	}

	changed := false
	inFence := false
	for index, line := range lines {
		lineBody, lineEnding := splitLineEnding(line)
		trimmed := strings.TrimSpace(lineBody)
		if trimmed == "" {
			continue
		}
		if isFenceLine(trimmed) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if strings.HasPrefix(trimmed, "<") && strings.HasSuffix(trimmed, ">") {
			continue
		}
		if !looksMostlyEnglish(trimmed) {
			continue
		}
		translated, err := translateStructuredFieldStrict(ctx, translator, srcLang, tgtLang, lineBody)
		if err != nil {
			return "", err
		}
		if translated != lineBody {
			lines[index] = translated + lineEnding
			changed = true
		}
	}
	if !changed {
		return text, nil
	}
	return joinLines(lines), nil
}

func splitLineEnding(line string) (string, string) {
	switch {
	case strings.HasSuffix(line, "\r\n"):
		return strings.TrimSuffix(line, "\r\n"), "\r\n"
	case strings.HasSuffix(line, "\n"):
		return strings.TrimSuffix(line, "\n"), "\n"
	default:
		return line, ""
	}
}
