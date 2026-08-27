/**
 * MC token-breakdown projection for DSH sessions.
 *
 * A pure event fold registered into `ctx.sessionProjections` under the
 * `mcBreakdown` key: model-visible surface tokens classified into checkpoint
 * (compaction summary nodes), raw (conversation), and dropped (ctx_reduce
 * placeholders) buckets, with counts. The state is BOUNDED (running totals +
 * one shadow-price claim) following the token-meter's own fold protocol:
 * metering events (`compaction/summary`, `compaction/prune`, and our
 * `mc/drop-meter`) arm a claim that the immediately-adjacent surface replace
 * consumes.
 *
 * Token estimation is a faithful port of the token-meter's fixed heuristic
 * (CHARS_PER_TOKEN=4, BLOCK_OVERHEAD=4, role framing +4) — the pure estimator
 * is not exported from the shipped package, so the math is copied and kept in
 * lockstep. Values may drift by one demoted checkpoint's delta when a decay
 * re-render rides `compactRegion` (its native claim carries no kind split);
 * tracked as a known approximation.
 */

import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { deriveEventMessage, isSurfaceEligibleType } from "@deepseek-ai/dsh-session";
import { z } from "zod";

export const CHARS_PER_TOKEN = 4;
export const BLOCK_OVERHEAD = 4;
export const ROLE_FRAMING_TOKENS = 4;

/** Faithful port of the token-meter's fixed heuristic estimator. */
export function estimateMessageTokens(message: Message): number {
    return estimateContentTokens(message.content) + ROLE_FRAMING_TOKENS;
}

function estimateContentTokens(blocks: readonly ContentBlock[] | undefined): number {
    if (blocks === undefined) return 0;
    let tokens = 0;
    for (const block of blocks) {
        switch (block.type) {
            case "text":
                tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
                break;
            case "tool-call":
                tokens +=
                    Math.ceil(block.name.length / CHARS_PER_TOKEN) +
                    Math.ceil(block.arguments.length / CHARS_PER_TOKEN) +
                    BLOCK_OVERHEAD;
                break;
            case "tool-result":
                tokens += estimateContentTokens(block.content) + BLOCK_OVERHEAD;
                break;
            default:
                tokens +=
                    BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
        }
    }
    return tokens;
}

export type BreakdownKind = "raw" | "checkpoint" | "dropped";

/** Classify one derived message's surface contribution. */
export function classifyMessage(message: Message): BreakdownKind {
    if (message.source !== undefined && isCompactCheckpointSource(message.source)) {
        return "checkpoint";
    }
    for (const block of message.content) {
        if (block.type !== "tool-result") continue;
        for (const inner of block.content ?? []) {
            if (inner.type === "text" && inner.text.includes("[dropped §")) return "dropped";
        }
    }
    return "raw";
}

export interface McBreakdownValue {
    surfaceTokens: number;
    checkpointTokens: number;
    rawTokens: number;
    droppedTokens: number;
    checkpointCount: number;
    droppedCount: number;
}

// NOTE: third-party keys cannot merge into SessionProjectionMap without a
// resolvable `.../types` subpath export, so the key is widened through a cast
// at registration time; the zod schema still validates every wire payload.
declare module "@deepseek-ai/dsh-session" {
    interface SessionEventMap {
        /** Shadow-price metering for a ctx_reduce drop replacement (adjacent to its replace). */
        "mc/drop-meter": {
            shadowedSeqs: number[];
            rawTokens: number;
            checkpointTokens: number;
            droppedTokens: number;
        };
    }
}

interface Claim {
    seqs: number[];
    raw: number;
    checkpoint: number;
    dropped: number;
}

interface State {
    surface: number;
    checkpoint: number;
    raw: number;
    dropped: number;
    checkpointCount: number;
    droppedCount: number;
    claim?: Claim;
}

type SurfaceEnvelope = SessionEvent & {
    surfaceOp?: { op: "append" | "replace" };
    sourceEventSeqs?: number[];
};

const METER_TYPES = new Set(["compaction/summary", "compaction/prune"]);

