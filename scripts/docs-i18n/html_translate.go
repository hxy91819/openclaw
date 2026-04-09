package main

import (
	"context"
	"io"
	"sort"
	"strconv"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"golang.org/x/net/html"
)

type htmlReplacement struct {
	Start int
	Stop  int
	Value string
}

type htmlTranslationSlot struct {
	Value string
}

func translateHTMLBlocks(ctx context.Context, translator docsTranslator, body, srcLang, tgtLang string) (string, error) {
	source := []byte(body)
	r := text.NewReader(source)
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
	)
	doc := md.Parser().Parse(r)

	replacements := make([]htmlReplacement, 0, 8)

	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		block, ok := n.(*ast.HTMLBlock)
		if !ok {
			return ast.WalkContinue, nil
		}
		start, stop, ok := htmlBlockSpan(block, source)
		if !ok {
			return ast.WalkSkipChildren, nil
		}
		htmlText := string(source[start:stop])
		translated, err := translateHTMLBlock(ctx, translator, htmlText, srcLang, tgtLang)
		if err != nil {
			return ast.WalkStop, err
		}
		replacements = append(replacements, htmlReplacement{Start: start, Stop: stop, Value: translated})
		return ast.WalkSkipChildren, nil
	})

	if len(replacements) == 0 {
		return body, nil
	}

	return applyHTMLReplacements(body, replacements), nil
}

func htmlBlockSpan(block *ast.HTMLBlock, source []byte) (int, int, bool) {
	lines := block.Lines()
	if lines.Len() == 0 {
		return 0, 0, false
	}
	start := lines.At(0).Start
	stop := lines.At(lines.Len() - 1).Stop
	if start >= stop {
		return 0, 0, false
	}
	return start, stop, true
}

func applyHTMLReplacements(body string, replacements []htmlReplacement) string {
	if len(replacements) == 0 {
		return body
	}
	sortHTMLReplacements(replacements)
	var out strings.Builder
	last := 0
	for _, rep := range replacements {
		if rep.Start < last {
			continue
		}
		out.WriteString(body[last:rep.Start])
		out.WriteString(rep.Value)
		last = rep.Stop
	}
	out.WriteString(body[last:])
	return out.String()
}

func sortHTMLReplacements(replacements []htmlReplacement) {
	sort.Slice(replacements, func(i, j int) bool {
		return replacements[i].Start < replacements[j].Start
	})
}

func translateHTMLBlock(ctx context.Context, translator docsTranslator, htmlText, srcLang, tgtLang string) (string, error) {
	tokenizer := html.NewTokenizer(strings.NewReader(htmlText))
	var (
		out   strings.Builder
		slots []htmlTranslationSlot
	)
	skipDepth := 0

	for {
		tt := tokenizer.Next()
		if tt == html.ErrorToken {
			if err := tokenizer.Err(); err != nil && err != io.EOF {
				return "", err
			}
			break
		}

		raw := string(tokenizer.Raw())
		tok := tokenizer.Token()

		switch tt {
		case html.StartTagToken:
			tagWithMarkers, newSlots := markHTMLTagAttributes(raw, len(slots))
			out.WriteString(tagWithMarkers)
			slots = append(slots, newSlots...)
			if isSkipTag(strings.ToLower(tok.Data)) {
				skipDepth++
			}
		case html.EndTagToken:
			out.WriteString(raw)
			if isSkipTag(strings.ToLower(tok.Data)) && skipDepth > 0 {
				skipDepth--
			}
		case html.SelfClosingTagToken:
			tagWithMarkers, newSlots := markHTMLTagAttributes(raw, len(slots))
			out.WriteString(tagWithMarkers)
			slots = append(slots, newSlots...)
		case html.TextToken:
			if shouldTranslateHTMLText(skipDepth, raw) {
				placeholder := htmlSlotPlaceholder(len(slots))
				out.WriteString(placeholder)
				slots = append(slots, htmlTranslationSlot{Value: raw})
			} else {
				out.WriteString(raw)
			}
		default:
			out.WriteString(raw)
		}
	}

	if len(slots) == 0 {
		return out.String(), nil
	}

	values := make([]string, 0, len(slots))
	for _, slot := range slots {
		values = append(values, slot.Value)
	}
	translatedValues, err := translateStructuredFields(ctx, translator, srcLang, tgtLang, values)
	if err != nil {
		return "", err
	}
	result := out.String()
	for index, translated := range translatedValues {
		result = strings.ReplaceAll(result, htmlSlotPlaceholder(index), translated)
	}
	return result, nil
}

func markHTMLTagAttributes(raw string, offset int) (string, []htmlTranslationSlot) {
	result := raw
	slots := make([]htmlTranslationSlot, 0, len(translatableHTMLAttributes()))
	for _, attribute := range translatableHTMLAttributes() {
		valueStart, valueEnd, ok := findQuotedAttributeValue(result, attribute)
		if !ok {
			continue
		}
		value := result[valueStart:valueEnd]
		if strings.TrimSpace(value) == "" {
			continue
		}
		placeholder := htmlSlotPlaceholder(offset + len(slots))
		slots = append(slots, htmlTranslationSlot{Value: value})
		result = result[:valueStart] + placeholder + result[valueEnd:]
	}
	return result, slots
}

func translatableHTMLAttributes() []string {
	return []string{"title", "label", "summary", "description"}
}

func htmlSlotPlaceholder(index int) string {
	return "__OC_I18N_HTML_SLOT_" + strconv.Itoa(index) + "__"
}

func shouldTranslateHTMLText(skipDepth int, text string) bool {
	if strings.TrimSpace(text) == "" {
		return false
	}
	return skipDepth == 0
}

func isSkipTag(tag string) bool {
	switch tag {
	case "code", "pre", "script", "style":
		return true
	default:
		return false
	}
}
