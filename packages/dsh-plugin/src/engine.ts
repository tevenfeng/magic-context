/**
 * CompartmentEngine — Magic Context's compaction engine for DeepSeek Harness.
 *
 * Phase 2 (async historian / no pause): the pre-step path never waits on the
 * summarizer LLM.
 *
 * - `compactIfNeeded("pressure")` replicates Basic's pricing with public APIs,
 *   selects the compactable range, and either (a) commits a ready background
 *   publish through the inherited durable `compactRegion` machinery, or
 *   (b) spawns a background historian run and returns `null` — the step loop
 *   proceeds immediately.
 * - `summarize()` serves the cached result when the commit-time span matches
 *   the frozen span fingerprint (byte-identical to what the background run
 *   summarized); otherwise it throws a NotReady sentinel, which fails the
 *   compaction open. On `context-overflow` (inlineMode) it still runs the
 *   summarizer inline: a real overflow may take one pause, matching the
 *   OpenCode emergency-bypass policy.
 *
 * Durable replacement, replay, compaction markers, tool pairing, and overflow
 * retry semantics remain inherited from BasicCompactionEngine.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { CompactionResult } from "@deepseek-ai/dsh-compaction";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import {
    BlockAssembler,
    type ContentBlock,
    contentHasImage,
    createUserMessage,
    freezeMessage,
    LlmError,
    type Message,
    type TokenUsage,
    type ToolSchema,
} from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import { deriveEventMessage, type SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-tools";
import { computeBudgetPressure, renderedTier } from "./decay";
import {
    buildSpanInput,
    debugLog,
    HistorianRunner,
    inputFingerprint,
    selectRange,
} from "./historian";
import { parseCompartmentOutput, renderCompartments } from "./parse";
import { estimateMessageTokens, mcBreakdownProjection } from "./projection";
import { COMPARTMENT_INSTRUCTION } from "./prompt";
import {
    CTX_REDUCE_GUIDANCE,
    dropPlaceholder,
    enrichWithMarker,
    executeCtxReduce,
    firstMarkerTag,
} from "./reduce";
import { McStore } from "./store";

/** Structural mirror of the basic package's SummarizationInput (not re-exported). */
interface SummarizationInput {
    readonly system?: string;
    readonly tools?: readonly ToolSchema[];
    readonly messages: readonly Message[];
}

/** Structural mirror of the basic package's SummaryResult first union arm. */
export interface SummaryResult {
    summary: ContentBlock[];
    provider: string;
    model: string;
    maxTokens?: number;
    usage?: TokenUsage;
    rawOutput: ContentBlock[];
    llmStreamCall: true;
}

export interface CompartmentRecord {
    start: number;
    end: number;
    title: string;
    episodeType: string;
    importance: number;
    p1: string;
    p2: string;
    p3: string;
    p4: string;
    facts: Record<string, string[]>;
}

const PLUGIN_SOURCE = { kind: "plugin", plugin: "mc-magic-context" } as const;

class NotReadyError extends Error {
    constructor() {
        super("mc-dsh: async historian has no summary for this span yet");
        this.name = "NotReadyError";
    }
}

function finishFailure(finish: {
    kind: string;
    failure?: { code?: string; message?: string };
}): Error | undefined {
    switch (finish.kind) {
        case "error":
        case "aborted": {
            const error = new Error(
                finish.failure?.message ?? `summarization ended with ${finish.kind}`,
            );
            (error as Error & { code?: string }).code = finish.failure?.code;
            return error;
        }
        case "max-tokens": {
            const error = new Error(
                "summarization truncated at the token cap (incomplete checkpoint)",
            );
            (error as Error & { code?: string }).code = "MAX_TOKENS";
            return error;
        }
        default:
            return undefined;
    }
}

interface Target {
    provider: string;
    model: string;
}

export class CompartmentEngine extends BasicCompactionEngine {
    static inject = ["llm", "tokenMeter", "sessions"];