function meterClaim(event: SessionEvent): Claim | undefined {
    if (event.type === "mc/drop-meter") {
        const data = event.data as {
            shadowedSeqs: number[];
            rawTokens: number;
            checkpointTokens: number;
            droppedTokens: number;
        };
        return {
            seqs: data.shadowedSeqs,
            raw: data.rawTokens,
            checkpoint: data.checkpointTokens,
            dropped: data.droppedTokens,
        };
    }
    if (METER_TYPES.has(event.type)) {
        const data = event.data as { shadowedSeqs?: number[]; shadowedTokenCount?: number };
        if (!Array.isArray(data.shadowedSeqs) || typeof data.shadowedTokenCount !== "number") {
            return undefined;
        }
        // Native compaction folds raw spans (head-skip keeps checkpoints out).
        return {
            seqs: data.shadowedSeqs,
            raw: data.shadowedTokenCount,
            checkpoint: 0,
            dropped: 0,
        };
    }
    return undefined;
}

function claimsMatch(claim: Claim, seqs: readonly number[] | undefined): boolean {
    if (seqs === undefined || claim.seqs.length !== seqs.length) return false;
    return claim.seqs.every((seq, index) => seq === seqs[index]);
}

export const mcBreakdownProjection = {
    key: "mcBreakdown" as const,
    schema: z.object({
        surfaceTokens: z.number(),
        checkpointTokens: z.number(),
        rawTokens: z.number(),
        droppedTokens: z.number(),
        checkpointCount: z.number(),
        droppedCount: z.number(),
    }),
    init(): State {
        return {
            surface: 0,
            checkpoint: 0,
            raw: 0,
            dropped: 0,
            checkpointCount: 0,
            droppedCount: 0,
        };
    },
    apply(state: State, event: SessionEvent): State {
        const claim = meterClaim(event);
        if (claim !== undefined) {
            return { ...state, claim };
        }
        if (state.claim !== undefined && !isSurfaceEligibleType(event.type)) {
            return { ...state, claim: undefined };
        }
        if (!isSurfaceEligibleType(event.type)) return state;

        const env = event as SurfaceEnvelope;
        const message = deriveEventMessage(env);
        const tokens = message === null ? 0 : estimateMessageTokens(message);
        const kind = message === null ? "raw" : classifyMessage(message);

        if (env.surfaceOp?.op === "replace") {
            const consumed =
                state.claim !== undefined && claimsMatch(state.claim, env.sourceEventSeqs)
                    ? state.claim
                    : undefined;
            const subtract = consumed ?? { seqs: [], raw: 0, checkpoint: 0, dropped: 0 };
            return {
                surface:
                    state.surface - subtract.raw - subtract.checkpoint - subtract.dropped + tokens,
                checkpoint:
                    state.checkpoint - subtract.checkpoint + (kind === "checkpoint" ? tokens : 0),
                raw: state.raw - subtract.raw + (kind === "raw" ? tokens : 0),
                dropped: state.dropped - subtract.dropped + (kind === "dropped" ? tokens : 0),
                checkpointCount:
                    state.checkpointCount +
                    (kind === "checkpoint" ? 1 : 0) -
                    (subtract.checkpoint > 0 ? 1 : 0),
                droppedCount:
                    state.droppedCount +
                    (kind === "dropped" ? 1 : 0) -
                    (subtract.dropped > 0 ? 1 : 0),
            };
        }
        // append
        return {
            ...state,
            claim: undefined,
            surface: state.surface + tokens,
            checkpoint: state.checkpoint + (kind === "checkpoint" ? tokens : 0),
            raw: state.raw + (kind === "raw" ? tokens : 0),
            dropped: state.dropped + (kind === "dropped" ? tokens : 0),
            checkpointCount: state.checkpointCount + (kind === "checkpoint" ? 1 : 0),
            droppedCount: state.droppedCount + (kind === "dropped" ? 1 : 0),
        };
    },
    view(state: State): McBreakdownValue {
        return {
            surfaceTokens: state.surface,
            checkpointTokens: state.checkpoint,
            rawTokens: state.raw,
            droppedTokens: state.dropped,
            checkpointCount: state.checkpointCount,
            droppedCount: state.droppedCount,
        };
    },
    stateVersion: 1,
};
