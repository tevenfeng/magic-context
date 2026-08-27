import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    dropPlaceholder,
    enrichWithMarker,
    executeCtxReduce,
    firstMarkerTag,
    parseCtxReduceArgs,
    parseTagMarker,
} from "../src/reduce";
import { McStore } from "../src/store";

describe("tag markers", () => {
    test("parses multiple markers from text", () => {
        expect(parseTagMarker("read output [ctx §12§] and [ctx §3§]")).toEqual([12, 3]);
        expect(parseTagMarker("nothing here")).toEqual([]);
        expect(parseTagMarker("[ctx §0§] [ctx §-1§]")).toEqual([]);
    });

    test("extracts the first marker from content blocks", () => {
        expect(
            firstMarkerTag([
                { type: "text", text: "no marker" },
                { type: "text", text: "with [ctx §7§] marker" },
            ]),
        ).toBe(7);
        expect(firstMarkerTag([{ type: "text", text: "none" }])).toBeUndefined();
        expect(firstMarkerTag(undefined)).toBeUndefined();
    });

    test("enrichment appends a deterministic marker block", () => {
        const enriched = enrichWithMarker([{ type: "text", text: "result" }], 42);
        expect(enriched).toHaveLength(2);
        expect(enriched[1]).toEqual({ type: "text", text: "\n\n[ctx §42§]" });
        expect(firstMarkerTag(enriched)).toBe(42);
    });

    test("drop placeholder is a pure function of the tag id", () => {
        expect(dropPlaceholder(9)).toBe("[dropped §9§]");
        expect(dropPlaceholder(9)).toBe(dropPlaceholder(9));
    });

    test("argument parsing validates tag shapes", () => {
        expect(parseCtxReduceArgs({ tags: ["§1§", "§2§"] })).toEqual({ tagIds: [1, 2] });
        expect(parseCtxReduceArgs({ tags: ["§3§ nope"] }).tagIds).toEqual([3]);
        expect(parseCtxReduceArgs({ tags: ["oops"] }).error).toContain("not a valid");
        expect(parseCtxReduceArgs({ tags: "§1§" }).error).toContain("must be an array");
        expect(parseCtxReduceArgs(undefined).error).toContain("must be an array");
    });
});

describe("executeCtxReduce + drop queue", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-dsh-reduce-"));
    const store = new McStore(join(dir, "test.db"));

    test("queues drops idempotently and reports unknown tags", () => {
        const tag = store.nextTagId();
        store.putTag(tag, "s1", 100);
        const first = executeCtxReduce(store, { tags: [`§${tag}§`] });
        expect(first).toEqual({ queued: 1, dropped: 0, missing: 0 });
        const second = executeCtxReduce(store, { tags: [`§${tag}§`, "§999§"] });
        expect(second).toEqual({ queued: 0, dropped: 1, missing: 1 });
        const queue = store.listDropQueue("s1", 10);
        expect(queue).toHaveLength(1);
        expect(queue[0]).toEqual({ tagId: tag, seq: 100, dropMode: "full" });
    });

    test("tag ids are globally monotonic", () => {
        const a = store.nextTagId();
        const b = store.nextTagId();
        expect(b).toBeGreaterThan(a);
    });

    test("deleteDrop removes only the target", () => {
        const t1 = store.nextTagId();
        const t2 = store.nextTagId();
        store.putTag(t1, "s2", 1);
        store.putTag(t2, "s2", 2);
        store.queueDrop("s2", t1, 1, "full");
        store.queueDrop("s2", t2, 2, "full");
        store.deleteDrop("s2", t1);
        expect(store.listDropQueue("s2", 10)).toHaveLength(1);
        rmSync(dir, { recursive: true, force: true });
    });
});