    private readonly store = new McStore();
    private readonly historian = new HistorianRunner(this.store);
    /** Set while an overflow recovery may run the summarizer inline. */
    private inlineMode = false;
    /** contextWindow cache per provider/model (windows are stable within a session). */
    private readonly contextWindowCache = new Map<string, number>();
    /** Pre-rendered decay replacements, keyed by `<sessionId>:<fingerprint>` (single fold pass). */
    private readonly decayOverrides = new Map<string, SummaryResult>();
    /** Max checkpoint demotions applied per fold pass (the rest ride later folds). */
    private static readonly MAX_DEMOTIONS_PER_PASS = 2;
    /** Max drop commits applied per fold pass (the rest ride later folds). */
    private static readonly MAX_DROPS_PER_PASS = 4;
    /** History budget for the decay pressure curve (OpenCode DEFAULT_HISTORY_BUDGET_TOKENS). */
    private static readonly HISTORY_BUDGET_TOKENS = 60_000;

    constructor(ctx: Context, config = {}) {
        super(ctx, config);
        this.ctx.effect(() => () => {
            this.historian.dispose();
            this.store.close();
        });
        this.registerReductionSurface(ctx);
        this.registerBreakdownProjection(ctx);
    }

    /** Register the mcBreakdown projection unit (optional service). */
    private registerBreakdownProjection(ctx: Context): void {
        const projections = ctx.get("sessionProjections") as
            | { register(definition: unknown): () => void }
            | undefined;
        projections?.register(mcBreakdownProjection);
        debugLog(`projection mcBreakdown registered: ${String(projections !== undefined)}`);
    }

