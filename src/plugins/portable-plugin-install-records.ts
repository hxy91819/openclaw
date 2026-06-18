/** Reads immutable-image plugin install records outside the runtime state dir. */
import path from "node:path";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";
import type { PluginCandidate } from "./discovery.js";
import { readPersistedInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import { safeRealpathSync } from "./path-safety.js";

export const PORTABLE_PLUGIN_INSTALL_RECORDS_FILE_ENV =
  "OPENCLAW_PORTABLE_PLUGIN_INSTALL_RECORDS_FILE";

function resolvePortableRecordsFile(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env[PORTABLE_PLUGIN_INSTALL_RECORDS_FILE_ENV]?.trim();
  return raw ? resolveUserPath(raw, env) : undefined;
}

function installRecordPackageNames(record: PluginInstallRecord): string[] {
  const npmSpecName = record.spec ? parseRegistryNpmSpec(record.spec)?.name : undefined;
  const resolvedNpmSpecName = record.resolvedSpec
    ? parseRegistryNpmSpec(record.resolvedSpec)?.name
    : undefined;
  const clawHubSpecName = record.spec ? parseClawHubPluginSpec(record.spec)?.name : undefined;
  return [
    record.resolvedName,
    record.clawhubPackage,
    npmSpecName,
    resolvedNpmSpecName,
    clawHubSpecName,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function installRecordCouldDescribeCandidate(params: {
  pluginId: string;
  record: PluginInstallRecord;
  candidate: PluginCandidate;
}): boolean {
  const packageName = params.candidate.packageName?.trim();
  if (packageName) {
    return installRecordPackageNames(params.record).includes(packageName);
  }
  return params.candidate.idHint === params.pluginId;
}

function anchorPortableRecordToCandidate(params: {
  record: PluginInstallRecord;
  candidate: PluginCandidate;
  env: NodeJS.ProcessEnv;
}): PluginInstallRecord {
  const packageRoot = resolveUserPath(
    params.candidate.packageDir ?? params.candidate.rootDir,
    params.env,
  );
  const installPath = safeRealpathSync(packageRoot) ?? path.resolve(packageRoot);
  return {
    ...params.record,
    // Portable records come from an image-level install index, but the package
    // may be copied to a different runtime path. Anchor path proof to discovery.
    installPath,
    sourcePath: installPath,
  };
}

function loadPortableRecords(env: NodeJS.ProcessEnv): Record<string, PluginInstallRecord> {
  const filePath = resolvePortableRecordsFile(env);
  if (!filePath) {
    return {};
  }
  return readPersistedInstalledPluginIndexInstallRecordsSync({ env, filePath }) ?? {};
}

export function mergePortablePluginInstallRecords(params: {
  baseRecords: Record<string, PluginInstallRecord>;
  candidates: readonly PluginCandidate[];
  env?: NodeJS.ProcessEnv;
}): Record<string, PluginInstallRecord> {
  const env = params.env ?? process.env;
  const portableRecords = loadPortableRecords(env);
  if (Object.keys(portableRecords).length === 0) {
    return params.baseRecords;
  }
  const merged: Record<string, PluginInstallRecord> = { ...params.baseRecords };
  for (const candidate of params.candidates) {
    if (candidate.origin !== "config" && candidate.origin !== "global") {
      continue;
    }
    for (const [pluginId, record] of Object.entries(portableRecords)) {
      if (!installRecordCouldDescribeCandidate({ pluginId, record, candidate })) {
        continue;
      }
      merged[pluginId] = anchorPortableRecordToCandidate({ record, candidate, env });
    }
  }
  return merged;
}
