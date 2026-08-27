/**
 * Magic Context bundle entry for DeepSeek Harness.
 *
 * The bundle is a plain Cordis plugin object: it constructs the
 * CompartmentEngine (which self-registers as the `ctx.compaction` service,
 * replacing the default engine when the profile disables compaction-basic).
 */
import type { Context } from "@deepseek-ai/cordis";
import { type DshMcConfig, resolveConfig } from "./config";
import { CompartmentEngine } from "./engine";

export { CompartmentEngine } from "./engine";
export {
    buildSpanInput,
    inputFingerprint,
    type SpanInput,
    type SpanRange,
    selectRange,
} from "./historian";
export {
    type CompartmentOutput,
    parseCompartmentOutput,
    renderCompartments,
} from "./parse";
export { McStore } from "./store";

const plugin = {
    inject: ["llm", "tokenMeter", "sessions"],
    apply(ctx: Context, entryConfig: unknown = {}) {
        const config: DshMcConfig = resolveConfig(entryConfig);
        new CompartmentEngine(ctx, config);
        ctx.logger.info(
            `[mc-dsh] engine mounted: auto=${config.auto} maxTokens=${config.maxTokens} threshold=${config.thresholdRatio ?? 0.8} summarizer=${config.summarizationProvider || "<routed>"}/${config.summarizationModel || ""}`,
        );
    },
};

export default plugin;
