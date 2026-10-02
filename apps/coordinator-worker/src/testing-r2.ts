import type {
  R2Bucket,
  R2GetOptions,
  R2Object,
  R2ObjectBody,
  R2Objects,
  R2PutOptions,
} from '@uptime/cloudflare';

interface StoredObject {
  body: string;
  binary?: Uint8Array<ArrayBuffer>;
  httpMetadata?: { contentType?: string; contentEncoding?: string };
  customMetadata: Record<string, string>;
  etag: string;
}

/**
 * In-memory R2 double that models `head`, `get`, `put`, `delete`, and the
 * `onlyIf` conditional-write precondition (R2 returns `null` and does not
 * store the object when the precondition fails).
 */
export class FakeR2 implements R2Bucket {
  readonly store = new Map<string, StoredObject>();
  readonly deleted: string[] = [];
  private etagCounter = 0;

  async head(key: string): Promise<R2Object | null> {
    const value = this.store.get(key);
    if (!value) return null;
    return {
      key,
      version: '1',
      size: value.binary?.byteLength ?? value.body.length,
      etag: value.etag,
      uploaded: new Date(),
      ...(value.httpMetadata ? { httpMetadata: value.httpMetadata } : {}),
      customMetadata: value.customMetadata,
    };
  }

  get(key: string): Promise<R2ObjectBody | null>;
  get(key: string, options: R2GetOptions): Promise<R2ObjectBody | R2Object | null>;
  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
    const value = this.store.get(key);
    if (!value) return null;
    const conditional = options?.onlyIf;
    if (conditional && !(conditional instanceof Headers)) {
      if (conditional.etagMatches !== undefined && conditional.etagMatches !== value.etag) {
        return this.head(key);
      }
    }
    const fullBytes = value.binary ?? new TextEncoder().encode(value.body);
    const range = options?.range;
    const offset = range && !(range instanceof Headers) ? (range.offset ?? 0) : 0;
    const length =
      range && !(range instanceof Headers) ? (range.length ?? fullBytes.length) : fullBytes.length;
    const bytes = fullBytes.subarray(offset, offset + length);
    return {
      key,
      version: '1',
      size: fullBytes.byteLength,
      etag: value.etag,
      uploaded: new Date(),
      ...(value.httpMetadata ? { httpMetadata: value.httpMetadata } : {}),
      customMetadata: value.customMetadata,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
      json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
    };
  }

  async put(key: string, value: unknown, options?: R2PutOptions): Promise<R2Object | null> {
    const existing = this.store.get(key);
    const conditional = options?.onlyIf;
    if (conditional) {
      if (conditional instanceof Headers) {
        const ifNoneMatch = conditional.get('if-none-match');
        if (ifNoneMatch === '*' && existing) return null;
      } else {
        if (conditional.etagMatches !== undefined && existing?.etag !== conditional.etagMatches) {
          return null;
        }
        if (
          conditional.etagDoesNotMatch !== undefined &&
          existing?.etag === conditional.etagDoesNotMatch
        ) {
          return null;
        }
      }
    }
    let binary: Uint8Array<ArrayBuffer> | undefined;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes =
        value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      binary = new Uint8Array(new ArrayBuffer(bytes.byteLength));
      binary.set(bytes);
    }
    const httpMetadata =
      options?.httpMetadata instanceof Headers ? undefined : options?.httpMetadata;
    const body = binary
      ? httpMetadata?.contentEncoding === 'gzip'
        ? await new Response(
            new Blob([binary]).stream().pipeThrough(new DecompressionStream('gzip')),
          ).text()
        : new TextDecoder().decode(binary)
      : typeof value === 'string'
        ? value
        : String(value);
    const metadata =
      options?.customMetadata ??
      (options?.httpMetadata instanceof Headers
        ? Object.fromEntries(options.httpMetadata.entries())
        : undefined);
    this.etagCounter += 1;
    this.store.set(key, {
      body,
      ...(binary ? { binary } : {}),
      ...(httpMetadata ? { httpMetadata } : {}),
      customMetadata: metadata ?? {},
      etag: `etag-${this.etagCounter}`,
    });
    return this.head(key);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.deleted.push(key);
      this.store.delete(key);
    }
  }

  async list(options?: { prefix?: string }): Promise<R2Objects> {
    const keys = [...this.store.keys()].filter(
      (key) => !options?.prefix || key.startsWith(options.prefix),
    );
    const objects = (await Promise.all(keys.map((key) => this.head(key)))).filter(
      (object): object is R2Object => object !== null,
    );
    return { objects, truncated: false };
  }
}
