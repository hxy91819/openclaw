# Translated Docs Validation Summary

- Generated at: `2026-04-08T01:52:28Z`
- Locale: `zh-CN`
- Files checked: `1`
- Fail findings: `0`
- Warn findings: `1`
- Pass files: `0`

## Fail

- none

## Warn

- `plugins/sdk-provider-plugins.md`: [english_residue] suspicious untranslated English: line 85: 清单声明了 `providerAuthEnvVars`，以便 OpenClaw 无需加载插件运行时即可检测凭证。`modelSupport` 是可选的，它允许 OpenClaw 在运行时钩子存在之前，通过类似 `acme-large` 的简短模型 ID 自动加载你的提供商插件。如果你在 ClawHub 上发布提供商，则 `package.json` 中必须包含 `openclaw.compat` 和 `openclaw.build` 字段。 | line 90: 一个最简提供商需要 `id`、`label`、`auth` 和 `catalog`： | line 161: 这是一个可以工作的提供商。用户现在可以运行 `openclaw onboard --acme-ai-api-key <key>` 并选择 `acme-ai/acme-large` 作为他们的模型。

## Pass

- none