    /** Debug the live projection snapshot (gated diagnostics). */
    private logBreakdownSnapshot(session: Session): void {
        try {
            const projections = this.ctx.get("sessionProjections") as
                | { snapshot(s: Session): { values?: Record<string, unknown> } }
                | undefined;
            const snapshot = projections?.snapshot(session);
            debugLog(
                `projection snapshot: ${JSON.stringify(snapshot?.values?.mcBreakdown ?? null)}`,
            );
        } catch (error) {
            debugLog(
                `projection snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /**
     * Agent-driven reduction surface: `[ctx §N§]` markers on tool outputs +
     * the `ctx_reduce` tool + drop queue. Optional — skipped when the tools
     * service is not mounted (compaction-only assemblies).
     */
    private registerReductionSurface(ctx: Context): void {
        const tools = ctx.get("tools") as
            | {
                  register(def: unknown): () => void;
              }
            | undefined;
        if (tools === undefined) return;

        // 1. Enrich every normalized tool result with its tag marker. The
        //    enriched content is the durable model-visible content.
        ctx.on("tools/post-execute", async (exec, result, next) => {
            void exec;
            const decision = await next();
            if (decision.kind === "accept") {
                const tagId = this.store.nextTagId();
                const content = enrichWithMarker(decision.content ?? result.content, tagId);
                return {
                    kind: "accept",
                    content,
                    ...(decision.additionalContexts === undefined
                        ? {}
                        : { additionalContexts: decision.additionalContexts }),
                } as typeof decision;
            }
            return decision;
        });

        // 2. Resolve tag -> (session, seq) from the durable log.
        ctx.on("session/event", (session, event) => {
            if (event.type !== "tool/result") return;
            const tagId = firstMarkerTag(
                (event.data as { message?: { content?: Array<{ content?: ContentBlock[] }> } })
                    ?.message?.content?.[0]?.content,
            );
            if (tagId !== undefined) this.store.putTag(tagId, session.id, event.seq);
        });

        // 3. The tool itself.
        tools.register({
            name: "ctx_reduce",
            description:
                "Free context space: mark tool outputs you no longer need for removal. " +
                "Every tool output carries a marker like [ctx §N§] at its end; pass those " +
                "markers as tags. Drops are applied at cache-safe moments and the content " +
                "is replaced by a tiny [dropped §N§] placeholder.",
            parameters: {
                type: "object",
                properties: {
                    tags: {
                        type: "array",
                        items: { type: "string" },
                        description: 'Marker strings to drop, e.g. ["§12§"].',
                    },
                },
                required: ["tags"],
            },
            output: {
                schema: {
                    type: "object",
                    properties: {
                        queued: { type: "number" },
                        dropped: { type: "number" },
                        missing: { type: "number" },
                    },
                    required: ["queued", "dropped", "missing"],
                },
                render: (_args: unknown, value: unknown) => {
                    const v = (value ?? {}) as {
                        queued?: number;
                        dropped?: number;
                        missing?: number;
                    };
                    return [
                        {
                            type: "text",
                            text: `ctx_reduce: ${v.queued ?? 0} queued for removal, ${v.dropped ?? 0} already queued, ${v.missing ?? 0} unknown tag(s).`,
                        },
                    ];
                },
            },
            execute: async (args: unknown) => executeCtxReduce(this.store, args),
        });

        // 4. Guidance section (optional service).
        const systemPrompt = ctx.get("systemPrompt") as
            | { section(section: { name: string; order: number; text: string }): () => void }
            | undefined;
        systemPrompt?.section({ name: "mc-ctx-reduce", order: 150, text: CTX_REDUCE_GUIDANCE });
    }

    private resolveTarget(agent: Agent): Target {
        const latest = agent.session.requestHeader()?.config as
            | { provider?: string; model?: string }
            | undefined;
        const configured =
            this.config.summarizationProvider.length === 0
                ? undefined
                : {
                      provider: this.config.summarizationProvider,
                      model: this.config.summarizationModel,
                  };
        const agentTarget =
            agent.options.provider !== undefined &&
            agent.options.provider.length > 0 &&
            agent.options.model !== undefined &&
            agent.options.model.length > 0
                ? { provider: agent.options.provider, model: agent.options.model }
                : undefined;
        const target = configured ?? latest ?? agentTarget;
        if (target === undefined || target.provider === undefined || target.model === undefined) {
            throw new Error(
                "no provider/model available for summarization: set both summarization fields, route one request, or set both AgentOptions fields",
            );
        }
        return { provider: target.provider, model: target.model };
    }

    private async contextWindowFor(
        target: Target,
        signal: AbortSignal,
    ): Promise<number | undefined> {
        const key = `${target.provider}/${target.model}`;
        const cached = this.contextWindowCache.get(key);
        if (cached !== undefined) return cached;
        const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
        const window = info.context?.contextWindow;
        if (Number.isInteger(window) && window !== undefined && window > 0) {
            this.contextWindowCache.set(key, window);
        }
        return window;
    }

    /**
     * Run the historian summarizer against one span. Shared by the background
     * runner and the inline overflow path; detached from any step signal when
     * the caller passes its own controller.
     */
    private async runSummarizer(
        input: SummarizationInput,
        target: Target,
        sessionId: Session["id"],
        signal?: AbortSignal,
    ): Promise<{
        result: SummaryResult;
        compartments: CompartmentRecord[];
        node?: { importance: number; p1: string; p2: string; p3: string; p4: string };
    }> {
        debugLog(
            `summarize called: ${target.provider}/${target.model}, span ${input.messages.length} messages`,
        );
        const messages = [
            ...input.messages,
            createUserMessage({
                content: [{ type: "text", text: COMPARTMENT_INSTRUCTION }],
                source: PLUGIN_SOURCE,
            }),
        ];
        const options = {
            provider: target.provider,
            model: target.model,
            messages,
            ...(input.system === undefined ? {} : { system: input.system }),
            ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
            maxTokens: this.config.maxTokens,
            sessionId,
            purpose: "compaction",
            ...(signal === undefined ? {} : { signal }),
        } as const;

        const assembler = new BlockAssembler();
        try {
            for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
        } catch (streamError) {
            debugLog(
                `summarize FAILED during stream: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
            );
            throw streamError;
        }
        const error = finishFailure(assembler.finish as { kind: string });
        if (error !== undefined) {
            debugLog(`summarize FAILED at stream finish: ${error.message}`);
            throw error;
        }

        const rawOutput = assembler.blocks();
        if (contentHasImage(rawOutput)) {
            throw new LlmError(
                "compaction summary cannot contain image output",
                "UNSUPPORTED_CONTENT",
            );
        }
        const textBlocks = rawOutput.filter(
            (block): block is ContentBlock & { type: "text" } => block.type === "text",
        );
        const text = textBlocks.map((block) => block.text).join("\n");
        if (!textBlocks.some((block) => block.text.trim().length > 0)) {
            throw new Error("summarization produced no text summary content");
        }

        const parsed = parseCompartmentOutput(text);
        if (parsed.compartments.length === 0) {
            debugLog(`summarize REJECT: no compartments parsed from output (${text.length} chars)`);
            throw new Error("historian output contained no <compartment> blocks");
        }
        const rendered = renderCompartments(parsed);
        const nodeImportance = Math.max(1, ...parsed.compartments.map((c) => c.importance));
        const node = {
            importance: nodeImportance,
            p1: rendered,
            p2: renderCompartments(parsed, 2),
            p3: renderCompartments(parsed, 3),
            p4: renderCompartments(parsed, 4),
        };
        debugLog(
            `summarize ok: ${parsed.compartments.length} compartments, rendered ${rendered.length} chars (node importance ${nodeImportance})`,
        );
        const summary: ContentBlock[] = [{ type: "text", text: rendered }];
        const compartments: CompartmentRecord[] = parsed.compartments.map((c) => ({
            start: c.start,
            end: c.end,
            title: c.title,
            episodeType: c.episodeType,
            importance: c.importance,
            p1: c.p1,
            p2: c.p2,
            p3: c.p3,
            p4: c.p4,
            facts: { ...parsed.facts },
        }));

        return {
            result: {
                summary,
                rawOutput,
                llmStreamCall: true,
                provider: target.provider,
                model: target.model,
                maxTokens: this.config.maxTokens,
                ...(assembler.usage === undefined ? {} : { usage: assembler.usage as TokenUsage }),
            },
            compartments,
            node,
        };
    }

