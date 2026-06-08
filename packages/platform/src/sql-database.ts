// Minimal SQL database contract used by the gateway's repo layer. Cloudflare's
// D1 satisfies the shape directly. `meta.changes` is the only metadata field
// the contract requires; runtime-specific fields (D1's duration, rows_read,
// rows_written) intentionally stay out of the platform surface.
export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: SqlResultMeta;
}

export interface SqlResultMeta {
  changes?: number;
}

export interface SqlPreparedStatement {
  bind(...values: unknown[]): SqlPreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}

export interface SqlDatabase {
  prepare(query: string): SqlPreparedStatement;
  batch?(statements: SqlPreparedStatement[]): Promise<SqlResult[]>;
  // Execute a SQL string that may contain multiple statements. Used by
  // migration runners that need to apply hand-authored DDL files where a
  // single statement contains a `;` (e.g. CREATE TRIGGER ... BEGIN ... END;)
  // and a per-statement bind/run loop would mangle the body. Returns
  // a runtime-defined value the contract does not promise to expose.
  exec(sql: string): Promise<unknown>;
}
