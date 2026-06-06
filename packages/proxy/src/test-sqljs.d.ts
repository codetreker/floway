declare module 'sql.js' {
  export interface SqlJsDatabase {
    run(sql: string): void;
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new () => SqlJsDatabase;
  }

  const initSqlJs: () => Promise<SqlJsStatic>;

  export default initSqlJs;
}

interface ImportMeta {
  glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
}
