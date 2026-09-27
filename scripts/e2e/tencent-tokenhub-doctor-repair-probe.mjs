// Probe verifying Tencent TokenHub doctor/config repair across upgrade scenarios.
// Covers the same migration path as
// `src/commands/doctor/shared/legacy-config-core-migrate.ts` calling
// `runPluginSetupConfigMigrations` (which dispatches to the Tencent plugin's
// `normalizeCompatibilityConfig`), plus `buildModelsProviderData` for model
// selection consistency. Run inside the OpenClaw Docker E2E image so dist
// bundles resolve against the installed package.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "..", "dist");

const setupRegistryUrl = path.join(distDir, "setup-registry-Dax2vE4Y.js");
const commandsModelsUrl = path.join(distDir, "commands-models-DMpPGi1n.js");

// dist bundles use minified export names; map them to the canonical symbols.
const setupRegistryMod = await import(setupRegistryUrl);
const runPluginSetupConfigMigrations = setupRegistryMod.o;
const commandsModelsMod = await import(commandsModelsUrl);
const buildModelsProviderData = commandsModelsMod.t;

const PRIMARY = "tencent-tokenhub/hy3";
const PREVIEW = "tencent-tokenhub/hy3-preview";
const BUNDLED_PLUGINS_DIR = path.resolve(here, "..", "..", "extensions");

const env = { ...process.env, OPENCLAW_BUNDLED_PLUGINS_DIR: BUNDLED_PLUGINS_DIR };

function modelsKeys(cfg) {
  return Object.keys(cfg.agents?.defaults?.models ?? {}).toSorted();
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${msg}`);
  }
}

const results = [];

// Scenario 1: old preview-only config -> repair promotes primary and keeps preview.
{
  const before = {
    agents: {
      defaults: {
        model: { primary: PREVIEW },
        models: { [PREVIEW]: {} },
      },
    },
  };
  const r = runPluginSetupConfigMigrations({ env, config: before });
  assert(r.changes.length === 2, `s1 changes=2 got ${r.changes.length}`);
  assert(r.config.agents.defaults.model.primary === PRIMARY, "s1 primary");
  assert(modelsKeys(r.config).join(",") === `${PRIMARY},${PREVIEW}`, "s1 models");
  assert(Object.hasOwn(r.config.agents.defaults.models, PREVIEW), "s1 preview kept");
  const idempotent = runPluginSetupConfigMigrations({ env, config: r.config });
  assert(idempotent.changes.length === 0, `s1 idempotent got ${idempotent.changes.length}`);
  results.push("scenario1: OK (preview->primary, both models, idempotent)");
}

// Scenario 2: intermediate hy3-only config -> repair adds preview.
{
  const before = {
    agents: {
      defaults: {
        model: PRIMARY,
        models: { [PRIMARY]: {} },
      },
    },
  };
  const r = runPluginSetupConfigMigrations({ env, config: before });
  assert(r.changes.length === 1, `s2 changes=1 got ${r.changes.length}`);
  assert(r.config.agents.defaults.model === PRIMARY, "s2 primary unchanged");
  assert(modelsKeys(r.config).join(",") === `${PRIMARY},${PREVIEW}`, "s2 models");
  const idempotent = runPluginSetupConfigMigrations({ env, config: r.config });
  assert(idempotent.changes.length === 0, `s2 idempotent got ${idempotent.changes.length}`);
  results.push("scenario2: OK (hy3-only->adds preview, idempotent)");
}

// Scenario 3: provider/env config but no agents.defaults.models -> no allowlist created.
{
  const before = {
    models: {
      providers: {
        "tencent-tokenhub": { baseUrl: "https://tokenhub.tencentmaas.com/v1", models: [] },
      },
    },
  };
  const r = runPluginSetupConfigMigrations({ env, config: before });
  assert(r.changes.length === 0, `s3 changes=0 got ${r.changes.length}`);
  assert(r.config.agents?.defaults?.models === undefined, "s3 no models created");
  results.push("scenario3: OK (no allowlist fabricated)");
}

// Scenario 4: already-repaired config -> no repeated changes.
{
  const before = {
    agents: {
      defaults: {
        model: { primary: PRIMARY },
        models: {
          [PRIMARY]: { alias: "Hy3 (TokenHub)" },
          [PREVIEW]: { alias: "Hy3 preview (TokenHub)" },
        },
      },
    },
  };
  const r = runPluginSetupConfigMigrations({ env, config: before });
  assert(r.changes.length === 0, `s4 changes=0 got ${r.changes.length}`);
  assert(modelsKeys(r.config).join(",") === `${PRIMARY},${PREVIEW}`, "s4 models unchanged");
  results.push("scenario4: OK (idempotent on repaired config)");
}

// Scenario 5: buildModelsProviderData on repaired config lists hy3 and hy3-preview
// under tencent-tokenhub without bypassing the allowlist.
{
  const repaired = runPluginSetupConfigMigrations({
    env,
    config: {
      agents: {
        defaults: {
          model: { primary: PREVIEW },
          models: { [PREVIEW]: {} },
        },
      },
    },
  }).config;
  const data = await buildModelsProviderData(repaired, undefined, { view: "all" });
  const tencentModels = data.byProvider.get("tencent-tokenhub");
  assert(tencentModels !== undefined, "s5 tencent-tokenhub provider present");
  assert(tencentModels.has("hy3"), "s5 hy3 present");
  assert(tencentModels.has("hy3-preview"), "s5 hy3-preview present");
  results.push(
    `scenario5: OK (tencent-tokenhub has hy3 and hy3-preview; models=[${[...tencentModels].toSorted()}])`,
  );
}

console.log("Tencent TokenHub doctor/config repair probe:");
for (const r of results) console.log(`  - ${r}`);
console.log("ALL SCENARIOS PASSED");
