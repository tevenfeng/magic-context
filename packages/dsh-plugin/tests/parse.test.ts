import { describe, expect, test } from "bun:test";
import { parseCompartmentOutput, renderCompartments } from "../src/parse";

const VALID_OUTPUT = `<output>
<compartments>
<compartment start="10" end="42" title="Added markdown outline support" episode_type="design,feature" importance="82">
<p1>
User asked for outline support in markdown files. We designed a tree-sitter based extractor, implemented it in src/extractor.ts, fixed the affected tests, and committed as abc1234.
</p1>
<p2>
Added markdown outline support: tree-sitter extractor in src/extractor.ts, tests fixed, commit abc1234.
</p2>
<p3>
Markdown outline extraction landed via tree-sitter.
</p3>
<p4>markdown outline, tree-sitter, abc1234</p4>
</compartment>
<compartment start="43" end="60" title="Bumped dependencies" episode_type="infra" importance="30">
<p1>
Routine dependency bump across six files; CI green.
</p1>
<p2>
Dependency bump across six files; CI green.
</p2>
<p3>
Dependencies bumped; CI green.
</p3>
<p4/>
</compartment>
</compartments>
<facts>
<PROJECT_RULES>
* Always commit and build after every fix
</PROJECT_RULES>
<ARCHITECTURE>
* Outline extraction is tree-sitter based
</ARCHITECTURE>
</facts>
<meta>
<messages_processed>10-60</messages_processed>
</meta>
</output>`;

const MISMATCHED_TAGS = `<output>
<compartments>
<compartment start="1" end="5" title="Broken tags" episode_type="bug" importance="90">
<p1>
Verbose body with U: "keep this wording" inline.
</p2>
<p2>
Condensed body.
</p2>
<p3>
Outcome.
</p3>
<p4>anchor</p4>
</compartment>
</compartments>
</output>`;

describe("parseCompartmentOutput", () => {
    test("parses a valid two-compartment output with facts", () => {
        const out = parseCompartmentOutput(VALID_OUTPUT);
        expect(out.compartments).toHaveLength(2);
        const first = out.compartments[0]!;
        expect(first.start).toBe(10);
        expect(first.end).toBe(42);
        expect(first.title).toBe("Added markdown outline support");
        expect(first.episodeType).toBe("design,feature");
        expect(first.importance).toBe(82);
        expect(first.p1).toContain("tree-sitter based extractor");
        expect(first.p4).toBe("markdown outline, tree-sitter, abc1234");
        expect(out.facts.PROJECT_RULES).toEqual(["Always commit and build after every fix"]);
        expect(out.facts.ARCHITECTURE).toEqual(["Outline extraction is tree-sitter based"]);
        expect(out.facts.CONSTRAINTS).toBeUndefined();
    });

    test("tolerates mismatched tier closing tags", () => {
        const out = parseCompartmentOutput(MISMATCHED_TAGS);
        expect(out.compartments).toHaveLength(1);
        const c = out.compartments[0]!;
        // p1 terminates at the first </p2> closer; p2 then runs until its own
        // closer — both bodies must contain their intended text.
        expect(c.p1).toContain("Verbose body");
        expect(c.p2).toBe("Condensed body.");
    });

    test("treats self-closing p4 as an empty anchor", () => {
        const out = parseCompartmentOutput(VALID_OUTPUT);
        expect(out.compartments[1]!.p4).toBe("");
        expect(out.compartments[1]!.importance).toBe(30);
    });

    test("handles missing facts and events", () => {
        const bare = `<compartments><compartment start="1" end="2" title="t" importance="10"><p1>a</p1><p2>b</p2><p3>c</p3><p4>d</p4></compartment></compartments>`;
        const out = parseCompartmentOutput(bare);
        expect(out.facts).toEqual({});
        expect(out.events).toBeUndefined();
        expect(out.compartments[0]!.importance).toBe(10);
    });

    test("returns empty compartments for garbage", () => {
        const out = parseCompartmentOutput("hello world, no xml here");
        expect(out.compartments).toHaveLength(0);
    });
});

describe("renderCompartments", () => {
    test("picks tier by importance and is deterministic", () => {
        const out = parseCompartmentOutput(VALID_OUTPUT);
        const a = renderCompartments(out);
        const b = renderCompartments(out);
        expect(a).toBe(b);
        // importance 82 -> p1, importance 30 -> p3
        expect(a).toContain("tree-sitter based extractor");
        expect(a).not.toContain("Condensed body");
        expect(a).toContain("Dependencies bumped; CI green.");
        expect(a).toContain("## Durable facts");
        expect(a).toContain("PROJECT_RULES:");
    });
});
