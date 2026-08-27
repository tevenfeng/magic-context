/**
 * SQLite runtime selector for the DSH plugin.
 *
 * Production runtime is Node ≥ 24 (`node:sqlite`); unit tests run under Bun
 * (`bun:sqlite`). Static imports of either would crash at parse time in the
 * other runtime, so the module is picked dynamically at load. The surface we
 * use (exec / prepare().run/get/all / close with `?` positional binds) is
 * identical across both backends.
 */

export interface PreparedStatement {
    run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
}

export interface SqliteDb {
    exec(sql: string): void;
    prepare(sql: string): PreparedStatement;
    close(): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const mod: {
    Database?: new (path: string) => unknown;
    DatabaseSync?: new (path: string) => unknown;
} = isBun ? await import("bun:sqlite") : await import("node:sqlite");

export function openSqliteSync(path: string): SqliteDb {
    if (mod.DatabaseSync !== undefined) {
        return new mod.DatabaseSync(path) as unknown as SqliteDb;
    }
    if (mod.Database !== undefined) {
        return new mod.Database(path) as unknown as SqliteDb;
    }
    throw new Error("no sqlite backend available for this runtime");
}
