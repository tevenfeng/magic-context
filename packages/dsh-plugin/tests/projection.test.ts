import { describe, expect, test } from "bun:test";
import type { Message } from "@deepseek-ai/dsh-llm";
import {
    classifyMessage,
    estimateMessageTokens,
    type McBreakdownValue,
    mcBreakdownProjection,
} from "../src/projection";

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
        surfaceOp: { op: "append" },
    };
}

function toolResult(seq: number, text: string): Record<string, unknown> {
    return {
        type: "tool/result",
        seq,
        time: seq,
        data: {
            turn: 1,
            step: 1,
            message: {
                source: { kind: "tool", callId: `c${seq}` },
                content: [
                    {
                        type: "tool-result",
                        toolCallId: `c${seq}`,
                        content: [{ type: "text", text }],
                    },
                ],
                role: "user",
                id: `r${seq}`,
            },
        },
        surfaceOp: { op: "append" },
    };
}

function checkpoint(seq: number, text: string): Record<string, unknown> {
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
        surfaceOp: { op: "append" },
    };
}

function dropReplace(
    seq: number,
    shadowed: number[],
    placeholder: string,
): Record<string, unknown> {
    return {
        type: "tool/result",
        seq,
        time: seq,
        data: {
            turn: 1,
            step: 1,
            message: {
                source: { kind: "tool", callId: "c" },
                content: [
                    {
                        type: "tool-result",
                        toolCallId: "c",
                        content: [{ type: "text", text: placeholder }],
                    },
                ],
                role: "user",
                id: `d${seq}`,
            },
        },
        surfaceOp: { op: "replace" },
        sourceEventSeqs: shadowed,
    };
}

function dropMeter(shadowed: number[], rawTokens: number): Record<string, unknown> {
    return {
        type: "mc/drop-meter",
        seq: shadowed[0] ?? 0,
        time: 0,
        data: { shadowedSeqs: shadowed, rawTokens, checkpointTokens: 0, droppedTokens: 0 },
    };
}

type FoldState = ReturnType<typeof mcBreakdownProjection.init>;

function fold(events: Array<Record<string, unknown>>): McBreakdownValue {
    let state: FoldState = mcBreakdownProjection.init();
    for (const event of events) {
        state = mcBreakdownProjection.apply(state, event as never);
    }
    return mcBreakdownProjection.view(state);
}

describe("estimateMessageTokens", () => {
    test("prices text with role framing and block overhead", () => {
        const message = {
            role: "user",
            content: [{ type: "text", text: "abcdefgh" }],
        } as unknown as Message;
        // ceil(8/4)=2 + BLOCK_OVERHEAD 4 + framing 4 = 10
        expect(estimateMessageTokens(message)).toBe(10);
    });

    test("prices tool results recursively", () => {
        const message = {
            role: "user",
            content: [
                {
                    type: "tool-result",
                    toolCallId: "c",
                    content: [{ type: "text", text: "abcdefgh" }],
                },
            ],
        } as unknown as Message;
        // inner ceil(8/4)+4=6, outer +4 overhead, framing +4 => 14
        expect(estimateMessageTokens(message)).toBe(14);
    });
});

describe("classifyMessage", () => {
    test("recognizes checkpoints and drops", () => {
        const cp = {
            role: "user",
            content: [{ type: "text", text: "summary" }],
            source: { kind: "plugin", plugin: "compact", compactionId: "x" },
        } as unknown as Message;
        expect(classifyMessage(cp)).toBe("checkpoint");
        const dropped = {
            role: "user",
            content: [
                {
                    type: "tool-result",
                    toolCallId: "c",
                    content: [{ type: "text", text: "[dropped §2§]" }],
                },
            ],
        } as unknown as Message;
        expect(classifyMessage(dropped)).toBe("dropped");
        const raw = {
            role: "user",
            content: [{ type: "text", text: "hello" }],
        } as unknown as Message;
        expect(classifyMessage(raw)).toBe("raw");
    });
});

describe("mcBreakdownProjection fold", () => {
    test("accumulates append buckets", () => {
        const value = fold([
            rawUser(1, "hello"),
            toolResult(2, "result text"),
            checkpoint(3, "compartment summary"),
        ]);
        expect(value.checkpointCount).toBe(1);
        expect(value.droppedCount).toBe(0);
        expect(value.surfaceTokens).toBeGreaterThan(value.checkpointTokens);
        expect(value.rawTokens).toBeGreaterThan(0);
        expect(value.surfaceTokens).toBe(
            value.rawTokens + value.checkpointTokens + value.droppedTokens,
        );
    });

    test("drop replace consumes the adjacent meter claim and reclassifies", () => {
        const value = fold([
            rawUser(1, "hello"),
            toolResult(2, "a very long tool result"),
            // shadowedTokens from the same estimator: ceil(22/4)=6 +4 inner, +4 outer, +4 framing = 18
            dropMeter([2], 18),
            dropReplace(3, [2], "[dropped §2§]"),
        ]);
        expect(value.droppedCount).toBe(1);
        expect(value.droppedTokens).toBeGreaterThan(0);
        // raw bucket lost the shadowed 18 tokens and kept only the user message
        const single = fold([rawUser(1, "hello")]);
        expect(value.rawTokens).toBe(single.rawTokens);
        // surface total = user + placeholder
        expect(value.surfaceTokens).toBe(
            value.rawTokens + value.droppedTokens + value.checkpointTokens,
        );
    });

    test("compaction summary arms an all-raw claim consumed by a checkpoint replace", () => {
        const value = fold([
            rawUser(1, "one"),
            rawUser(2, "two"),
            {
                type: "compaction/summary",
                seq: 3,
                time: 3,
                data: {
                    compactionId: "x",
                    summary: [],
                    shadowedSeqs: [1, 2],
                    shadowedTokenCount: 18,
                },
            },
            { ...checkpoint(4, "folded history"), surfaceOp: { op: "replace" }, sourceEventSeqs: [1, 2] },
        ]);
        // raw bucket lost 18 tokens, checkpoint gained the summary node
        expect(value.checkpointCount).toBe(1);
        expect(value.rawTokens).toBe(0);
        expect(value.surfaceTokens).toBe(value.checkpointTokens);
    });

    test("unclaimed replace subtracts nothing (drift tolerance)", () => {
        const value = fold([rawUser(1, "hello"), dropReplace(3, [1], "[dropped §9§]")]);
        // raw tokens remain + placeholder added as dropped
        expect(value.droppedCount).toBe(1);
        expect(value.rawTokens).toBeGreaterThan(0);
    });

    test("non-surface events between meter and replace expire the claim", () => {
        const value = fold([
            rawUser(1, "hello"),
            toolResult(2, "long result"),
            dropMeter([2], 42),
            { type: "turn/start", seq: 2, time: 2, data: { turn: 1 } },
            dropReplace(3, [2], "[dropped §2§]"),
        ]);
        // claim expired -> no subtraction: raw keeps the shadowed tokens
        expect(value.rawTokens).toBeGreaterThan(0);
        expect(value.droppedCount).toBe(1);
    });

    test("schema validates the view payload", () => {
        const value = fold([rawUser(1, "hello")]);
        expect(mcBreakdownProjection.schema.safeParse(value).success).toBe(true);
    });
});
