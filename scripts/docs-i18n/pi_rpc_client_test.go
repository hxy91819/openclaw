package main

import "testing"

func TestResolveDocsPiAgentDirPrefersEnvironmentOverride(t *testing.T) {
	override := t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", override)

	got, err := resolveDocsPiAgentDir()
	if err != nil {
		t.Fatalf("resolveDocsPiAgentDir returned error: %v", err)
	}
	if got != override {
		t.Fatalf("expected override %q, got %q", override, got)
	}
}
