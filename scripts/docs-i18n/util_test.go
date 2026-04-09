package main

import "testing"

func TestDocsPiProviderPrefersExplicitOverride(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "anthropic")
	t.Setenv("OPENAI_API_KEY", "openai-key")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-key")

	if got := docsPiProvider(); got != "anthropic" {
		t.Fatalf("expected anthropic override, got %q", got)
	}
}

func TestDocsPiProviderPrefersOpenAIEnvWhenAvailable(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "")
	t.Setenv("OPENAI_API_KEY", "openai-key")
	t.Setenv("ANTHROPIC_API_KEY", "anthropic-key")

	if got := docsPiProvider(); got != "openai" {
		t.Fatalf("expected openai provider, got %q", got)
	}
}

func TestDocsPiModelUsesProviderDefault(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "anthropic")
	t.Setenv(envDocsI18nModel, "")

	if got := docsPiModel(); got != defaultAnthropicModel {
		t.Fatalf("expected anthropic default model, got %q", got)
	}
}

func TestDocsPiModelKeepsOpenAIDefaultAtGPT54(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "openai")
	t.Setenv(envDocsI18nModel, "")

	if got := docsPiModel(); got != defaultOpenAIModel {
		t.Fatalf("expected OpenAI default model %q, got %q", defaultOpenAIModel, got)
	}
}

func TestDocsPiModelPrefersExplicitOverride(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "openai")
	t.Setenv(envDocsI18nModel, "gpt-5.2")

	if got := docsPiModel(); got != "gpt-5.2" {
		t.Fatalf("expected explicit model override, got %q", got)
	}
}

func TestDocsPiProviderArgUsesBuiltInProviderWithoutOverride(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "openai")
	t.Setenv(envDocsI18nModel, "gpt-5.4")
	t.Setenv("PI_CODING_AGENT_DIR", "")

	if got := docsPiProviderArg(); got != "openai" {
		t.Fatalf("expected built-in provider arg, got %q", got)
	}
	if got := docsPiModelRef(); got != "gpt-5.4" {
		t.Fatalf("expected bare model ref for built-in provider, got %q", got)
	}
}

func TestDocsPiProviderArgOmittedForAgentDirOverride(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "openai")
	t.Setenv(envDocsI18nModel, "kimi-k2.5")
	t.Setenv("PI_CODING_AGENT_DIR", t.TempDir())

	if got := docsPiProviderArg(); got != "" {
		t.Fatalf("expected provider arg to be omitted, got %q", got)
	}
	if got := docsPiModelRef(); got != "openai/kimi-k2.5" {
		t.Fatalf("expected qualified model ref, got %q", got)
	}
}

func TestDocsPiProviderArgOmittedForCustomProvider(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "ollama-cloud")
	t.Setenv(envDocsI18nModel, "glm-5")
	t.Setenv("PI_CODING_AGENT_DIR", "")

	if got := docsPiProviderArg(); got != "" {
		t.Fatalf("expected custom provider arg to be omitted, got %q", got)
	}
	if got := docsPiModelRef(); got != "ollama-cloud/glm-5" {
		t.Fatalf("expected qualified custom model ref, got %q", got)
	}
}

func TestDocsPiModelRefPreservesExplicitModelReference(t *testing.T) {
	t.Setenv(envDocsI18nProvider, "openai")
	t.Setenv(envDocsI18nModel, "openai/qwen3-coder-next")
	t.Setenv("PI_CODING_AGENT_DIR", "")

	if got := docsPiProviderArg(); got != "" {
		t.Fatalf("expected explicit model ref to suppress provider arg, got %q", got)
	}
	if got := docsPiModelRef(); got != "openai/qwen3-coder-next" {
		t.Fatalf("expected explicit model ref to be preserved, got %q", got)
	}
}
