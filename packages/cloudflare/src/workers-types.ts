/**
 * Minimal structural Cloudflare Worker binding types.
 *
 * These intentionally mirror the public `@cloudflare/workers-types` surface we
 * use (R2 + Hyperdrive) without adding a dependency or touching the repository
 * lockfile. When a project installs `@cloudflare/workers-types`, its global
 * declarations are assignable to these interfaces, so the shared helpers remain
 * compatible.
 */

/** Hyperdrive with query caching disabled in deployment configuration. */
export interface PostgresHyperdriveBinding {
  readonly connectionString: string;
}

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