    /**
     * Summarizer hook. Serves the frozen background publish when the span
     * matches (instant, no LLM); inline only on overflow; NotReady otherwise.
     */
    async summarize(
        input: SummarizationInput,
        agent: Agent,
        signal?: AbortSignal,
    ): Promise<SummaryResult> {
        const sessionId = agent.session.id;
        const fingerprint = inputFingerprint(input);
        const override = this.decayOverrides.get(`${sessionId}:${fingerprint}`);
        if (override !== undefined) {
            debugLog("summarize: decay override hit (pre-rendered demotion)");
            return override;
        }
        const pending = this.store.getPending(sessionId);
        if (pending !== undefined) {
            if (pending.fingerprint === fingerprint) {
                debugLog(`summarize: cache hit (${pending.startSeq}-${pending.endSeq})`);
                return {
                    summary: pending.summary,
                    rawOutput: pending.summary,
                    llmStreamCall: true,
                    provider: pending.provider,
                    model: pending.model,
                    ...(pending.maxTokens === undefined ? {} : { maxTokens: pending.maxTokens }),
                };
            }
            debugLog("summarize: fingerprint mismatch — clearing stale pending");
            this.store.clearPending(sessionId);
        }
        if (this.inlineMode) {
            const target = this.resolveTarget(agent);
            const run = await this.runSummarizer(input, target, sessionId, signal);
            return run.result;
        }
        throw new NotReadyError();
    }

