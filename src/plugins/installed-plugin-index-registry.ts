// Builds plugin registry inputs from installed plugin index records.
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  discoverOpenClawPlugins,
  type PluginCandidate,
  type PluginDiscoveryResult,
} from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader.js";
import type { LoadInstalledPluginIndexParams } from "./installed-plugin-index-types.js";
import { loadPluginManifestRegistry, type PluginManifestRegistry } from "./manifest-registry.js";
import { mergePortablePluginInstallRecords } from "./portable-plugin-install-records.js";

function loadInstallRecords(
  params: LoadInstalledPluginIndexParams,
): Record<string, PluginInstallRecord> {
  return loadInstalledPluginIndexInstallRecordsSync({
    env: params.env,
    ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    ...(params.pluginIndexFilePath ? { filePath: params.pluginIndexFilePath } : {}),
  });
}

function resolveInstallRecordsForCandidates(params: {
  candidates: readonly PluginCandidate[];
  loadParams: LoadInstalledPluginIndexParams;
}): Record<string, PluginInstallRecord> {
  const explicit = params.loadParams.installRecords;
  if (explicit) {
    return explicit;
  }
  return mergePortablePluginInstallRecords({
    baseRecords: loadInstallRecords(params.loadParams),
    candidates: params.candidates,
    env: params.loadParams.env,
  });
}

/** Resolves discovery candidates and manifest registry for installed plugin index loading. */
export function resolveInstalledPluginIndexRegistry(params: LoadInstalledPluginIndexParams): {
  registry: PluginManifestRegistry;
  candidates: readonly PluginCandidate[];
  discovery?: PluginDiscoveryResult;
  installRecords: Record<string, PluginInstallRecord>;
} {
  if (params.candidates) {
    const installRecords = resolveInstallRecordsForCandidates({
      candidates: params.candidates,
      loadParams: params,
    });
    return {
      candidates: params.candidates,
      installRecords,
      registry: loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        candidates: params.candidates,
        diagnostics: params.diagnostics,
        installRecords,
      }),
    };
  }

  const normalized = normalizePluginsConfig(params.config?.plugins);
  const persistedInstallRecords = params.installRecords ?? loadInstallRecords(params);
  const discovery =
    params.discovery ??
    discoverOpenClawPlugins({
      workspaceDir: params.workspaceDir,
      extraPaths: normalized.loadPaths,
      env: params.env,
      installRecords: persistedInstallRecords,
    });
  const installRecords = params.installRecords
    ? params.installRecords
    : mergePortablePluginInstallRecords({
        baseRecords: persistedInstallRecords,
        candidates: discovery.candidates,
        env: params.env,
      });
  return {
    candidates: discovery.candidates,
    discovery,
    installRecords,
    registry: loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
      installRecords,
    }),
  };
}
