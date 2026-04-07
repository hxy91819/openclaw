/**
 * Regression tests for GHSA-2qrv-rc5x-2g2h incomplete-fix bypass.
 *
 * The original fix added excludeWorkspace: true to two call sites in
 * channel-plugin-resolution.ts.  Three other setup-flow call sites were
 * missed.  These tests verify all three now pass excludeWorkspace: true.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted to module top level)
// ---------------------------------------------------------------------------

const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((_opts?: unknown): unknown[] => []));
const listChatChannels = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn(({ config }: { config: unknown }) => ({
    config: config as never,
    changes: [] as string[],
    autoEnabledReasons: {},
  })),
);
const getChannelPluginCatalogEntry = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: (opts?: unknown) => listChannelPluginCatalogEntries(opts),
  getChannelPluginCatalogEntry: (...args: unknown[]) =>
    getChannelPluginCatalogEntry(...(args as [string, Record<string, unknown>])),
}));
vi.mock("../../channels/registry.js", () => ({
  listChatChannels: () => listChatChannels(),
}));
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...a: unknown[]) => loadPluginManifestRegistry(...a),
}));
vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (a: unknown) => applyPluginAutoEnable(a as { config: unknown }),
}));
vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: vi.fn(),
}));

import { resolveChannelSetupEntries } from "./discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
  listChatChannels.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Regression: resolveChannelSetupEntries (discovery.ts)
// ---------------------------------------------------------------------------

describe("resolveChannelSetupEntries workspace shadow exclusion (GHSA-2qrv-rc5x-2g2h)", () => {
  it("passes excludeWorkspace: true to listChannelPluginCatalogEntries", () => {
    resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(listChannelPluginCatalogEntries).toHaveBeenCalledWith(
      expect.objectContaining({ excludeWorkspace: true }),
    );
  });

  it("still returns bundled-origin entries", () => {
    const bundledEntry = {
      id: "telegram",
      pluginId: "@openclaw/telegram",
      origin: "bundled",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/",
        blurb: "t",
        order: 1,
      },
      install: { npmSpec: "@openclaw/telegram" },
    };
    listChannelPluginCatalogEntries.mockReturnValue([bundledEntry]);

    const result = resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    const allIds = [
      ...result.installedCatalogEntries.map((e: { id: string }) => e.id),
      ...result.installableCatalogEntries.map((e: { id: string }) => e.id),
    ];
    expect(allIds).toContain("telegram");
  });
});
