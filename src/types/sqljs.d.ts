declare module "sql.js" {
  export interface SqlJsExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface SqlJsStatement {
    bind(values?: unknown[] | Record<string, unknown>): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(values?: unknown[] | Record<string, unknown>): Record<string, unknown>;
    free(): void;
  }

  export interface SqlJsDatabase {
    run(sql: string, params?: unknown[] | Record<string, unknown>): this;
    exec(sql: string, params?: unknown[] | Record<string, unknown>): SqlJsExecResult[];
    prepare(sql: string, params?: unknown[] | Record<string, unknown>): SqlJsStatement;
    export(): Uint8Array;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | ArrayLike<number>) => SqlJsDatabase;
  }

  export interface SqlJsInitOptions {
    locateFile?: (file: string) => string;
  }

  export default function initSqlJs(config?: SqlJsInitOptions): Promise<SqlJsStatic>;
}
