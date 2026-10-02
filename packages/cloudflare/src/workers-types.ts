/**
 * Minimal structural Cloudflare Worker binding types.
 *
 * These intentionally mirror the public `@cloudflare/workers-types` surface we
 * use (D1 + R2) without adding a dependency or touching the repository lockfile.
 * When a project installs `@cloudflare/workers-types`, its global declarations
 * are assignable to these interfaces, so the shared helpers remain compatible.
 */

export interface D1Meta {
  readonly duration: number;
  readonly size_after: number;
  readonly rows_read: number;
  readonly rows_written: number;
  readonly last_row_id: number;
  readonly changed_db: boolean;
  readonly changes: number;
}

export interface D1Result<T = Record<string, unknown>> {
  readonly results: T[];
  readonly success: boolean;
  readonly meta: D1Meta & Record<string, unknown>;
  readonly error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
  dump(): Promise<ArrayBuffer>;
}

/** Values accepted by `D1PreparedStatement.bind`. */
export type D1Value = string | number | null | ArrayBuffer | ArrayBufferView;

export interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
}

export interface R2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: R2HTTPMetadata;
  readonly customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  readonly body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export interface R2Conditional {
  etagMatches?: string;
  etagDoesNotMatch?: string;
  uploadedBefore?: Date;
  uploadedAfter?: Date;
}

export interface R2GetOptions {
  onlyIf?: R2Conditional | Headers;
  range?: { offset?: number; length?: number; suffix?: number } | Headers;
}

export interface R2PutOptions {
  onlyIf?: R2Conditional | Headers;
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
  md5?: ArrayBuffer | string;
}

export interface R2Objects {
  readonly objects: R2Object[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  get(key: string, options: R2GetOptions): Promise<R2ObjectBody | R2Object | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | Blob | ReadableStream | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    delimiter?: string;
    include?: ('httpMetadata' | 'customMetadata')[];
  }): Promise<R2Objects>;
}
