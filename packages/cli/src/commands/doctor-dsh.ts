/**
 * `doctor --harness dsh` — health-check the Magic Context DSH registration.
 *
 * Checks (and fixes where safe):
 *   1. `dsh` binary present (info-only — registration can exist without it).
 *   2. Profile manifest exists and lists the plugin bundle.
 *   3. Default compaction engine disabled in the profile patch layer
 *      (a duplicate engine would double-compact; fail-closed guidance).
 *   4. Plugin installed in the profile's node_modules + version.
 *   5. `historian.model` configured in the shared magic-context.jsonc.
 */

import { existsSync } from "node:fs";
import { DshAdapter } from "../adapters/dsh";
import {
    getDshMagicContextConfigPath,
    getDshManifestPath,
    getDshProfileName,
} from "../lib/dsh-paths";
import { readJsoncConfig } from "../lib/jsonc-config";
import { log } from "../lib/prompts";

export async function runDshDoctor(_options: Record<string, unknown> = {}): Promise<number> {
    const adapter = new DshAdapter();
    const profileName = getDshProfileName();
    const manifestPath = getDshManifestPath();
    let failures = 0;

    log.step(`Checking DeepSeek Harness registration (profile "${profileName}")…`);

    // 1. Host binary.
    if (adapter.isInstalled()) {
        log.success("dsh CLI found on PATH.");
    } else {
        log.warn(
            "dsh CLI not found on PATH — install it to run the harness (see `magic-context setup --harness dsh` hints).",
        );
    }

    // 2. Manifest + bundle.
    if (!existsSync(manifestPath)) {
        log.error(
            `No profile manifest at ${manifestPath}. Run \`npx @cortexkit/magic-context@latest setup --harness dsh\` to create it.`,
        );
        failures += 1;
    } else if (!adapter.hasPluginEntry()) {
        log.error(`The plugin bundle is missing from dsh.profile.bundles in ${manifestPath}.`);
        log.info(
            "Fix: run `npx @cortexkit/magic-context@latest setup --harness dsh` (or add the bundle manually).",
        );
        failures += 1;
    } else {
        log.success(`Plugin bundle registered in ${manifestPath}.`);
    }

    // 3. Default compaction engine conflict.
    if (adapter.isDefaultCompactionDisabled()) {
        log.success(
            "Default compaction engine (compaction-basic) disabled — no double-compaction.",
        );
    } else if (adapter.hasPluginEntry()) {
        log.error(
            "The default compaction engine is still enabled. Two context managers would double-compress history.",
        );
        log.info(
            "Fix: disable the compaction-basic entry in the profile's cordis.patch.yml, or re-run setup.",
        );
        failures += 1;
    } else {
        log.info("compaction-basic state unknown (plugin not yet registered).");
    }

    // 4. Installed version.
    const version = adapter.getInstalledPluginVersion();
    if (version === null) {
        log.warn(
            `Plugin package not found in the profile's node_modules. Run \`dsh plugin --profile ${profileName} add @cortexkit/dsh-magic-context\`.`,
        );
    } else {
        log.success(`Plugin installed (version ${version}).`);
    }

    // 5. historian.model.
    const configPath = getDshMagicContextConfigPath();
    if (existsSync(configPath)) {
        const config = readJsoncConfig(configPath);
        const model = (config as { historian?: { model?: unknown } })?.historian?.model;
        if (typeof model === "string" && model.length > 0) {
            log.success(`historian.model is set (${model}).`);
        } else {
            log.warn(
                `historian.model is not set in ${configPath}; the engine falls back to the session's routed model.`,
            );
        }
    } else {
        log.warn(`No ${configPath}; the engine falls back to the session's routed model.`);
    }

    if (failures > 0) {
        log.error(`DSH doctor found ${failures} issue(s) to fix.`);
        return 1;
    }
    log.success("DSH registration looks healthy.");
    return 0;
}
