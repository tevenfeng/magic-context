/**
 * MC SQLite store for the DSH plugin (async historian state).
 *
 * Separate database file from the OpenCode/Pi plugin: the schemas differ and
 * nothing is shared. Default path follows the CortexKit data dir; override
 * with MC_DSH_DB (used by the smoke environment and tests).
 *
 * Only the async-historian pipeline touches this file: pending publishes and
 * the compartment ledger. DSH's own state stays in the session log — the
 * rendered checkpoint text is durable in the surface itself.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { openSqliteSync, type SqliteDb } from "./sqlite";

export interface PendingPublish {
    sessionId: string;
    startSeq: number;
    endSeq: number;
    fingerprint: string;
    summary: ContentBlock[];
    provider: string;
    model: string;
    maxTokens?: number;
    /** Node-level tier texts + importance, rendered at publish for later decay. */
    node?: {
        importance: number;
        p1: string;
        p2: string;
        p3: string;
        p4: string;
    };
}

export interface NodeRender {
    sessionId: string;
    checkpointSeq: number;
    importance: number;
    provider: string;
    model: string;
    p1: string;
    p2: string;
    p3: string;
    p4: string;
    renderedTier: number;
}

export interface CompartmentRow {
    sessionId: string;
    startSeq: number;
    endSeq: number;
    title: string;
    episodeType: string;
    importance: number;
    p1: string;
    p2: string;
    p3: string;
    p4: string;
    facts: Record<string, string[]>;
}

function defaultDbPath(): string {
    const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    return join(base, "cortexkit", "magic-context", "dsh-context.db");
}

export class McStore {
    private readonly db: SqliteDb;

