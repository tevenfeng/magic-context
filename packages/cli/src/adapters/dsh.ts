/**
 * DshAdapter — Magic Context for DeepSeek Harness.
 *
 * Registration model (verified against dsh 0.1.0-rc.6):
 *   1. The profile directory holds a `package.json` whose
 *      `dsh.profile.bundles` list names the bundle packages (entry order is
 *      the patch-layer order; dsh resolves in-box bundles from its own
 *      installation first, then from the profile's node_modules).
 *   2. The plugin package ships its own `cordis.patch.yml` (insert-style) and
 *      declares `dsh.bundle.patch` — adding it to `bundles` inserts its
 *      `mc-compaction` entry.
 *   3. The profile's `cordis.patch.yml` disables the default compaction
 *      bundle entry (`compaction-basic`) and carries the runtime config.
 *   4. `dsh plugin --profile <name> add <pkg>` forwards pnpm into the
 *      profile directory (installs the package into its node_modules).
 *
 * The patch file is edited textually (list-append for absent entries) to
 * preserve any user comments; malformed manifests are never overwritten.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
    DSH_BASE_BUNDLES,
    DSH_COMPACTION_ENTRY_ID,
    DSH_DEFAULT_COMPACTION_BUNDLE,
    DSH_MC_ENTRY_ID,
    DSH_PLUGIN_PACKAGE,
    getDshMagicContextConfigPath,
    getDshManifestPath,
    getDshPatchPath,
    getDshPluginPackagePath,
    getDshProfileDir,
    getDshProfileName,
} from "../lib/dsh-paths";
import { findOnPath } from "../lib/find-on-path";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

interface DshManifest {
    dsh?: {
        profile?: {
            bundles?: unknown;
        };
    };
    dependencies?: Record<string, unknown>;
}

export interface DshAdapterOptions {
    /** Injectable command runner (tests); defaults to spawnSync. */
    runCommand?: (bin: string, args: string[]) => { status: number | null; stderr?: string };
}

export class DshAdapter implements HarnessAdapter {
    readonly kind = "dsh" as const;
    readonly displayName = "DeepSeek Harness (DSH)";
    readonly pluginPackageName = DSH_PLUGIN_PACKAGE;

    private readonly runCommand;

    constructor(options: DshAdapterOptions = {}) {
        this.runCommand =
            options.runCommand ?? ((bin, args) => spawnSync(bin, args, { encoding: "utf8" }));
    }

    isInstalled(): boolean {
        return findOnPath("dsh") !== null;
    }

    hasPluginEntry(): boolean {
        const read = readManifest();
        if (read.status !== "ok") return false;
        return bundlesOf(read.manifest as DshManifest).includes(DSH_PLUGIN_PACKAGE);
    }

    getConfigPaths(): HarnessConfigPaths {
        return {
            configDir: getDshProfileDir(),
            pluginConfigPath: getDshManifestPath(),
            magicContextConfigPath: getDshMagicContextConfigPath(),
            secondaryConfigPath: getDshPatchPath(),
        };
    }

    async ensurePluginEntry(): Promise<PluginEntryResult> {
        const manifestPath = getDshManifestPath();
        const patchPath = getDshPatchPath();
        const profileDir = getDshProfileDir();
        const profileName = getDshProfileName();

        // 1. Profile manifest: create when missing, then append the bundle.
        let manifest: DshManifest;
        const read = readManifest();
        if (read.status === "malformed") {
            return {
                ok: false,
                action: "error",
                message: `Refusing to overwrite unparseable profile manifest at ${manifestPath} — fix it manually first`,
                configPath: manifestPath,
            };
        }
        if (read.status === "missing") {
            mkdirSync(profileDir, { recursive: true });
            manifest = { dsh: { profile: { bundles: [...DSH_BASE_BUNDLES] } } };
        } else {
            manifest = read.manifest as DshManifest;
        }
        if (manifest.dsh?.profile === undefined) manifest.dsh = { profile: { bundles: [] } };
        const bundles = bundlesOf(manifest);
        if (!bundles.includes(DSH_PLUGIN_PACKAGE)) {
            bundles.push(DSH_PLUGIN_PACKAGE);
            // bundlesOf returns a filtered copy — write it back to the manifest.
            (manifest.dsh as { profile: { bundles: unknown } }).profile.bundles = bundles;
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
        }

        // 2. Profile patch layer: disable the default compaction engine and
        //    keep the runtime config (textual append preserves user comments).
        ensurePatchEntries(patchPath);

        // 3. Install the plugin into the profile (pnpm via dsh plugin).
        if (this.isInstalled() && !existsSync(getDshPluginPackagePath())) {
            const result = this.runCommand("dsh", [
                "plugin",
                "--profile",
                profileName,
                "add",
                DSH_PLUGIN_PACKAGE,
            ]);
            if ((result.status ?? 1) !== 0) {
                return {
                    ok: false,
                    action: "error",
                    message:
                        `dsh plugin add failed (${result.status}): ${result.stderr ?? ""}`.trim() +
                        ` — the bundle is registered but not installed; run \`dsh plugin --profile ${profileName} add ${DSH_PLUGIN_PACKAGE}\` manually`,
                    configPath: manifestPath,
                };
            }
        }

        return {
            ok: true,
            action: "added",
            message: `Registered ${DSH_PLUGIN_PACKAGE} in the "${profileName}" profile and disabled the default compaction engine`,
            configPath: manifestPath,
        };
    }

