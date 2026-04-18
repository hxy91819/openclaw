#!/usr/bin/env node

/**
 * Lint: 运行时代码不得导入 config redact/restore 模块
 *
 * OpenClaw 的配置读写存在两条独立路径，不可混用：
 *
 * 1. Runtime path: loadConfig() → 直接使用原始值（浏览器连接、embedding 调用等）
 * 2. API/Display path: readConfigFileSnapshot() → redactConfigSnapshot() → 返回给 UI
 *    写入时: restoreRedactedValues() 还原 __OPENCLAW_REDACTED__ 占位符
 *
 * 运行时代码如果意外使用了 redacted 值（如浏览器连接拿到 __OPENCLAW_REDACTED__），
 * 会导致连接失败；展示代码如果漏做 redact，会泄露凭据。
 *
 * 此规则确保运行时目录不导入 redact-snapshot 中的 redact/restore 函数，
 * 防止两条路径被意外混用。
 *
 * 注意：redactSensitiveUrl() / redactSensitiveUrlLikeString() 在运行时代码中
 * 用于日志/错误消息的 URL 脱敏是合理使用，不被此规则禁止。
 */

import ts from "typescript";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { runAsScript, resolveRepoRoot } from "./lib/ts-guard-utils.mjs";

/**
 * 运行时代码目录 — 这些目录的代码在运行时直接消费配置值，
 * 不应导入 config 级别的 redact/restore 函数。
 *
 * 覆盖所有 extensions/ 和 src/ 下的运行时消费方。
 * 不在此列表中的目录默认不受限制。
 */
const RUNTIME_ROOTS = [
  "extensions",       // 所有扩展 — 运行时通过 plugin-sdk/config-runtime 读取配置
  "src/agents",       // agent 运行时（MCP 连接、模型调用等）
  "src/auto-reply",   // 自动回复运行时
  "src/channels",     // channel 运行时
  "src/line",         // line 运行时
  "src/routing",      // 路由运行时
];

/**
 * 允许的例外目录 — 即使在 RUNTIME_ROOTS 下，这些子目录也允许导入，
 * 因为它们属于展示层而非运行时消费层。
 */
const ALLOWED_SUBPATHS = [
  // src/agents 中 redactSensitiveUrlLikeString 用于日志脱敏，这是合理的运行时使用
  // 但 redactConfigSnapshot/restoreRedactedValues 仍然被禁止
  // 此处不需要列出例外 — 本规则按导入符号粒度控制，不按目录白名单
];

/**
 * 从 redact-snapshot 导入时，被禁止的符号。
 * 这些函数仅用于 API/Display path。
 */
const BANNED_FROM_REDACT_SNAPSHOT = new Set([
  "redactConfigSnapshot",     // 替换整个 snapshot 中的敏感字段
  "redactConfigObject",       // 替换 config 对象中的敏感字段
  "restoreRedactedValues",    // 将 __OPENCLAW_REDACTED__ 还原为原始值
  "REDACTED_SENTINEL",        // sentinel 常量
]);

/**
 * 从 redact-sensitive-url 导入时，被禁止的符号。
 *
 * redactSensitiveUrl() / redactSensitiveUrlLikeString() 不在禁止列表中 —
 * 它们在运行时代码中用于日志/错误消息的 URL 脱敏，是合理的。
 *
 * 以下函数仅用于 config redact 框架内部，运行时代码不应依赖：
 */
const BANNED_FROM_REDACT_SENSITIVE_URL = new Set([
  "isSensitiveUrlConfigPath",   // 判断配置路径是否为敏感 URL — 仅 config redact 框架需要
  "hasSensitiveUrlHintTag",     // 检查 url-secret 标签 — 仅 config redact 框架需要
  "SENSITIVE_URL_HINT_TAG",     // url-secret 常量 — 仅 config redact 框架需要
]);

/**
 * 允许从 redact-snapshot 导入的目录（不在 RUNTIME_ROOTS 中）。
 * 这些目录属于 API/Display path，导入 redact/restore 函数是合理的。
 *
 * 此列表仅供参考 — 本规则采用黑名单模式（只扫描 RUNTIME_ROOTS），
 * 不在此列表中的目录默认不受限制。
 */
// const ALLOWED_ROOTS = [
//   "src/config",        // redact 模块本身
//   "src/gateway",       // config.get/set RPC handler
//   "src/cli",           // CLI config get 输出
//   "src/plugins",       // marketplace URL display
//   "src/shared",        // redact-sensitive-url 工具函数
// ];

function findViolations(content, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const violations = [];

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (!ts.isStringLiteral(moduleSpecifier)) {
        ts.forEachChild(node, visit);
        return;
      }

      const importPath = moduleSpecifier.text;

      const isRedactSnapshotImport = importPath.includes("redact-snapshot");
      const isRedactSensitiveUrlImport = importPath.includes("redact-sensitive-url");

      if (!isRedactSnapshotImport && !isRedactSensitiveUrlImport) {
        return;
      }

      const bannedImports = isRedactSnapshotImport
        ? BANNED_FROM_REDACT_SNAPSHOT
        : BANNED_FROM_REDACT_SENSITIVE_URL;

      const importClause = node.importClause;
      if (!importClause) return;

      // Named imports: import { a, b } from "..."
      if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          if (bannedImports.has(element.name.text)) {
            const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
            violations.push(line.line + 1);
          }
        }
      }

      // Namespace import: import * as X from "..."
      if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(line.line + 1);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

runAsScript(import.meta.url, async () => {
  await runCallsiteGuard({
    sourceRoots: RUNTIME_ROOTS,
    header: [
      "Config redact/restore functions must not be imported in runtime code.",
      "",
      "Runtime code (browser CDP, agents, channels, etc.) must use loadConfig() directly.",
      "Redact/restore functions are only for API/Display path (config.get, CLI output).",
      "",
      "Banned from redact-snapshot: redactConfigSnapshot, redactConfigObject,",
      "  restoreRedactedValues, REDACTED_SENTINEL",
      "Banned from redact-sensitive-url: isSensitiveUrlConfigPath,",
      "  hasSensitiveUrlHintTag, SENSITIVE_URL_HINT_TAG",
      "",
      "Allowed in runtime: redactSensitiveUrl, redactSensitiveUrlLikeString",
      "  (for log/error URL redaction — this is legitimate runtime usage)",
      "",
      "If you need to display a redacted URL in runtime status output, use the",
      "display-level redactCdpUrl() helper or redactSensitiveUrl() instead of",
      "the config redact framework.",
      "",
      "Violations:",
    ].join("\n"),
    footer: [
      "",
      "See: my_docs/04-cases/2026-04-18-config-read-write-dual-path/00-README.md",
    ].join("\n"),
    findCallLines: findViolations,
    importMetaUrl: import.meta.url,
    sortViolations: true,
    allowCallsite: () => false,
    skipRelativePath: (relPath) => {
      if (relPath.includes(".test.") || relPath.includes(".spec.")) return true;
      if (relPath.endsWith(".d.ts")) return true;
      return false;
    },
  });
});
