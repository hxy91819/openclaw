import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn((_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace"),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn((_cfg?: unknown) => "default"));
const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((_opts?: unknown): unknown[] => []));
const getChannelSetupPlugin = vi.hoisted(() => vi.fn((_channel?: unknown) => undefined));
const listChannelSetupPlugins = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadChannelSetupPluginRegistrySnapshotForChannel = vi.hoisted(() =>
  vi.fn((_params?: unknown) => ({ channels: [], channelSetups: [] })),
);
const collectChannelStatus = vi.hoisted(() =>
  vi.fn(async (_params?: unknown) => ({
    installedPlugins: [],
    catalogEntries: [],
    installedCatalogEntries: [],
    statusByChannel: new Map(),
    statusLines: [],
  })),
);
const isChannelConfigured = vi.hoisted(() => vi.fn((_cfg?: unknown, _channel?: unknown) => true));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (cfg?: unknown, agentId?: unknown) =>
    resolveAgentWorkspaceDir(cfg, agentId),
  resolveDefaultAgentId: (cfg?: unknown) => resolveDefaultAgentId(cfg),
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: (opts?: unknown) => listChannelPluginCatalogEntries(opts),
}));

vi.mock("../channels/plugins/setup-registry.js", () => ({
  getChannelSetupPlugin: (channel?: unknown) => getChannelSetupPlugin(channel),
  listChannelSetupPlugins: () => listChannelSetupPlugins(),
}));

vi.mock("../channels/registry.js", () => ({
  listChatChannels: () => [],
}));

vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries: vi.fn(),
  shouldShowChannelInSetup: () => true,
}));

vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: (params?: unknown) =>
    loadChannelSetupPluginRegistrySnapshotForChannel(params),
}));

vi.mock("../commands/channel-setup/registry.js", () => ({
  resolveChannelSetupWizardAdapterForPlugin: () => undefined,
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: (cfg?: unknown, channel?: unknown) => isChannelConfigured(cfg, channel),
}));

vi.mock("./channel-setup.prompts.js", () => ({
  maybeConfigureDmPolicies: vi.fn(),
  promptConfiguredAction: vi.fn(),
  promptRemovalAccountId: vi.fn(),
  formatAccountLabel: vi.fn(),
}));

vi.mock("./channel-setup.status.js", () => ({
  collectChannelStatus: (params?: unknown) => collectChannelStatus(params),
  noteChannelPrimer: vi.fn(),
  noteChannelStatus: vi.fn(),
  resolveChannelSelectionNoteLines: vi.fn(() => []),
  resolveChannelSetupSelectionContributions: vi.fn(() => []),
  resolveQuickstartDefault: vi.fn(() => undefined),
}));

import { setupChannels } from "./channel-setup.js";

describe("setupChannels workspace shadow exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    resolveDefaultAgentId.mockReturnValue("default");
    listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "telegram",
        pluginId: "@openclaw/telegram-plugin",
      },
    ]);
    getChannelSetupPlugin.mockReturnValue(undefined);
    listChannelSetupPlugins.mockReturnValue([]);
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [],
      channelSetups: [],
    });
    collectChannelStatus.mockResolvedValue({
      installedPlugins: [],
      catalogEntries: [],
      installedCatalogEntries: [],
      statusByChannel: new Map(),
      statusLines: [],
    });
    isChannelConfigured.mockReturnValue(true);
  });

  it("preloads configured external plugins with excludeWorkspace: true", async () => {
    await setupChannels(
      {} as never,
      {} as never,
      {
        confirm: vi.fn(async () => false),
        note: vi.fn(async () => undefined),
      } as never,
    );

    expect(listChannelPluginCatalogEntries).toHaveBeenCalledWith({
      workspaceDir: "/tmp/openclaw-workspace",
      excludeWorkspace: true,
    });
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        pluginId: "@openclaw/telegram-plugin",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });
});
