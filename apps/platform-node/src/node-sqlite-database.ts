import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

// node:sqlite's prepared statement is synchronous and returns plain rows.
// We adapt it to the platform's async, enveloped contract. bind() returns a
// fresh statement object so two awaited binds on the same prepared statement
// never share state.
class NodeSqlitePreparedStatement implements SqlPreparedStatement {
  constructor(
    private readonly stmt: StatementSync,
    private readonly bound: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    return new NodeSqlitePreparedStatement(this.stmt, values);
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.stmt.get(...(this.bound as never[]));
    return Promise.resolve((row as T | undefined) ?? null);
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const rows = this.stmt.all(...(this.bound as never[])) as T[];
    return Promise.resolve({ results: rows, success: true, meta: {} });
  }

  run(): Promise<SqlResult> {
    const result = this.stmt.run(...(this.bound as never[]));
    return Promise.resolve({
      results: [],
      success: true,
      meta: { changes: Number(result.changes) },
    });
  }
}

class NodeSqliteDatabase implements SqlDatabase {
  constructor(private readonly db: DatabaseSync) {}

  prepare(query: string): SqlPreparedStatement {
    return new NodeSqlitePreparedStatement(this.db.prepare(query));
  }

  // Wraps the supplied statements in a single transaction so the batch is
  // atomic.
  async batch(statements: SqlPreparedStatement[]): Promise<SqlResult[]> {
    const results: SqlResult[] = [];
    this.db.exec('BEGIN');
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.db.exec('COMMIT');
    } catch (e) {
      // SQLite auto-rolls-back on a hard error class (SQLITE_FULL,
      // SQLITE_IOERR, SQLITE_BUSY, SQLITE_NOMEM, SQLITE_INTERRUPT — see
      // https://www.sqlite.org/lang_transaction.html "Response To Errors
      // Within A Transaction"); the explicit ROLLBACK then throws
      // "cannot rollback - no transaction is active" and would replace
      // the original failure on the way out. Swallow that recovery throw
      // so `throw e` always wins and the operator sees the real cause.
      try { this.db.exec('ROLLBACK'); } catch { /* txn already auto-rolled-back */ }
      throw e;
    }
    return results;
  }

  exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return Promise.resolve(undefined);
  }
}

export const createNodeSqliteDatabase = (path: string): SqlDatabase => {
  // node:sqlite throws ERR_SQLITE_ERROR ("unable to open database file") when
  // the parent directory is missing — unhelpful on a fresh deploy. Each
  // component owns its own root.
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // node:sqlite leaves foreign keys off by default; the schema relies on FK
  // enforcement, so turn it on at open.
  db.exec('PRAGMA foreign_keys = ON');
  return new NodeSqliteDatabase(db);
};
