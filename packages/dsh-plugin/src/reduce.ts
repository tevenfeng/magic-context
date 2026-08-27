/**
 * Agent-driven reduction (`ctx_reduce`) for the DSH engine.
 *
 * The agent sees `[ctx §N§]` markers appended to tool outputs (post-execute
 * enrichment — the enriched content is the durable, model-visible content).
 * Calling `ctx_reduce(tags=["§N§", ...])` queues drops; the host commits them
 * at the next fold boundary by replacing the tagged surface node with the
 * deterministic placeholder `[dropped §N§]` (served through the decay-override
 * map, no LLM). Tool-arc protection rides compactRegion's balance validation.
 *
 * Tag ids come from a process-wide counter (globally unique), so the tool
 * needs no agent linkage: the tag itself resolves to its (session, seq).
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { McStore } from "./store";

/** Matches tag markers in either quoted form: `[ctx §12§]` or bare `§12§`. */
export const TAG_MARKER_RE = /§(\d+)§/g;

/** Deterministic drop placeholder — a pure function of the tag id. */
export function dropPlaceholder(tagId: number): string {
    return `[dropped §${tagId}§]`;
}

export function parseTagMarker(input: string): number[] {
    const ids: number[] = [];
    for (const match of input.matchAll(TAG_MARKER_RE)) {
        const id = Number.parseInt(match[1] ?? "0", 10);
        if (Number.isInteger(id) && id > 0) ids.push(id);
    }
    return ids;
}

/** Extract the first marker tag id from content blocks, if present. */
export function firstMarkerTag(content: readonly ContentBlock[] | undefined): number | undefined {
    if (content === undefined) return undefined;
    for (const block of content) {
        if (block.type !== "text") continue;
        const ids = parseTagMarker(block.text);
        if (ids.length > 0) return ids[0];
    }
    return undefined;
}

/**
 * Append the tag marker to a normalized tool result (post-execute enrichment).
 * Enrichment happens once at execution; the durable log then carries the
 * marker forever, so replay determinism holds by construction.
 */
export function enrichWithMarker(base: readonly ContentBlock[], tagId: number): ContentBlock[] {
    return [...base, { type: "text", text: `\n\n[ctx §${tagId}§]` }];
}

export interface CtxReduceArgs {
    tags: unknown;
}

/** Parse and validate the tool's arguments; returns tag ids or an error message. */
export function parseCtxReduceArgs(args: unknown): { tagIds: number[]; error?: string } {
    const raw = (args as CtxReduceArgs | undefined)?.tags;
    if (!Array.isArray(raw)) {
        return { tagIds: [], error: "ctx_reduce: `tags` must be an array of §N§ markers" };
    }
    const tagIds: number[] = [];
    for (const entry of raw) {
        if (typeof entry !== "string") {
            return { tagIds: [], error: "ctx_reduce: every tag must be a §N§ marker string" };
        }
        const ids = parseTagMarker(entry);
        if (ids.length === 0) {
            return { tagIds: [], error: `ctx_reduce: "${entry}" is not a valid §N§ marker` };
        }
        tagIds.push(...ids);
    }
    return { tagIds };
}

/** Execute the queue side of ctx_reduce against the store. */
export function executeCtxReduce(
    store: McStore,
    args: unknown,
): {
    queued: number;
    dropped: number;
    missing: number;
    note?: string;
} {
    const parsed = parseCtxReduceArgs(args);
    if (parsed.error !== undefined) throw new Error(parsed.error);
    let queued = 0;
    let dropped = 0;
    let missing = 0;
    for (const tagId of parsed.tagIds) {
        const resolved = store.resolveTag(tagId);
        if (resolved === undefined) {
            missing += 1;
            continue;
        }
        if (store.queueDrop(resolved.sessionId, tagId, resolved.seq, "full")) queued += 1;
        else dropped += 1;
    }
    return { queued, dropped, missing };
}

export const CTX_REDUCE_GUIDANCE = [
    'You have a `ctx_reduce` tool for freeing context space. Every tool output you receive carries a marker like `[ctx §N§]` at its end. When a tool output has served its purpose and is no longer needed (a file you finished reading, an old listing), call `ctx_reduce` with its tag (e.g. `ctx_reduce(tags=["§12§"])`) to mark it for removal. Dropped content is replaced by a tiny `[dropped §N§]` placeholder at a cache-safe moment; do not drop outputs you may still need.',
].join("\n");
