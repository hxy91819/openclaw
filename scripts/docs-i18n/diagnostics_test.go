package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDocCaptureArtifactPathKeepsLocaleAndRelativePath(t *testing.T) {
	t.Parallel()

	got := docCaptureArtifactPath("/tmp/captures", "zh-CN", "help/faq.md", "response.tagged.txt")
	want := filepath.Join("/tmp/captures", "zh-CN", "help", "faq.md.response.tagged.txt")
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestBestEffortCaptureDocArtifactsWritesMetadataAndTaggedFiles(t *testing.T) {
	captureDir := t.TempDir()
	t.Setenv(envDocsI18nCaptureDir, captureDir)

	bestEffortCaptureDocArtifacts("gateway/configuration-reference.md", docCaptureMetadata{
		RelPath:        "gateway/configuration-reference.md",
		SourceLang:     "en",
		TargetLang:     "zh-CN",
		Provider:       "openai",
		Model:          "gpt-5.4",
		RequestBytes:   12,
		RequestSHA256:  "request-hash",
		ResponseBytes:  8,
		ResponseSHA256: "response-hash",
		ParseError:     "missing </body>",
	}, map[string]string{
		"request.tagged.txt":  "<body>request</body>",
		"response.tagged.txt": "<body>bad",
	})

	metadataPath := filepath.Join(captureDir, "zh-CN", "gateway", "configuration-reference.md.metadata.json")
	requestPath := filepath.Join(captureDir, "zh-CN", "gateway", "configuration-reference.md.request.tagged.txt")
	responsePath := filepath.Join(captureDir, "zh-CN", "gateway", "configuration-reference.md.response.tagged.txt")

	for _, target := range []string{metadataPath, requestPath, responsePath} {
		if _, err := os.Stat(target); err != nil {
			t.Fatalf("expected capture file %s: %v", target, err)
		}
	}

	metadata := mustReadFile(t, metadataPath)
	if !strings.Contains(metadata, `"parseError": "missing \u003c/body\u003e"`) {
		t.Fatalf("expected parse error in metadata, got:\n%s", metadata)
	}
	if got := mustReadFile(t, requestPath); got != "<body>request</body>" {
		t.Fatalf("unexpected request capture: %q", got)
	}
	if got := mustReadFile(t, responsePath); got != "<body>bad" {
		t.Fatalf("unexpected response capture: %q", got)
	}
}