    async removePluginEntry(): Promise<PluginEntryResult> {
        const manifestPath = getDshManifestPath();
        const read = readManifest();
        if (read.status !== "ok") {
            return {
                ok: false,
                action: "error",
                message: "No DSH profile manifest to edit",
                configPath: manifestPath,
            };
        }
        const manifest = read.manifest as DshManifest;
        const bundles = bundlesOf(manifest);
        const idx = bundles.indexOf(DSH_PLUGIN_PACKAGE);
        if (idx === -1) {
            return {
                ok: true,
                action: "already_present",
                message: "Plugin bundle not registered",
                configPath: manifestPath,
            };
        }
        bundles.splice(idx, 1);
        (manifest.dsh as { profile: { bundles: unknown } }).profile.bundles = bundles;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
        return {
            ok: true,
            action: "updated",
            message: `Removed ${DSH_PLUGIN_PACKAGE} from the profile bundles`,
            configPath: manifestPath,
        };
    }

    getInstallHint(): string {
        return "Install the DeepSeek Harness CLI first: npm install -g @deepseek-ai/dsh (or the official install script), then re-run this command.";
    }

    getPluginCacheInfo(): PluginCacheInfo {
        const path = getDshPluginPackagePath();
        return {
            path: existsSync(path) ? path : null,
            exists: existsSync(path),
            sizeBytes: existsSync(path) ? Buffer.byteLength(readFileSync(path, "utf8")) : 0,
        };
    }

    getLogPath(): string {
        return getDshMagicContextConfigPath();
    }

    getInstalledPluginVersion(): string | null {
        const path = getDshPluginPackagePath();
        if (!existsSync(path)) return null;
        try {
            const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
            return typeof pkg.version === "string" ? pkg.version : null;
        } catch {
            return null;
        }
    }

    /** Whether the default compaction engine is disabled in the patch layer. */
    isDefaultCompactionDisabled(): boolean {
        return patchHasEntry(getDshPatchPath(), DSH_COMPACTION_ENTRY_ID, true);
    }

    /** Whether the mc-compaction entry is configured in the patch layer. */
    hasMcCompactionEntry(): boolean {
        return patchHasEntry(getDshPatchPath(), DSH_MC_ENTRY_ID, false);
    }
}

function readManifest(): { status: "missing" | "malformed" | "ok"; manifest?: DshManifest } {
    const path = getDshManifestPath();
    if (!existsSync(path)) return { status: "missing" };
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as DshManifest;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return { status: "malformed" };
        }
        return { status: "ok", manifest: parsed };
    } catch {
        return { status: "malformed" };
    }
}

function bundlesOf(manifest: DshManifest): string[] {
    const raw = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === "string");
}

/** Textual patch editing: append missing list entries, never rewrite existing text. */
function ensurePatchEntries(patchPath: string): void {
    let text = existsSync(patchPath)
        ? readFileSync(patchPath, "utf8")
        : "# Magic Context patch layer\n";
    const append: string[] = [];
    if (!patchHasEntry(patchPath, DSH_COMPACTION_ENTRY_ID, true)) {
        append.push(
            `\n# Magic Context: replace the default compaction engine\n- id: ${DSH_COMPACTION_ENTRY_ID}\n  name: '${DSH_DEFAULT_COMPACTION_BUNDLE}'\n  disabled: true\n`,
        );
    }
    if (!patchHasEntry(patchPath, DSH_MC_ENTRY_ID, false)) {
        append.push(
            `\n# Magic Context engine config (historian.model may come from .cortexkit/magic-context.jsonc)\n- id: ${DSH_MC_ENTRY_ID}\n  config:\n    auto: true\n    maxTokens: 8192\n    thresholdRatio: 0.8\n    retainRatio: 0.16\n`,
        );
    }
    if (append.length > 0) {
        if (text.length > 0 && !text.endsWith("\n")) text += "\n";
        writeFileSync(patchPath, `${text}${append.join("")}`);
    }
}

function patchHasEntry(patchPath: string, entryId: string, disabledOnly: boolean): boolean {
    if (!existsSync(patchPath)) return false;
    const lines = readFileSync(patchPath, "utf8").split("\n");
    let inside = false;
    let hasDisabled = false;
    for (const line of lines) {
        if (/^- id: /.test(line)) {
            if (inside) break;
            if (line.trim() === `- id: ${entryId}`) inside = true;
            continue;
        }
        if (inside && /^\s*disabled:\s*true/.test(line)) hasDisabled = true;
    }
    if (!inside) return false;
    return disabledOnly ? hasDisabled : true;
}
