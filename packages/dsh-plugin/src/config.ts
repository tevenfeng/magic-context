/**
 * POC config resolution for the DSH Magic Context plugin.
 *
 * Priority order (highest wins):
 *   1. The bundle entry's own config (cordis.patch.yml / profile layer)
 *   2. `.cortexkit/magic-context.jsonc` (project level) — `historian.model`
 *   3. Built-in defaults (BasicCompactionEngine defaults apply beyond these)
 *
 * The project-level file shares the OpenCode/Pi config surface, so a project
 * that already configures `historian.model` for another harness works here
 * unchanged.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

export interface DshMcConfig {
    auto: boolean;
    /** Both set -> wins the summarization target. */
    summarizationProvider?: string;
    summarizationModel?: string;
    maxTokens?: number;
    /** Basic policy passthrough (validated by BasicCompactionEngine). */
    thresholdRatio?: number;
    retainRatio?: number;
    retainTokens?: number;
}

interface EntryConfig {
    auto?: unknown;
    summarizationProvider?: unknown;
    summarizationModel?: unknown;
    maxTokens?: unknown;
    thresholdRatio?: unknown;
    retainRatio?: unknown;
    retainTokens?: unknown;
}

function readJsoncFile(path: string): Record<string, unknown> | undefined {
    if (!existsSync(path)) return undefined;
    const errors: ParseError[] = [];
    const value = parseJsonc(readFileSync(path, "utf8"), errors, {
        allowTrailingComma: true,
    });
    if (errors.length > 0) {
        console.warn(
            `[mc-dsh] failed to parse ${path}: ${errors.map((e) => printParseErrorCode(e.error)).join(", ")}`,
        );
        return undefined;
    }
    return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
}

/** "provider/model" -> { provider, model }; undefined when malformed. */
function splitModel(model: string): { provider: string; model: string } | undefined {
    const idx = model.indexOf("/");
    if (idx <= 0 || idx === model.length - 1) return undefined;
    return { provider: model.slice(0, idx), model: model.slice(idx + 1) };
}

export function resolveConfig(entry: unknown = {}): DshMcConfig {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as EntryConfig;

    const projectConfig = readJsoncFile(resolve(process.cwd(), ".cortexkit/magic-context.jsonc"));
    const homeConfig = readJsoncFile(
        join(process.env.HOME ?? "", ".config/cortexkit/magic-context.jsonc"),
    );
    const historian = (projectConfig?.historian ?? homeConfig?.historian) as
        | { model?: unknown; maxTokens?: unknown }
        | undefined;
    const historianModel =
        typeof historian?.model === "string" ? splitModel(historian.model) : undefined;
    const historianMaxTokens =
        typeof historian?.maxTokens === "number" ? historian.maxTokens : undefined;

    const summarizationProvider =
        (typeof e.summarizationProvider === "string" && e.summarizationProvider.length > 0
            ? e.summarizationProvider
            : historianModel?.provider) ?? "";
    const summarizationModel =
        (typeof e.summarizationModel === "string" && e.summarizationModel.length > 0
            ? e.summarizationModel
            : historianModel?.model) ?? "";

    if (summarizationProvider.length === 0) {
        console.warn(
            "[mc-dsh] no historian model configured (bundle config or .cortexkit/magic-context.jsonc historian.model); the session's routed model will be used for summarization",
        );
    }

    return {
        auto: typeof e.auto === "boolean" ? e.auto : true,
        summarizationProvider,
        summarizationModel,
        maxTokens: typeof e.maxTokens === "number" ? e.maxTokens : (historianMaxTokens ?? 8192),
        ...(typeof e.thresholdRatio === "number" ? { thresholdRatio: e.thresholdRatio } : {}),
        ...(typeof e.retainRatio === "number" ? { retainRatio: e.retainRatio } : {}),
        ...(typeof e.retainTokens === "number" ? { retainTokens: e.retainTokens } : {}),
    };
}
