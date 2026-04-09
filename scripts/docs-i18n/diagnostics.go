package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const envDocsI18nCaptureDir = "OPENCLAW_DOCS_I18N_CAPTURE_DIR"

type docCaptureMetadata struct {
	RelPath        string `json:"relPath"`
	SourceLang     string `json:"sourceLang"`
	TargetLang     string `json:"targetLang"`
	Provider       string `json:"provider"`
	Model          string `json:"model"`
	RequestBytes   int    `json:"requestBytes"`
	RequestSHA256  string `json:"requestSha256"`
	ResponseBytes  int    `json:"responseBytes,omitempty"`
	ResponseSHA256 string `json:"responseSha256,omitempty"`
	TranslateError string `json:"translateError,omitempty"`
	ParseError     string `json:"parseError,omitempty"`
}

func docsI18nCaptureDir() string {
	return strings.TrimSpace(os.Getenv(envDocsI18nCaptureDir))
}

func bestEffortCaptureDocArtifacts(relPath string, metadata docCaptureMetadata, artifacts map[string]string) {
	baseDir := docsI18nCaptureDir()
	if baseDir == "" {
		return
	}
	for name, content := range artifacts {
		_ = writeDocCaptureFile(baseDir, metadata.TargetLang, relPath, name, []byte(content))
	}
	encoded, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return
	}
	_ = writeDocCaptureFile(baseDir, metadata.TargetLang, relPath, "metadata.json", append(encoded, '\n'))
}

func writeDocCaptureFile(baseDir, targetLang, relPath, artifactName string, content []byte) error {
	outputPath := docCaptureArtifactPath(baseDir, targetLang, relPath, artifactName)
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(outputPath, content, 0o644)
}

func docCaptureArtifactPath(baseDir, targetLang, relPath, artifactName string) string {
	cleanRel := filepath.Clean(relPath)
	dir := filepath.Join(baseDir, targetLang, filepath.Dir(cleanRel))
	fileName := filepath.Base(cleanRel)
	return filepath.Join(dir, fileName+"."+artifactName)
}