    /**
     * Pressure path: never calls the summarizer synchronously. Overflow path:
     * delegates to the inherited recovery (inline summarizer allowed once).
     */
    async compactIfNeeded(
        agent: Agent,
        trigger: "pressure" | "context-overflow",
        signal: AbortSignal,
    ): Promise<CompactionResult | null> {
        if (trigger === "context-overflow") {
            this.inlineMode = true;
            try {
                return await super.compactIfNeeded(agent, trigger, signal);
            } finally {
                this.inlineMode = false;
            }
        }

        const t0 = Date.now();
        try {
            const meter = (
                this.ctx as unknown as {
                    tokenMeter: {
                        measure(session: Session): {
                            totalTokens: number;
                            nodes: readonly { seq: number; tokens: number }[];
                        };
                    };
                }
            ).tokenMeter;
            const measurement = meter.measure(agent.session);
            const header = agent.session.requestHeader()?.config as
                | { provider?: string; model?: string }
                | undefined;
            if (header?.provider === undefined || header.model === undefined) {
                debugLog("compactIfNeeded: no routed header yet — deferring");
                return null;
            }
            const target: Target = { provider: header.provider, model: header.model };
            const contextWindow = await this.contextWindowFor(target, signal);
            if (contextWindow === undefined) {
                debugLog("compactIfNeeded: no contextWindow for routed model — deferring");
                return null;
            }
            const thresholdTokens = Math.floor(contextWindow * this.config.thresholdRatio);
            if (measurement.totalTokens < thresholdTokens) {
                debugLog(
                    `compactIfNeeded: below threshold (${measurement.totalTokens} < ${thresholdTokens}) duration=${Date.now() - t0}ms`,
                );
                return null;
            }
            const retainTokens =
                this.config.retainTokens ?? Math.floor(contextWindow * this.config.retainRatio);
            const range = selectRange(agent.session, measurement.nodes, retainTokens);
            if (range === null) {
                debugLog(`compactIfNeeded: no compactable range duration=${Date.now() - t0}ms`);
                return null;
            }

            const sessionId = agent.session.id;
            const pending = this.store.getPending(sessionId);
            if (pending !== undefined) {
                if (pending.startSeq === range.start && pending.endSeq <= range.end) {
                    debugLog(
                        `compactIfNeeded: committing pending ${pending.startSeq}-${pending.endSeq} (current range ${range.start}-${range.end})`,
                    );
                    try {
                        const result = await this.compactRegion(
                            pending.startSeq,
                            pending.endSeq,
                            agent,
                            signal,
                        );
                        if (result !== null) {
                            this.store.clearPending(sessionId);
                            if (pending.node !== undefined) {
                                // summarySeq is the compaction/summary MARKER event;
                                // the replacement user/message surface node lands at
                                // summarySeq + 1 (verified against the session log).
                                this.store.putNodeRender({
                                    sessionId,
                                    checkpointSeq: result.summarySeq + 1,
                                    importance: pending.node.importance,
                                    provider: pending.provider,
                                    model: pending.model,
                                    p1: pending.node.p1,
                                    p2: pending.node.p2,
                                    p3: pending.node.p3,
                                    p4: pending.node.p4,
                                    renderedTier: 1,
                                });
                            }
                            debugLog(`compactIfNeeded: commit done duration=${Date.now() - t0}ms`);
                            await this.runDecayPass(agent, signal);
                            await this.runDropPass(agent, signal);
                            this.logBreakdownSnapshot(agent.session);
                        }
                        return result;
                    } catch (commitError) {
                        debugLog(
                            `compactIfNeeded: commit failed — clearing pending: ${commitError instanceof Error ? commitError.message : String(commitError)}`,
                        );
                        this.store.clearPending(sessionId);
                        return null;
                    }
                }
                debugLog("compactIfNeeded: stale pending (boundary moved) — clearing");
                this.store.clearPending(sessionId);
            }

            if (!this.historian.inFlight(sessionId)) {
                const input = buildSpanInput(agent.session, range);
                const fingerprint = inputFingerprint(input);
                const runTarget = this.resolveTarget(agent);
                debugLog(
                    `compactIfNeeded: spawning background historian for ${range.start}-${range.end} (${input.messages.length} messages, target ${runTarget.provider}/${runTarget.model})`,
                );
                this.historian.adopt(
                    sessionId,
                    this.runSummarizer(input, runTarget, sessionId).then((run) => ({
                        sessionId,
                        range,
                        fingerprint,
                        input,
                        compartments: run.compartments,
                        result: run.result,
                        ...(run.node === undefined ? {} : { node: run.node }),
                    })),
                );
            }
            debugLog(
                `compactIfNeeded: deferred (no pause) duration=${Date.now() - t0}ms total=${measurement.totalTokens} threshold=${thresholdTokens}`,
            );
            return null;
        } catch (error) {
            // Fail open on the pre-step path: never break the step loop.
            debugLog(
                `compactIfNeeded FAILED (fail-open): ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }
    }

    /**
     * Decay pass: runs on a fold boundary (a successful compaction commit).
     * Computes each committed checkpoint node's desired tier from age
     * (1-based, newest first) + importance + budget pressure, and re-replaces
     * up to MAX_DEMOTIONS_PER_PASS over-aged nodes with pre-rendered lower-tier
     * text. Re-renders ride the fold's bust — never their own.
     */
    private async runDecayPass(agent: Agent, signal: AbortSignal): Promise<void> {
        const sessionId = agent.session.id;
        const surface = agent.session.surface.nodes;
        const rows = this.store.listNodeRenders(sessionId);
        if (rows.length === 0) return;
        // Ledger rows whose checkpoint node was folded into a later compaction
        // are stale: their content already lives inside the newer checkpoint.
        for (const row of rows) {
            if (!surface.includes(row.checkpointSeq)) {
                this.store.deleteNodeRender(sessionId, row.checkpointSeq);
                debugLog(
                    `decay: dropped folded ledger row (node ${row.checkpointSeq} no longer on surface)`,
                );
            }
        }
        const live = rows.filter((row) => surface.includes(row.checkpointSeq));
        if (live.length === 0) return;
        const p = computeBudgetPressure(
            live.map((row, index) => ({ index: index + 1, importance: row.importance })),
            CompartmentEngine.HISTORY_BUDGET_TOKENS,
        );
        let demotions = 0;
        for (
            let i = 0;
            i < live.length && demotions < CompartmentEngine.MAX_DEMOTIONS_PER_PASS;
            i++
        ) {
            const row = live[i];
            if (row === undefined) continue;
            const desired = renderedTier(i + 1, row.importance, p);
            if (desired === 5 || desired <= row.renderedTier) continue;
            const text = { 1: row.p1, 2: row.p2, 3: row.p3, 4: row.p4 }[desired];
            try {
                const input = buildSpanInput(agent.session, {
                    start: row.checkpointSeq,
                    end: row.checkpointSeq,
                });
                const fingerprint = inputFingerprint(input);
                this.decayOverrides.set(`${sessionId}:${fingerprint}`, {
                    summary: [{ type: "text", text }],
                    rawOutput: [],
                    llmStreamCall: true,
                    provider: row.provider,
                    model: row.model,
                });
                const result = await this.compactRegion(
                    row.checkpointSeq,
                    row.checkpointSeq,
                    agent,
                    signal,
                );
                if (result !== null) {
                    // summarySeq is the marker; the replacement node lands at +1.
                    this.store.updateNodeRender(
                        sessionId,
                        row.checkpointSeq,
                        result.summarySeq + 1,
                        desired,
                    );
                    demotions += 1;
                    debugLog(
                        `decay: demoted node ${row.checkpointSeq}->${result.summarySeq + 1} to tier ${desired} (importance ${row.importance}, pressure ${p.toFixed(3)})`,
                    );
                }
            } catch (decayError) {
                debugLog(
                    `decay: skip node ${row.checkpointSeq}: ${decayError instanceof Error ? decayError.message : String(decayError)}`,
                );
            } finally {
                for (const key of this.decayOverrides.keys()) {
                    if (key.startsWith(`${sessionId}:`)) this.decayOverrides.delete(key);
                }
            }
        }
    }

    /**
     * Drop pass: commits queued ctx_reduce drops on a fold boundary, following
     * the tool-result pruner's sanctioned pattern — a same-type `tool/result`
     * replacement that preserves the message source (callId) so provider
     * tool-pairing survives. Stale queue rows (node folded away) are cleared.
     */
    private async runDropPass(agent: Agent, signal: AbortSignal): Promise<void> {
        void signal;
        const sessionId = agent.session.id;
        const surface = agent.session.surface.nodes;
        const queue = this.store.listDropQueue(sessionId, CompartmentEngine.MAX_DROPS_PER_PASS);
        for (const drop of queue) {
            if (!surface.includes(drop.seq)) {
                debugLog(`reduce: clearing stale drop §${drop.tagId}§ (node ${drop.seq} folded)`);
                this.store.deleteDrop(sessionId, drop.tagId);
                continue;
            }
            if (this.commitDrop(agent.session, drop.tagId, drop.seq)) {
                this.store.deleteDrop(sessionId, drop.tagId);
                debugLog(`reduce: dropped §${drop.tagId}§ (node ${drop.seq})`);
            }
        }
    }

    /** Replace one tool/result node's content with the deterministic placeholder. */
    private commitDrop(session: Session, tagId: number, seq: number): boolean {
        const event = session.events[seq] as
            | {
                  type?: string;
                  data?: {
                      message?: {
                          content?: Array<{
                              type?: string;
                              toolCallId?: string;
                              content?: ContentBlock[];
                              isError?: boolean;
                          }>;
                      };
                  };
              }
            | undefined;
        if (event?.type !== "tool/result") return false;
        const resultBlock = event.data?.message?.content?.[0];
        if (resultBlock === undefined || resultBlock.type !== "tool-result") return false;
        const original = deriveEventMessage(event as unknown as SessionEvent);
        const shadowedTokens = original === null ? 0 : estimateMessageTokens(original);
        // Shadow-price metering, adjacent to the replace below (projection fold).
        session.append("mc/drop-meter", {
            shadowedSeqs: [seq],
            rawTokens: shadowedTokens,
            checkpointTokens: 0,
            droppedTokens: 0,
        } as never);
        const message = freezeMessage({
            ...(event.data?.message as object),
            content: [
                {
                    ...resultBlock,
                    content: [{ type: "text", text: dropPlaceholder(tagId) }],
                },
            ],
        } as Parameters<typeof freezeMessage>[0]);
        session.append("tool/result", { ...(event.data as object), message } as never, {
            surfaceOp: { op: "replace", start: seq, end: seq },
            sourceEventSeqs: [seq],
        });
        return true;
    }
}

export default CompartmentEngine;