    constructor(path: string = process.env.MC_DSH_DB ?? defaultDbPath()) {
        mkdirSync(dirname(path), { recursive: true });
        this.db = openSqliteSync(path);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA busy_timeout = 5000");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS mc_pending_publish (
                session_id  TEXT PRIMARY KEY,
                start_seq   INTEGER NOT NULL,
                end_seq     INTEGER NOT NULL,
                fingerprint TEXT NOT NULL,
                summary_json TEXT NOT NULL,
                provider    TEXT NOT NULL,
                model       TEXT NOT NULL,
                max_tokens  INTEGER,
                node_json   TEXT,
                created_at  INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mc_compartments (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id   TEXT NOT NULL,
                start_seq    INTEGER NOT NULL,
                end_seq      INTEGER NOT NULL,
                title        TEXT NOT NULL,
                episode_type TEXT NOT NULL,
                importance   INTEGER NOT NULL,
                p1           TEXT NOT NULL,
                p2           TEXT NOT NULL,
                p3           TEXT NOT NULL,
                p4           TEXT NOT NULL,
                facts_json   TEXT NOT NULL,
                created_at   INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mc_node_renders (
                session_id     TEXT NOT NULL,
                checkpoint_seq INTEGER NOT NULL,
                importance     INTEGER NOT NULL,
                provider       TEXT NOT NULL,
                model          TEXT NOT NULL,
                p1             TEXT NOT NULL,
                p2             TEXT NOT NULL,
                p3             TEXT NOT NULL,
                p4             TEXT NOT NULL,
                rendered_tier  INTEGER NOT NULL DEFAULT 1,
                created_at     INTEGER NOT NULL,
                PRIMARY KEY (session_id, checkpoint_seq)
            );
            CREATE TABLE IF NOT EXISTS mc_tags (
                tag_id     INTEGER PRIMARY KEY,
                session_id TEXT NOT NULL,
                seq        INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mc_drop_queue (
                session_id TEXT NOT NULL,
                tag_id     INTEGER NOT NULL,
                seq        INTEGER NOT NULL,
                drop_mode  TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, tag_id)
            );
            CREATE TABLE IF NOT EXISTS mc_tag_counter (
                id INTEGER PRIMARY KEY,
                n  INTEGER NOT NULL
            );
        `);
        this.db.prepare("INSERT OR IGNORE INTO mc_tag_counter (id, n) VALUES (1, 0)").run();
        // Unreleased-schema tolerance: add node_json to pre-existing dev DBs.
        const columns = this.db.prepare("PRAGMA table_info(mc_pending_publish)").all() as Array<{
            name: string;
        }>;
        if (!columns.some((c) => c.name === "node_json")) {
            this.db.exec("ALTER TABLE mc_pending_publish ADD COLUMN node_json TEXT");
        }
    }

    getPending(sessionId: string): PendingPublish | undefined {
        const row = this.db
            .prepare(
                `SELECT start_seq, end_seq, fingerprint, summary_json, provider, model, max_tokens, node_json
                 FROM mc_pending_publish WHERE session_id = ?`,
            )
            .get(sessionId) as
            | {
                  start_seq: number;
                  end_seq: number;
                  fingerprint: string;
                  summary_json: string;
                  provider: string;
                  model: string;
                  max_tokens: number | null;
                  node_json: string | null;
              }
            | undefined;
        if (row === undefined || row === null) return undefined;
        return {
            sessionId,
            startSeq: row.start_seq,
            endSeq: row.end_seq,
            fingerprint: row.fingerprint,
            summary: JSON.parse(row.summary_json) as ContentBlock[],
            provider: row.provider,
            model: row.model,
            ...(row.max_tokens === null ? {} : { maxTokens: row.max_tokens }),
            ...(row.node_json === null
                ? {}
                : { node: JSON.parse(row.node_json) as PendingPublish["node"] }),
        };
    }

    putPending(entry: PendingPublish): void {
        this.db
            .prepare(
                `INSERT INTO mc_pending_publish
                   (session_id, start_seq, end_seq, fingerprint, summary_json, provider, model, max_tokens, node_json, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(session_id) DO UPDATE SET
                   start_seq = excluded.start_seq, end_seq = excluded.end_seq,
                   fingerprint = excluded.fingerprint, summary_json = excluded.summary_json,
                   provider = excluded.provider, model = excluded.model,
                   max_tokens = excluded.max_tokens, node_json = excluded.node_json,
                   created_at = excluded.created_at`,
            )
            .run(
                entry.sessionId,
                entry.startSeq,
                entry.endSeq,
                entry.fingerprint,
                JSON.stringify(entry.summary),
                entry.provider,
                entry.model,
                entry.maxTokens ?? null,
                entry.node === undefined ? null : JSON.stringify(entry.node),
                Date.now(),
            );
    }

    clearPending(sessionId: string): void {
        this.db.prepare("DELETE FROM mc_pending_publish WHERE session_id = ?").run(sessionId);
    }

    putNodeRender(row: NodeRender): void {
        this.db
            .prepare(
                `INSERT INTO mc_node_renders
                   (session_id, checkpoint_seq, importance, provider, model, p1, p2, p3, p4, rendered_tier, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(session_id, checkpoint_seq) DO UPDATE SET
                   importance = excluded.importance, provider = excluded.provider,
                   model = excluded.model, p1 = excluded.p1, p2 = excluded.p2,
                   p3 = excluded.p3, p4 = excluded.p4,
                   rendered_tier = excluded.rendered_tier`,
            )
            .run(
                row.sessionId,
                row.checkpointSeq,
                row.importance,
                row.provider,
                row.model,
                row.p1,
                row.p2,
                row.p3,
                row.p4,
                row.renderedTier,
                Date.now(),
            );
    }

    /** Committed node renders, newest checkpoint first (decay age ordering). */
    listNodeRenders(sessionId: string): NodeRender[] {
        const rows = this.db
            .prepare(
                `SELECT checkpoint_seq, importance, provider, model, p1, p2, p3, p4, rendered_tier
                 FROM mc_node_renders WHERE session_id = ? ORDER BY checkpoint_seq DESC`,
            )
            .all(sessionId) as Array<{
            checkpoint_seq: number;
            importance: number;
            provider: string;
            model: string;
            p1: string;
            p2: string;
            p3: string;
            p4: string;
            rendered_tier: number;
        }>;
        return rows.map((row) => ({
            sessionId,
            checkpointSeq: row.checkpoint_seq,
            importance: row.importance,
            provider: row.provider,
            model: row.model,
            p1: row.p1,
            p2: row.p2,
            p3: row.p3,
            p4: row.p4,
            renderedTier: row.rendered_tier,
        }));
    }

    /** After a decay re-render: move the row to the new node seq and tier. */
    updateNodeRender(sessionId: string, oldSeq: number, newSeq: number, tier: number): void {
        this.db
            .prepare(
                `UPDATE mc_node_renders SET checkpoint_seq = ?, rendered_tier = ? WHERE session_id = ? AND checkpoint_seq = ?`,
            )
            .run(newSeq, tier, sessionId, oldSeq);
    }

    /** Drop ledger rows whose checkpoint node was folded into a later compaction. */
    deleteNodeRender(sessionId: string, checkpointSeq: number): void {
        this.db
            .prepare("DELETE FROM mc_node_renders WHERE session_id = ? AND checkpoint_seq = ?")
            .run(sessionId, checkpointSeq);
    }

    /** Process-wide monotonic tag id for `[ctx §N§]` markers (global uniqueness). */
    nextTagId(): number {
        const row = this.db
            .prepare("UPDATE mc_tag_counter SET n = n + 1 WHERE id = 1 RETURNING n")
            .get() as { n: number } | undefined | null;
        return row?.n ?? 1;
    }

    putTag(tagId: number, sessionId: string, seq: number): void {
        this.db
            .prepare(
                "INSERT OR IGNORE INTO mc_tags (tag_id, session_id, seq, created_at) VALUES (?, ?, ?, ?)",
            )
            .run(tagId, sessionId, seq, Date.now());
    }

    resolveTag(tagId: number): { sessionId: string; seq: number } | undefined {
        const row = this.db
            .prepare("SELECT session_id, seq FROM mc_tags WHERE tag_id = ?")
            .get(tagId) as { session_id: string; seq: number } | undefined | null;
        if (row === undefined || row === null) return undefined;
        return { sessionId: row.session_id, seq: row.seq };
    }

    /** Idempotent drop enqueue (one pending drop per tag). */
    queueDrop(sessionId: string, tagId: number, seq: number, dropMode: string): boolean {
        const result = this.db
            .prepare(
                `INSERT OR IGNORE INTO mc_drop_queue (session_id, tag_id, seq, drop_mode, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(sessionId, tagId, seq, dropMode, Date.now());
        return Number(result.changes) > 0;
    }

    listDropQueue(
        sessionId: string,
        limit: number,
    ): Array<{ tagId: number; seq: number; dropMode: string }> {
        const rows = this.db
            .prepare(
                "SELECT tag_id, seq, drop_mode FROM mc_drop_queue WHERE session_id = ? ORDER BY created_at LIMIT ?",
            )
            .all(sessionId, limit) as Array<{ tag_id: number; seq: number; drop_mode: string }>;
        return rows.map((row) => ({ tagId: row.tag_id, seq: row.seq, dropMode: row.drop_mode }));
    }

    deleteDrop(sessionId: string, tagId: number): void {
        this.db
            .prepare("DELETE FROM mc_drop_queue WHERE session_id = ? AND tag_id = ?")
            .run(sessionId, tagId);
    }

    putCompartments(rows: CompartmentRow[]): void {
        const insert = this.db.prepare(
            `INSERT INTO mc_compartments
               (session_id, start_seq, end_seq, title, episode_type, importance, p1, p2, p3, p4, facts_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of rows) {
            insert.run(
                row.sessionId,
                row.startSeq,
                row.endSeq,
                row.title,
                row.episodeType,
                row.importance,
                row.p1,
                row.p2,
                row.p3,
                row.p4,
                JSON.stringify(row.facts),
                Date.now(),
            );
        }
    }

    listCompartments(sessionId: string): CompartmentRow[] {
        const rows = this.db
            .prepare(
                `SELECT start_seq, end_seq, title, episode_type, importance, p1, p2, p3, p4, facts_json
                 FROM mc_compartments WHERE session_id = ? ORDER BY start_seq`,
            )
            .all(sessionId) as Array<{
            start_seq: number;
            end_seq: number;
            title: string;
            episode_type: string;
            importance: number;
            p1: string;
            p2: string;
            p3: string;
            p4: string;
            facts_json: string;
        }>;
        return rows.map((row) => ({
            sessionId,
            startSeq: row.start_seq,
            endSeq: row.end_seq,
            title: row.title,
            episodeType: row.episode_type,
            importance: row.importance,
            p1: row.p1,
            p2: row.p2,
            p3: row.p3,
            p4: row.p4,
            facts: JSON.parse(row.facts_json) as Record<string, string[]>,
        }));
    }

    close(): void {
        this.db.close();
    }
}
