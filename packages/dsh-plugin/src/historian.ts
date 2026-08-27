/**
 * Async-historian runtime for the DSH engine.
 *
 * Range selection replicates BasicCompactionEngine's internal
 * `selectCompactableRange` using only public APIs
 * (`tokenMeter.measure`, `session.surface.nodes`,
 * `toolPairingBalancedBefore`), with the fence predicate injectable for
 * tests. The span input mirrors the engine's own `buildSummarizationInput`
 * (surface events -> derived messages, conversation system/tools reused for
 * provider prefix-cache alignment), so the fingerprint computed at spawn time
 * matches the one computed over the commit-time span.
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { isCompactCheckpointSource, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import type { ContentBlock, Message, ToolSchema } from "@deepseek-ai/dsh-llm";
import type { Session } from "@deepseek-ai/dsh-session";
import type { McStore } from "./store";

export interface SpanRange {
    start: number;
    end: number;
}

export interface SpanInput {
    system?: string;
    tools?: readonly ToolSchema[];
    messages: readonly Message[];
}

interface PricedNode {
    seq: number;
    tokens: number;
}

type FencePredicate = (session: Session, seq: number) => boolean;

/**
 * Replicate Basic's compactable-range selection. Walk the priced surface
 * nodes backward accumulating tokens until the retain budget is met, then
 * fence backward to a tool-pairing-balanced boundary, then skip leading
 * checkpoint nodes so each MC checkpoint stays an independent surface node.
 */
export function selectRange(
    session: Session,
    pricedNodes: readonly PricedNode[],
    retainTokens: number,
    balancedBefore: FencePredicate = toolPairingBalancedBefore,
    isCheckpoint: (session: Session, seq: number) => boolean = isCheckpointSurfaceNode,
): SpanRange | null {
    if (pricedNodes.length === 0) return null;
    const surfaceNodes = session.surface.nodes;
    if (
        surfaceNodes.length !== pricedNodes.length ||
        surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)
    ) {
        throw new Error(
            "compaction: token-meter surface does not match the current session surface",
        );
    }
    let accumulated = 0;
    let keepFromIdx = pricedNodes.length;
    for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
        accumulated += pricedNodes[index]?.tokens ?? 0;
        keepFromIdx = index;
        if (accumulated >= retainTokens) break;
    }
    if (keepFromIdx === 0) return null;
    while (keepFromIdx > 0) {
        if (balancedBefore(session, surfaceNodes[keepFromIdx] ?? -1)) break;
        keepFromIdx -= 1;
    }
    if (keepFromIdx === 0) return null;
    // Skip leading checkpoint nodes: MC checkpoints stay independent surface
    // nodes for decay demotion; re-folding them into every new compaction would
    // both destroy their identity and re-compress already-compressed text.
    let startIdx = 0;
    while (startIdx < keepFromIdx && isCheckpoint(session, surfaceNodes[startIdx] ?? -1)) {
        startIdx += 1;
    }
    if (startIdx >= keepFromIdx) return null;
    if (startIdx > 0 && !balancedBefore(session, surfaceNodes[startIdx] ?? -1)) {
        // An unbalanced skip boundary is worse than refolding a checkpoint.
        startIdx = 0;
    }
    return {
        start: surfaceNodes[startIdx] ?? -1,
        end: surfaceNodes[keepFromIdx - 1] ?? -1,
    };
}

/** Whether a surface node is a compaction checkpoint (replacement summary node). */
export function isCheckpointSurfaceNode(session: Session, seq: number): boolean {
    const event = session.events[seq];
    if (event === undefined) return false;
    const message = session.deriveEventMessage(event);
    if (message === null || message.source === undefined) return false;
    return isCompactCheckpointSource(message.source);
}

/** Build the summarization input for a validated surface range (mirror of the basic engine's builder). */
export function buildSpanInput(session: Session, range: SpanRange): SpanInput {
    const header = session.requestHeader();
    const nodes = session.surface.nodes;
    const startIdx = nodes.indexOf(range.start);
    const endIdx = nodes.indexOf(range.end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
        throw new Error(`buildSpanInput: range ${range.start}-${range.end} is not on the surface`);
    }
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
    const messages = shadowedSeqs
        .map((seq) => session.deriveEventMessage(session.events[seq]))
        .filter((message): message is Message => message !== null);
    return {
        ...(header?.system === undefined ? {} : { system: header.system }),
        ...(header?.tools === undefined ? {} : { tools: header.tools }),
        messages,
    };
}

/** Deterministic span fingerprint: exact content hash, so only an identical span matches. */
export function inputFingerprint(input: SpanInput): string {
    const hash = createHash("sha256");
    hash.update(
        JSON.stringify({
            system: input.system ?? null,
            tools: input.tools ?? null,
            messages: input.messages,
        }),
    );
    return hash.digest("hex");
}

/** Pending-publish payload written by the background historian. */
export interface SpawnEntry {
    sessionId: string;
    range: SpanRange;
    fingerprint: string;
    input: SpanInput;
    compartments: Array<{
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
    }>;
    result: {
        summary: ContentBlock[];
        provider: string;
        model: string;
        maxTokens?: number;
    };
    /** Node-level tier texts + importance, rendered at publish for later decay. */
    node?: {
        importance: number;
        p1: string;
        p2: string;
        p3: string;
        p4: string;
    };
}

/**
 * Fire-and-forget background runner: one in-flight run per session. The
 * summarizer LLM call is detached from the pre-step AbortSignal (which dies
 * at step end) and owned by a per-session controller, aborted on dispose.
 */
export class HistorianRunner {
    private readonly inflight = new Map<string, AbortController>();

    constructor(private readonly store: McStore) {}

    inFlight(sessionId: string): boolean {
        return this.inflight.has(sessionId);
    }

    /** Start the background run if none is in flight; the caller passes an already-built summary. */
    adopt(sessionId: string, promise: Promise<SpawnEntry | undefined>): void {
        if (this.inflight.has(sessionId)) return;
        const controller = new AbortController();
        this.inflight.set(sessionId, controller);
        void promise
            .then((entry) => {
                if (entry === undefined) return;
                this.store.putPending({
                    sessionId: entry.sessionId,
                    startSeq: entry.range.start,
                    endSeq: entry.range.end,
                    fingerprint: entry.fingerprint,
                    summary: entry.result.summary as ContentBlock[],
                    provider: entry.result.provider,
                    model: entry.result.model,
                    ...(entry.result.maxTokens === undefined
                        ? {}
                        : { maxTokens: entry.result.maxTokens }),
                    ...(entry.node === undefined ? {} : { node: entry.node }),
                });
                this.store.putCompartments(
                    entry.compartments.map((c) => ({
                        ...c,
                        sessionId: entry.sessionId,
                        startSeq: c.start,
                        endSeq: c.end,
                    })),
                );
                debugLog(
                    `historian background run committed to store: ${entry.range.start}-${entry.range.end}`,
                );
            })
            .catch((error) => {
                debugLog(
                    `historian background run failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            })
            .finally(() => {
                if (this.inflight.get(sessionId) === controller) this.inflight.delete(sessionId);
            });
    }

    dispose(): void {
        for (const controller of this.inflight.values()) controller.abort();
        this.inflight.clear();
    }
}

/** Gated diagnostics, shared with the engine. */
export const MC_DSH_DEBUG = process.env.MC_DSH_DEBUG === "1";
export function debugLog(line: string): void {
    if (!MC_DSH_DEBUG) return;
    try {
        appendFileSync(".dsh-ref/mc-debug.log", `${new Date().toISOString()} ${line}\n`);
    } catch {
        // diagnostics must never break the engine
    }
}
