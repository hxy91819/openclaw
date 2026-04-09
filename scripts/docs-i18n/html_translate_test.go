package main

import (
	"context"
	"strings"
	"testing"
)

func TestTranslateHTMLBlockTranslatesSelectedAttributes(t *testing.T) {
	t.Parallel()

	translator := &recorderTranslator{
		translateFn: func(text string) string {
			switch text {
			case "Get Started":
				return "快速开始"
			case "Install OpenClaw":
				return "安装 OpenClaw"
			default:
				return "ZH:" + text
			}
		},
	}

	input := strings.Join([]string{
		`<Card title="Get Started" href="/start/getting-started" icon="rocket">`,
		`  <Step title="Install OpenClaw">`,
		"    Follow the installer.",
		"  </Step>",
		"</Card>",
	}, "\n")

	got, err := translateHTMLBlock(context.Background(), translator, input, "en", "zh-CN")
	if err != nil {
		t.Fatalf("translateHTMLBlock returned error: %v", err)
	}
	if !strings.Contains(got, `title="快速开始"`) {
		t.Fatalf("expected translated Card title in output:\n%s", got)
	}
	if !strings.Contains(got, `title="安装 OpenClaw"`) {
		t.Fatalf("expected translated Step title in output:\n%s", got)
	}
	if !strings.Contains(got, "ZH:Follow the installer.") {
		t.Fatalf("expected text node translation in output:\n%s", got)
	}
	if strings.Contains(got, `href="ZH:`) || strings.Contains(got, `icon="ZH:`) {
		t.Fatalf("expected non-whitelisted attributes to stay unchanged:\n%s", got)
	}
}
