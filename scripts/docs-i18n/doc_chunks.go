package main

import "strings"

const targetDocBodyChunkBytes = 12000

type docBodyChunk struct {
	Text      string
	Translate bool
}

func splitDocBodyForTranslation(body string) []docBodyChunk {
	atomic := splitDocBodyAtomicChunks(body)
	return mergeDocBodyChunks(atomic, targetDocBodyChunkBytes)
}

func splitDocBodyAtomicChunks(body string) []docBodyChunk {
	lines := splitLinesWithEndings(body)
	chunks := make([]docBodyChunk, 0, len(lines))

	for index := 0; index < len(lines); {
		trimmed := strings.TrimSpace(lines[index])
		switch {
		case trimmed == "":
			next := index + 1
			for next < len(lines) && strings.TrimSpace(lines[next]) == "" {
				next++
			}
			chunks = append(chunks, docBodyChunk{Text: joinLines(lines[index:next])})
			index = next
		case isFenceLine(trimmed):
			next := consumeFenceBlock(lines, index)
			chunks = append(chunks, docBodyChunk{Text: joinLines(lines[index:next])})
			index = next
		case trimmed == "<AccordionGroup>" || trimmed == "</AccordionGroup>":
			chunks = append(chunks, docBodyChunk{Text: lines[index]})
			index++
		case isAccordionOpen(trimmed):
			next := consumeTaggedBlock(lines, index, "Accordion")
			chunks = append(chunks, docBodyChunk{Text: joinLines(lines[index:next]), Translate: true})
			index = next
		default:
			next := consumeMarkdownChunk(lines, index)
			text := joinLines(lines[index:next])
			chunks = append(chunks, docBodyChunk{
				Text:      text,
				Translate: strings.TrimSpace(text) != "",
			})
			index = next
		}
	}

	return chunks
}

func mergeDocBodyChunks(chunks []docBodyChunk, maxBytes int) []docBodyChunk {
	if len(chunks) == 0 {
		return nil
	}

	merged := make([]docBodyChunk, 0, len(chunks))
	for _, chunk := range chunks {
		if chunk.Text == "" {
			continue
		}
		if len(merged) == 0 {
			merged = append(merged, chunk)
			continue
		}
		last := &merged[len(merged)-1]
		if chunk.Translate != last.Translate {
			merged = append(merged, chunk)
			continue
		}
		if !chunk.Translate || len(last.Text)+len(chunk.Text) <= maxBytes {
			last.Text += chunk.Text
			continue
		}
		merged = append(merged, chunk)
	}

	return merged
}

func splitLinesWithEndings(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.SplitAfter(text, "\n")
	if strings.HasSuffix(text, "\n") {
		return lines[:len(lines)-1]
	}
	return lines
}

func joinLines(lines []string) string {
	return strings.Join(lines, "")
}

func isFenceLine(trimmed string) bool {
	return strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~")
}

func consumeFenceBlock(lines []string, start int) int {
	trimmed := strings.TrimSpace(lines[start])
	marker := "```"
	if strings.HasPrefix(trimmed, "~~~") {
		marker = "~~~"
	}
	for index := start + 1; index < len(lines); index++ {
		if strings.HasPrefix(strings.TrimSpace(lines[index]), marker) {
			return index + 1
		}
	}
	return len(lines)
}

func isAccordionOpen(trimmed string) bool {
	return strings.HasPrefix(trimmed, "<Accordion ") || strings.HasPrefix(trimmed, "<Accordion>")
}

func consumeTaggedBlock(lines []string, start int, tagName string) int {
	depth := 0
	for index := start; index < len(lines); index++ {
		trimmed := strings.TrimSpace(lines[index])
		depth += countOpeningTags(trimmed, tagName)
		depth -= countClosingTags(trimmed, tagName)
		if depth <= 0 {
			return index + 1
		}
	}
	return len(lines)
}

func countOpeningTags(trimmed, tagName string) int {
	if !strings.Contains(trimmed, "<"+tagName) {
		return 0
	}
	count := 0
	search := trimmed
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

func countClosingTags(trimmed, tagName string) int {
	return strings.Count(trimmed, "</"+tagName+">")
}

func consumeMarkdownChunk(lines []string, start int) int {
	for index := start + 1; index < len(lines); index++ {
		trimmed := strings.TrimSpace(lines[index])
		if trimmed == "" {
			continue
		}
		if isFenceLine(trimmed) || trimmed == "<AccordionGroup>" || trimmed == "</AccordionGroup>" || isAccordionOpen(trimmed) {
			return index
		}
	}
	return len(lines)
}
