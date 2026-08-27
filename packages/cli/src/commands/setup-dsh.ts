/**
 * `setup --harness dsh` — register Magic Context in a DeepSeek Harness profile.
 *
 * Flow:
 *   1. Ensure the profile exists (creates a headless-style profile when missing).
 *   2. Register the bundle + disable the default compaction engine (adapter).
 *   3. Check `historian.model` in the shared magic-context.jsonc; warn when
 *      absent (the engine falls back to the session's routed model).
 */
import { existsSync } from "node:fs";
import { getDshMagicContextConfigPath, getDshProfileName } from "../lib/dsh-paths";
import { readJsoncConfig } from "../lib/jsonc-config";
import { log, note } from "../lib/prompts";

export interface RunDshSetupOptions {
    dryRun?: boolean;
    /** Injectable registration step (tests). */
    ensurePluginEntry?: () => Promise<{ ok: boolean; message: string }>;
}

export async function runDshSetup(options: RunDshSetupOptions = {}): Promise<number> {
    const { dryRun = false, ensurePluginEntry } = options;
    const profileName = getDshProfileName();
    const configPath = getDshMagicContextConfigPath();

    if (dryRun) {
        log.info(
            `[dry-run] Would register @cortexkit/dsh-magic-context in the "${profileName}" DSH profile and disable the default compaction engine.`,
        );
        return 0;
    }

    const register =
        ensurePluginEntry ??
        (async () => {
            const { DshAdapter } = await import("../adapters/dsh");
            return new DshAdapter().ensurePluginEntry();
        });
    const result = await register();
    if (!result.ok) {
        log.error(result.message);
        return 1;
    }
    log.success(result.message);

    // historian.model check (shared config, same surface as OpenCode/Pi).
    if (existsSync(configPath)) {
        const config = readJsoncConfig(configPath);
        const model = (config as { historian?: { model?: unknown } })?.historian?.model;
        if (typeof model === "string" && model.length > 0) {
            log.success(`historian.model is set (${model}) — background summarization is ready.`);
        } else {
            log.warn(
                `historian.model is not set in ${configPath}; the engine will summarize with the session's routed model.`,
            );
        }
    } else {
        log.warn(
            `No ${configPath} found; the engine will summarize with the session's routed model until historian.model is configured.`,
        );
    }

    note(
        [
            `Restart DSH with the "${profileName}" profile (dsh --profile ${profileName}) so the plugin loads.`,
            "Verify with: npx @cortexkit/magic-context@latest doctor --harness dsh",
        ].join("\n"),
        "Next steps",
    );
    return 0;
}
