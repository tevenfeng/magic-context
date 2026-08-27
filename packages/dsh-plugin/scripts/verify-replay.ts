/**
 * Real-session replay verifier.
 *
 * Usage: bun run scripts/verify-replay.ts <session.jsonl.zstd>
 *
 * Folds the durable session log twice through the canonical dsh-session
 * surface fold and asserts byte-identical derivation — the reconstructability
 * contract Magic Context's cache stability rides on. Exits 1 on divergence.
 */
import { readFileSync } from "node:fs";
import { decompress } from "fzstd";
import { decodeStorageRecord, deriveEventMessage, foldSurface } from "@deepseek-ai/dsh-session";

const path = process.argv[2];
if (path === undefined) {
    console.error("usage: bun run scripts/verify-replay.ts <session.jsonl.zstd>");
    process.exit(2);
}

const raw = JSON.parse(
    `[${new TextDecoder().decode(decompress(readFileSync(path))).split("\n").filter(Boolean).join(",")}]`,
) as unknown[];
// Skip the JSONL header line; expand packed chunk runs back to exact events.
const events = raw
    .filter((record) => typeof record === "object" && record !== null && (record as { type?: string }).type !== "session")
    .flatMap((record) => decodeStorageRecord(record));

function derive(): { nodes: number[]; messages: unknown[] } {
    const folded = foldSurface(events);
    const messages = folded.nodes.map((seq) => deriveEventMessage(events[seq]));
    return { nodes: folded.nodes, messages };
}

const a = JSON.stringify(derive());
const b = JSON.stringify(derive());

const folded = foldSurface(events);
const checkpoints = folded.nodes.filter((seq) => {
    const message = deriveEventMessage(events[seq]);
    return message?.source !== undefined && message.source.kind === "plugin" && message.source.plugin === "compact";
});

console.log(`events: ${events.length}`);
console.log(`surface nodes: ${folded.nodes.length} (checkpoints: ${checkpoints.length})`);
console.log(`derived bytes: ${a.length}`);
console.log(a === b ? "REPLAY VERDICT: byte-identical ✔" : "REPLAY VERDICT: DIVERGED ✘");
process.exit(a === b ? 0 : 1);
