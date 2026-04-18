#!/usr/bin/env node

/**
 * Lint: 检测 schema 中可能含凭据的 URL 配置字段未被 redact 框架覆盖
 *
 * OpenClaw 的敏感 URL redact 有双重识别机制：
 *   1. 路径后缀匹配: isSensitiveUrlConfigPath() in redact-sensitive-url.ts
 *   2. Schema 标签: hasSensitiveUrlHintTag() 检查 url-secret tag
 *
 * 两者任一命中即可。此规则检测 schema 中名称包含 Url/url 的配置字段，
 * 如果既没有被路径匹配覆盖，也没有 url-secret 标签，则报错。
 *
 * 这样可以防止类似 PR #67679（browser.cdpUrl 遗漏）的问题再次发生。
 *
 * 注意：isSensitiveUrlConfigPath 的规则从源码动态提取，而非硬编码，
 * 确保此 lint 始终与实际运行时规则一致。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

// 以下 URL 字段名称模式不含凭据，不需要 redact
const SAFE_URL_PATTERNS = [
  /allowUrl$/i,          // allowlist 布尔值或列表，不含凭据
  /urlAllowlist$/i,      // URL 白名单列表，不含凭据
  /allowExternalEmbed/i, // 允许嵌入的外部 URL 列表，不含凭据
  /hookUrl$/i,           // 公开回调 URL（别人调你的地址），凭据在 token 字段中
];

function isSafeUrlField(key) {
  return SAFE_URL_PATTERNS.some((p) => p.test(key));
}

/**
 * 从 redact-sensitive-url.ts 源码中动态提取 isSensitiveUrlConfigPath 的路径后缀规则。
 * 解析 endsWith(".xxx") 调用，提取后缀字符串。
 */
function extractEndsWithRules(source) {
  const rules = [];
  // 匹配 path.endsWith(".xxx") 模式
  const endsWithPattern = /path\.endsWith\("(\.[^"]+)"\)/g;
  let match;
  while ((match = endsWithPattern.exec(source)) !== null) {
    rules.push(match[1]);
  }
  return rules;
}

/**
 * 从 redact-sensitive-url.ts 源码中动态提取正则规则。
 * 解析 /^...$/ 正则字面量。
 */
function extractRegexRules(source) {
  const rules = [];
  // 匹配 /pattern/.test(path) 模式
  const regexPattern = /\/(\^[^/]+)\$\/\.test\(path\)/g;
  let match;
  while ((match = regexPattern.exec(source)) !== null) {
    rules.push(new RegExp(match[1] + "$"));
  }
  return rules;
}

/**
 * 用从源码提取的规则构建 isSensitiveUrlConfigPath 等价函数
 */
function buildIsSensitiveUrlConfigPath(source) {
  const endsWithRules = extractEndsWithRules(source);
  const regexRules = extractRegexRules(source);

  return function isSensitiveUrlConfigPath(configPath) {
    for (const suffix of endsWithRules) {
      if (configPath.endsWith(suffix)) return true;
    }
    for (const regex of regexRules) {
      if (regex.test(configPath)) return true;
    }
    return false;
  };
}

async function run() {
  const repoRoot = path.resolve(import.meta.dirname, "..");

  // 读取 redact-sensitive-url.ts 源码，动态提取规则
  const redactSourcePath = path.join(
    repoRoot,
    "src/shared/net/redact-sensitive-url.ts",
  );
  const redactSource = await fs.readFile(redactSourcePath, "utf8");
  const isSensitiveUrlConfigPath = buildIsSensitiveUrlConfigPath(redactSource);

  // 读取 schema.base.generated.ts，提取所有 URL 配置字段
  const schemaPath = path.join(
    repoRoot,
    "src/config/schema.base.generated.ts",
  );
  // 解析 schema.base.generated.ts，提取所有 URL 配置字段
  // 格式: "some.key": { label: "...", help: "...", tags: [...] },
  // 使用非贪婪匹配 + 缩进边界避免跨条目
  const content = await fs.readFile(schemaPath, "utf8");
  const entryPattern = /"([^"]+)":\s*\{([\s\S]*?)\n    \}/g;

  const violations = [];
  let match;

  while ((match = entryPattern.exec(content)) !== null) {
    const key = match[1];
    const body = match[2];

    // 只看键名中包含 Url / url 的字段
    if (!/[Uu]rl/.test(key)) continue;

    // 跳过已知安全的字段
    if (isSafeUrlField(key)) continue;

    // 从 body 中提取 tags
    const tagsMatch = body.match(/tags:\s*\[([^\]]*)\]/);
    if (!tagsMatch) continue;
    const tags = tagsMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/"/g, "").replace(/'/g, ""))
      .filter(Boolean);

    const hasUrlSecret = tags.includes("url-secret");

    // 路径匹配需要用实例化的 key 测试（替换 * 为具体名称）
    const instanceKey = key.replace(/\*\./g, "testprofile.");
    const pathCovered = isSensitiveUrlConfigPath(instanceKey);

    // 两种机制都没覆盖 → 违规
    if (!hasUrlSecret && !pathCovered) {
      violations.push({ key, tags });
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error(
    [
      "URL config fields missing redact coverage (no url-secret tag AND no path match in isSensitiveUrlConfigPath).",
      "",
      "Each URL config field that may contain credentials must be covered by either:",
      "  1. A path suffix rule in isSensitiveUrlConfigPath() (src/shared/net/redact-sensitive-url.ts), OR",
      '  2. A "url-secret" tag in schema.base.generated.ts',
      "",
      "If the field cannot contain credentials (e.g. allowlist, boolean flags), add it to",
      "SAFE_URL_PATTERNS in this script.",
      "",
      "Uncovered fields:",
    ].join("\n"),
  );

  for (const v of violations) {
    console.error(`- ${v.key}  tags: [${v.tags.join(", ")}]`);
  }

  console.error(
    [
      "",
      "See: my_docs/04-cases/2026-04-18-config-read-write-dual-path/00-README.md",
    ].join("\n"),
  );

  process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
