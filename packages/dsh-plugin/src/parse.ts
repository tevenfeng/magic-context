/**
 * Lenient compartment-output parser for the DSH POC engine.
 *
 * Mirrors the OpenCode parser's tolerance posture
 * (packages/plugin/src/hooks/magic-context/compartment-parser.ts):
 * mismatched closing tier tags (e.g. `<p1>...</p2>`) terminate a tier instead
 * of rejecting the output; self-closing `<p4/>` is a valid P4; missing attrs
 * fall back to safe defaults. Strictness returns with the incremental runner.
 */

export interface Compartment {
    start: number;
    end: number;
    title: string;
    episodeType: string;
    importance: number;
    p1: string;
    p2: string;
    p3: string;
    p4: string;
}

export interface CompartmentOutput {
    compartments: Compartment[];
    facts: Partial<Record<FactCategory, string[]>>;
    /** Raw events XML when present, trimmed; undefined otherwise. */
    events?: string;
    unprocessedFrom?: number;
}

export type FactCategory =
    | "PROJECT_RULES"
    | "ARCHITECTURE"
    | "CONSTRAINTS"
    | "CONFIG_VALUES"
    | "NAMING";

const FACT_CATEGORIES: FactCategory[] = [
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
];

const INT_RE = /([+-]?\d+)/;

function attr(tag: string, name: string): string | undefined {
    const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i");
    const m = re.exec(tag);
    return m?.[1];
}

function attrInt(tag: string, name: string, fallback: number): number {
    const raw = attr(tag, name);
    if (raw === undefined) return fallback;
    const m = INT_RE.exec(raw);
    const n = m === null ? NaN : Number.parseInt(m[1], 10);
    return Number.isFinite(n) ? n : fallback;
}

/** Extract the four tier bodies from one compartment's inner text. Lenient. */
function extractTiers(inner: string): {
    p1: string;
    p2: string;
    p3: string;
    p4: string;
} {
    const tiers: Record<"p1" | "p2" | "p3" | "p4", string> = {
        p1: "",
        p2: "",
        p3: "",
        p4: "",
    };
    const tierOpenRe = /<\s*(p[1-4])\s*>/gi;
    let m: RegExpExecArray | null;
    // Walk openers; each tier body ends at the next opener or any closing tier tag.
    while ((m = tierOpenRe.exec(inner)) !== null) {
        const name = (m[1] ?? "p1").toLowerCase() as "p1" | "p2" | "p3" | "p4";
        const bodyStart = m.index + m[0].length;
        // Find the earliest terminator: another opening tier tag, or any closing
        // tier tag (matching or not), or a self-closing p4.
        const nextOpen = /<\s*p[1-4]\s*>/gi.exec(inner.slice(bodyStart));
        const nextClose = /<\s*\/\s*p[1-4]\s*>/gi.exec(inner.slice(bodyStart));
        const cand = [nextOpen?.index ?? Infinity, nextClose?.index ?? Infinity];
        const end = Math.min(...cand);
        tiers[name] = inner
            .slice(bodyStart, end === Infinity ? inner.length : bodyStart + end)
            .trim();
    }
    // Self-closing <p4/> (no body): handle explicitly since it has no closer.
    if (tiers.p4 === "") {
        const sc = /<\s*p4\s*\/\s*>/gi.exec(inner);
        if (sc !== null) tiers.p4 = "";
    }
    return tiers;
}

function parseCompartments(text: string): Compartment[] {
    const out: Compartment[] = [];
    const blockRe =
        /<\s*compartment\b([^>]*)>([\s\S]*?)(?=<\s*compartment\b|<\s*\/\s*compartments\s*>|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(text)) !== null) {
        const tag = m[1];
        const inner = m[2];
        const tiers = extractTiers(inner);
        out.push({
            start: attrInt(tag, "start", 0),
            end: attrInt(tag, "end", 0),
            title: attr(tag, "title") ?? "untitled",
            episodeType: attr(tag, "episode_type") ?? "unknown",
            importance: Math.min(100, Math.max(0, attrInt(tag, "importance", 50))),
            ...tiers,
        });
    }
    return out;
}

function parseFacts(text: string): Partial<Record<FactCategory, string[]>> {
    const facts: Partial<Record<FactCategory, string[]>> = {};
    const factsBlock = /<\s*facts\s*>([\s\S]*?)<\s*\/\s*facts\s*>/i.exec(text)?.[1];
    if (factsBlock === undefined) return facts;
    for (const cat of FACT_CATEGORIES) {
        const catRe = new RegExp(`<\\s*${cat}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${cat}\\s*>`, "i");
        const cm = catRe.exec(factsBlock);
        if (cm === null) continue;
        const items = cm[1]
            .split("\n")
            .map((line) => line.replace(/^\s*\*?\s*/, "").trim())
            .filter((line) => line.length > 0);
        if (items.length > 0) facts[cat] = items;
    }
    return facts;
}

export function parseCompartmentOutput(text: string): CompartmentOutput {
    const compartments = parseCompartments(text);
    const facts = parseFacts(text);
    const eventsBlock = /<\s*events\s*>([\s\S]*?)<\s*\/\s*events\s*>/i.exec(text)?.[1]?.trim();
    const unprocessed = /<\s*unprocessed_from\s*>([\s\S]*?)<\s*\/\s*unprocessed_from\s*>/i
        .exec(text)?.[1]
        ?.trim();
    const unprocessedFromMatch = unprocessed !== undefined ? INT_RE.exec(unprocessed) : null;
    return {
        compartments,
        facts,
        ...(eventsBlock !== undefined && eventsBlock.length > 0 ? { events: eventsBlock } : {}),
        ...(unprocessedFromMatch !== null
            ? { unprocessedFrom: Number.parseInt(unprocessedFromMatch[1] ?? "0", 10) }
            : {}),
    };
}

/**
 * Deterministic renderer. With no forced tier, selection is a fixed
 * importance rule (75/50/25 cutoffs). With a forced tier (1..4), every
 * compartment renders at that tier — the decay renderer's building block for
 * node-level demotion. Same input always renders the same bytes.
 */
export function renderCompartments(parsed: CompartmentOutput, forcedTier?: 1 | 2 | 3 | 4): string {
    const sections: string[] = [];
    for (const c of parsed.compartments) {
        const tier =
            forcedTier === undefined
                ? c.importance >= 75
                    ? c.p1
                    : c.importance >= 50
                      ? c.p2
                      : c.importance >= 25
                        ? c.p3
                        : c.p4
                : { 1: c.p1, 2: c.p2, 3: c.p3, 4: c.p4 }[forcedTier];
        const body = tier.length > 0 ? tier : `[${c.title}]`;
        sections.push(`### ${c.title} (importance ${c.importance}, ${c.episodeType})`, body);
    }
    const factEntries = FACT_CATEGORIES.filter((cat) => parsed.facts[cat]?.length);
    if (factEntries.length > 0) {
        sections.push("## Durable facts");
        for (const cat of factEntries) {
            sections.push(`${cat}:`, ...(parsed.facts[cat] ?? []).map((f) => `- ${f}`));
        }
    }
    if (parsed.events !== undefined && parsed.events.length > 0) {
        sections.push("## Events", parsed.events);
    }
    return sections.join("\n\n");
}
