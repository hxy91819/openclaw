package main

import "testing"

func TestExtractSegmentsIncludesTableCells(t *testing.T) {
	t.Parallel()

	body := "| Column |\n| --- |\n| Value |\n"

	segments, err := extractSegments(body, "reference/table.md")
	if err != nil {
		t.Fatalf("extractSegments returned error: %v", err)
	}
	if len(segments) < 2 {
		t.Fatalf("expected table header and cell segments, got %d", len(segments))
	}
	foundColumn := false
	foundValue := false
	for _, segment := range segments {
		switch segment.Text {
		case "Column":
			foundColumn = true
		case "Value":
			foundValue = true
		}
	}
	if !foundColumn || !foundValue {
		t.Fatalf("expected translated table cells, got %#v", segments)
	}
}
