/**
 * Path resolution for the DeepSeek Harness (DSH) adapter.
 *
 * DSH state lives under `$DSH_HOME` (default `~/.dsh`); profiles are
 * directories under `$DSH_HOME/profiles/<name>` holding a `package.json`
 * (the profile manifest with `dsh.profile.bundles`), a `cordis.patch.yml`
 * (the user patch layer), and the profile's `node_modules` (managed through
 * `dsh plugin --profile <name> <pnpm args>`).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const DSH_PLUGIN_PACKAGE = "@cortexkit/dsh-magic-context";
export const DSH_DEFAULT_COMPACTION_BUNDLE = "@deepseek-ai/dsh-compaction-basic";
export const DSH_COMPACTION_ENTRY_ID = "compaction-basic";
export const DSH_MC_ENTRY_ID = "mc-compaction";
/** Base bundles for a fresh DSH profile (mirrors the shipped headless template). */
export const DSH_BASE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"];

export function getDshHome(): string {
    return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

export function getDshProfileName(): string {
    return process.env.MC_DSH_PROFILE ?? "web";
}

export function getDshProfilesDir(): string {
    return join(getDshHome(), "profiles");
}

export function getDshProfileDir(): string {
    return join(getDshProfilesDir(), getDshProfileName());
}

export function getDshManifestPath(): string {
    return join(getDshProfileDir(), "package.json");
}

export function getDshPatchPath(): string {
    return join(getDshProfileDir(), "cordis.patch.yml");
}

export function getDshPluginPackagePath(): string {
    return join(getDshProfileDir(), "node_modules", DSH_PLUGIN_PACKAGE, "package.json");
}

export function getDshMagicContextConfigPath(): string {
    return join(process.cwd(), ".cortexkit", "magic-context.jsonc");
}
