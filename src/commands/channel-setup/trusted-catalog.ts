import {
  getChannelPluginCatalogEntry,
  listChannelPluginCatalogEntries,
  type ChannelPluginCatalogEntry,
} from "../../channels/plugins/catalog.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../../plugins/config-state.js";
import {
  hasExplicitManifestOwnerTrust,
  resolveManifestOwnerBasePolicyBlock,
} from "../../plugins/manifest-owner-policy.js";

const LOCAL_CHANNEL_PLUGIN_ORIGINS = new Set(["workspace", "config", "global"] as const);

function resolveEffectiveTrustConfig(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): OpenClawConfig {
  return applyPluginAutoEnable({
    config: cfg,
    env: env ?? process.env,
  }).config;
}

function resolveTrustedCatalogExtraPaths(cfg: OpenClawConfig): string[] | undefined {
  const extraPaths = normalizePluginsConfig(cfg.plugins).loadPaths;
  return extraPaths.length > 0 ? extraPaths : undefined;
}

function isTrustedLocalChannelCatalogEntry(
  entry: ChannelPluginCatalogEntry | undefined,
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): boolean {
  if (!entry?.origin || !LOCAL_CHANNEL_PLUGIN_ORIGINS.has(entry.origin)) {
    return true;
  }
  if (!entry.pluginId) {
    return false;
  }
  const effectiveConfig = resolveEffectiveTrustConfig(cfg, env);
  const normalizedPlugins = normalizePluginsConfig(effectiveConfig.plugins);
  if (
    resolveManifestOwnerBasePolicyBlock({
      plugin: { id: entry.pluginId },
      normalizedConfig: normalizedPlugins,
    }) !== null
  ) {
    return false;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: entry.pluginId,
    origin: entry.origin,
    config: normalizedPlugins,
    rootConfig: effectiveConfig,
  });
  return (
    hasExplicitManifestOwnerTrust({
      plugin: { id: entry.pluginId },
      normalizedConfig: normalizedPlugins,
    }) ||
    (entry.origin === "workspace" && activationState.source === "auto")
  );
}

function resolveRejectedCatalogLookup(
  rejected: ChannelPluginCatalogEntry[],
): Pick<
  Parameters<typeof getChannelPluginCatalogEntry>[1],
  "excludeOrigins" | "excludePluginRefs"
> {
  const excludePluginRefs = rejected.flatMap((entry) =>
    entry.pluginId?.trim()
      ? [
          {
            pluginId: entry.pluginId.trim(),
            ...(entry.origin ? { origin: entry.origin } : {}),
          },
        ]
      : [],
  );
  const excludeOrigins = rejected
    .filter(
      (entry) => LOCAL_CHANNEL_PLUGIN_ORIGINS.has(entry.origin ?? "bundled") && !entry.pluginId,
    )
    .map((entry) => entry.origin)
    .filter((value): value is "workspace" | "config" | "global" => Boolean(value));
  return {
    ...(excludeOrigins.length > 0 ? { excludeOrigins } : {}),
    ...(excludePluginRefs.length > 0 ? { excludePluginRefs } : {}),
  };
}

function resolveTrustedCatalogEntry(
  channelId: string,
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
  rejected: ChannelPluginCatalogEntry[] = [],
): ChannelPluginCatalogEntry | undefined {
  const extraPaths = resolveTrustedCatalogExtraPaths(params.cfg);
  const candidate = getChannelPluginCatalogEntry(channelId, {
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(extraPaths ? { extraPaths } : {}),
    ...resolveRejectedCatalogLookup(rejected),
  });
  if (!candidate) {
    return undefined;
  }
  if (isTrustedLocalChannelCatalogEntry(candidate, params.cfg, params.env)) {
    return candidate;
  }
  return resolveTrustedCatalogEntry(channelId, params, [...rejected, candidate]);
}

export function getTrustedChannelPluginCatalogEntry(
  channelId: string,
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
): ChannelPluginCatalogEntry | undefined {
  return resolveTrustedCatalogEntry(channelId, params);
}

function listChannelPluginCatalogEntriesWithTrustedFallback(
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  },
  onMissingFallback: (entry: ChannelPluginCatalogEntry) => ChannelPluginCatalogEntry[],
): ChannelPluginCatalogEntry[] {
  const extraPaths = resolveTrustedCatalogExtraPaths(params.cfg);
  const unfiltered = listChannelPluginCatalogEntries({
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(extraPaths ? { extraPaths } : {}),
  });
  return unfiltered.flatMap((entry) => {
    if (isTrustedLocalChannelCatalogEntry(entry, params.cfg, params.env)) {
      return [entry];
    }
    const fallback = resolveTrustedCatalogEntry(entry.id, params, [entry]);
    return fallback ? [fallback] : onMissingFallback(entry);
  });
}

export function listTrustedChannelPluginCatalogEntries(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry[] {
  return listChannelPluginCatalogEntriesWithTrustedFallback(params, () => []);
}

export function listSetupDiscoveryChannelPluginCatalogEntries(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ChannelPluginCatalogEntry[] {
  return listChannelPluginCatalogEntriesWithTrustedFallback(params, (entry) => [entry]);
}
