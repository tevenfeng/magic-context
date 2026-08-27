import { describe, expect, test } from "bun:test";
import { deriveEventMessage, foldSurface } from "@deepseek-ai/dsh-session";

/**
 * Determinism contract: the same event log must fold to the same surface and
 * derive byte-identical messages on every pass — the DSH reconstructability
 * principle that Magic Context's cache-stability rides on. Locked here against
 * the real dsh-session fold.
 */

function rawUser(seq: number, text: string): Record<string, unknown> {
    return {
        type: "user/message",
        seq,
        time: seq,
        data: {
            content: [{ type: "text", text }],
            source: { kind: "user" },
            role: "user",
            id: `m${seq}`,
        },
        surfaceOp: "append",
    };
}

function checkpoint(seq: number, text: string, shadowed: number[]): Record<string, unknown> {
    return {
        type: "user/message",
        seq,
        time: seq,
        data: {
            content: [{ type: "text", text }],
            source: { kind: "plugin", plugin: "compact", compactionId: "x" },
            role: "user",
            id: `cp${seq}`,
        },
        surfaceOp: { op: "replace", start: shadowed[0], end: shadowed[shadowed.length - 1] },
        sourceEventSeqs: shadowed,
    };
}

function toolResult(seq: number, text: string, callId: string): Record<string, unknown> {
    return {
        type: "tool/result",
        seq,
        time: seq,
        data: {
            turn: 1,
            step: 1,
            message: {
                source: { kind: "tool", callId },
                content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }] }],
                role: "user",
                id: `r${seq}`,
            },
        },
        surfaceOp: "append",
    };
}

function dropReplace(seq: number, placeholder: string, original: Record<string, unknown>): Record<string, unknown> {
    const data = original.data as {
        message: { content: Array<Record<string, unknown>> };
    };
    const originalBlock = data.message.content[0] as Record<string, unknown>;
    return {
        type: "tool/result",
        seq,
        time: seq,
        data: {
            ...data,
            message: {
                ...data.message,
                content: [
                    {
                        ...originalBlock,
                        content: [{ type: "text", text: placeholder }],
                    },
                ],
            },
        },
        surfaceOp: { op: "replace", start: original.seq as number, end: original.seq as number },
        sourceEventSeqs: [original.seq],
    };
}

/** A realistic mini-log: raw messages, a compaction fold, a drop replacement. */
function buildLog(): Array<Record<string, unknown>> {
    const originalResult = toolResult(2, "a very large tool result", "c2");
    return [
        rawUser(0, "user asks for a feature"),
        { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
        originalResult,
        dropReplace(3, "[dropped §2§]", originalResult),
        checkpoint(4, "### feature work (importance 60)", [0]),
        rawUser(5, "thank you"),
    ];
}

function surfaceBytes(events: Array<Record<string, unknown>>): string {
    const folded = foldSurface(events as never);
    const messages = folded.nodes.map((seq) => deriveEventMessage((events as never)[seq]));
    return JSON.stringify({ nodes: folded.nodes, messages });
}

describe("surface replay determinism", () => {
    test("the same log folds byte-identically across independent passes", () => {
        const events = buildLog();
        const a = surfaceBytes(events);
        const b = surfaceBytes(events);
        expect(a).toBe(b);
    });

    test("the surface reflects compaction + drop shadowing", () => {
        const events = buildLog();
        const folded = foldSurface(events as never);
        // node 0 shadowed by checkpoint 4; node 2 shadowed by drop 3
        expect(folded.nodes).not.toContain(0);
        expect(folded.nodes).not.toContain(2);
        expect(folded.nodes).toContain(3);
        expect(folded.nodes).toContain(4);
        expect(folded.nodes).toContain(5);
        const cp = deriveEventMessage(events[4] as never);
        expect(JSON.stringify(cp?.content)).toContain("feature work");
        const dropped = deriveEventMessage(events[3] as never);
        expect(JSON.stringify(dropped?.content)).toContain("[dropped §2§]");
    });

    test("a mutated log folds differently (sensitivity guard)", () => {
        const events = buildLog();
        const original = surfaceBytes(events);
        const mutated = [...events];
        mutated[4] = checkpoint(4, "### altered summary", [0]);
        expect(surfaceBytes(mutated)).not.toBe(original);
    });
});
