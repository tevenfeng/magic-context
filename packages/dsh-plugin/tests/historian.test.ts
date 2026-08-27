import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputFingerprint, type SpanInput, selectRange } from "../src/historian";
import { McStore } from "../src/store";

describe("McStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-dsh-store-"));
    const store = new McStore(join(dir, "test.db"));

    test("pending publish round-trips with full fidelity", () => {
        const entry = {
            sessionId: "s1",
            startSeq: 10,
            endSeq: 42,
            fingerprint: "abc123",
            summary: [{ type: "text" as const, text: "### Title (importance 80)" }],
            provider: "p",
            model: "m",
            maxTokens: 4096,
        };
        store.putPending(entry);
        const read = store.getPending("s1");
        expect(read).toBeDefined();
        expect(read?.startSeq).toBe(10);
        expect(read?.endSeq).toBe(42);
        expect(read?.fingerprint).toBe("abc123");
        expect(read?.summary).toEqual([{ type: "text", text: "### Title (importance 80)" }]);
        expect(read?.maxTokens).toBe(4096);
    });

    test("putPending overwrites per session", () => {
        store.putPending({
            sessionId: "s2",
            startSeq: 1,
            endSeq: 2,
            fingerprint: "old",
            summary: [],
            provider: "p",
            model: "m",
        });
        store.putPending({
            sessionId: "s2",
            startSeq: 1,
            endSeq: 5,
            fingerprint: "new",
            summary: [],
            provider: "p",
            model: "m",
        });
        expect(store.getPending("s2")?.endSeq).toBe(5);
    });

    test("clearPending removes the entry", () => {
        store.putPending({
            sessionId: "s3",
            startSeq: 0,
            endSeq: 1,
            fingerprint: "x",
            summary: [],
            provider: "p",
            model: "m",
        });
        store.clearPending("s3");
        expect(store.getPending("s3")).toBeUndefined();
    });

    test("compartments round-trip", () => {
        store.putCompartments([
            {
                sessionId: "s1",
                startSeq: 10,
                endSeq: 42,
                title: "t",
                episodeType: "feature",
                importance: 82,
                p1: "p1",
                p2: "p2",
                p3: "p3",
                p4: "p4",
                facts: { PROJECT_RULES: ["always commit"] },
            },
        ]);
        const rows = store.listCompartments("s1");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.importance).toBe(82);
        expect(rows[0]?.facts).toEqual({ PROJECT_RULES: ["always commit"] });
    });

    test("survives reopen (durable)", () => {
        const path = join(dir, "reopen.db");
        const a = new McStore(path);
        a.putPending({
            sessionId: "s",
            startSeq: 3,
            endSeq: 9,
            fingerprint: "f",
            summary: [{ type: "text", text: "kept" }],
            provider: "p",
            model: "m",
        });
        a.close();
        const b = new McStore(path);
        expect(b.getPending("s")?.endSeq).toBe(9);
        b.close();
        rmSync(dir, { recursive: true, force: true });
    });
});

describe("inputFingerprint", () => {
    const input: SpanInput = {
        system: "sys",
        tools: [{ name: "read", schema: { type: "object" } }],
        messages: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            { role: "assistant", content: [{ type: "text", text: "world" }] },
        ],
    } as unknown as SpanInput;

    test("is deterministic", () => {
        expect(inputFingerprint(input)).toBe(inputFingerprint(input));
    });

    test("changes when content changes", () => {
        const altered: SpanInput = {
            ...input,
            messages: [
                ...input.messages.slice(0, 1),
                { role: "assistant", content: [{ type: "text", text: "changed" }] },
            ],
        } as unknown as SpanInput;
        expect(inputFingerprint(altered)).not.toBe(inputFingerprint(input));
    });

    test("changes when system changes", () => {
        expect(inputFingerprint({ ...input, system: "other" })).not.toBe(inputFingerprint(input));
    });
});

describe("selectRange", () => {
    /** Fake session exposing the shape selectRange reads. */
    function fakeSession(nodes: number[]) {
        return { surface: { nodes } } as unknown as Parameters<typeof selectRange>[0];
    }

    const priced = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ seq: i + 1, tokens: 100 }));
    const noCheckpoints = () => false;
    const checkpointsAt =
        (...seqs: number[]) =>
        (_session: unknown, seq: number) =>
            seqs.includes(seq);

    test("returns null when the retain budget covers everything", () => {
        expect(
            selectRange(fakeSession([1, 2, 3]), priced(3), 1000, () => false, noCheckpoints),
        ).toBeNull();
    });

    test("selects head-up-to-retain with a passing fence", () => {
        const range = selectRange(
            fakeSession([1, 2, 3, 4, 5]),
            priced(5),
            250,
            () => true,
            noCheckpoints,
        );
        expect(range).toEqual({ start: 1, end: 2 });
    });

    test("walks back to a balanced boundary", () => {
        // fence passes only at seq 1 -> everything but the head is protected
        const range = selectRange(
            fakeSession([1, 2, 3, 4, 5]),
            priced(5),
            250,
            (_session, seq) => seq === 1,
            noCheckpoints,
        );
        expect(range).toBeNull();
    });

    test("skips leading checkpoint nodes so they stay independent", () => {
        // nodes 1-2 are checkpoints; the compactable span starts after them
        const range = selectRange(
            fakeSession([1, 2, 3, 4, 5]),
            priced(5),
            150,
            () => true,
            checkpointsAt(1, 2),
        );
        expect(range).toEqual({ start: 3, end: 3 });
    });

    test("returns null when every compactable node is a checkpoint", () => {
        const range = selectRange(
            fakeSession([1, 2, 3, 4, 5]),
            priced(5),
            150,
            () => true,
            checkpointsAt(1, 2, 3),
        );
        expect(range).toBeNull();
    });

    test("throws when the priced surface disagrees with the session surface", () => {
        expect(() =>
            selectRange(
                fakeSession([1, 2, 3]),
                priced(3).map((n, i) => ({ ...n, seq: n.seq + i + 1 })),
                100,
                () => false,
                noCheckpoints,
            ),
        ).toThrow(/does not match/);
    });
});
