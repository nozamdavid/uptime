import { createHash, createHmac } from 'node:crypto';

import type { R2Bucket, R2Object, R2ObjectBody, R2Objects, R2PutOptions } from '@uptime/cloudflare';

export interface R2S3Options {
  /** https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

const emptyPayloadHash = createHash('sha256').update('').digest('hex');
const requestTimeoutMs = 15_000;

const hmac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest();
const hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]!;
  });
}

function tag(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? xmlText(match[1]!) : undefined;
}

/**
 * Minimal R2 bucket over the S3-compatible API (SigV4, path style). Implements
 * only the operations the API uses: head, get, put, delete, and list. Unsupported
 * options throw instead of being silently ignored.
 */
export function createR2S3Bucket(options: R2S3Options): R2Bucket {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(endpoint.hostname))
    throw new Error('R2 endpoint must use https');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket))
    throw new Error('Invalid R2 bucket name');
  const clock = options.now ?? (() => new Date());

  async function send(
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE',
    key: string | null,
    query: Record<string, string> = {},
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const segments = key === null ? [] : key.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..'))
      throw new Error('Invalid R2 object key');
    const path = `/${[options.bucket, ...segments].map(encode).join('/')}`;
    const canonicalQuery = Object.entries(query)
      .map(([name, value]) => [encode(name), encode(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('&');
    const stamp = clock()
      .toISOString()
      .replace(/[-:]|\.\d{3}/g, '');
    const date = stamp.slice(0, 8);
    const payloadHash = body ? hex(body) : emptyPayloadHash;
    const headers: Record<string, string> = {
      ...extraHeaders,
      host: endpoint.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
    };
    const names = Object.keys(headers)
      .map((name) => name.toLowerCase())
      .sort();
    const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const scope = `${date}/auto/s3/aws4_request`;
    const canonical = [
      method,
      path,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, date), 'auto'), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey)
      .update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hex(canonical)}`)
      .digest('hex');
    const { host: _host, ...sendHeaders } = headers;
    const url = `${endpoint.origin}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
    return (options.fetch ?? fetch)(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: {
        ...sendHeaders,
        authorization: `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }

  /** Only ETag preconditions map to S3 If-Match / If-None-Match. Anything else throws. */
  function putPreconditions(onlyIf: R2PutOptions['onlyIf']): Record<string, string> {
    if (onlyIf === undefined) return {};
    const result: Record<string, string> = {};
    if (onlyIf instanceof Headers) {
      for (const [name, value] of onlyIf.entries()) {
        if (name !== 'if-match' && name !== 'if-none-match')
          throw new Error('R2 conditional put options are unsupported');
        result[name] = value;
      }
      return result;
    }
    const { etagMatches, etagDoesNotMatch, ...rest } = onlyIf;
    if (Object.values(rest).some((value) => value !== undefined))
      throw new Error('R2 conditional put options are unsupported');
    if (etagMatches !== undefined) result['if-match'] = `"${etagMatches}"`;
    if (etagDoesNotMatch !== undefined) result['if-none-match'] = `"${etagDoesNotMatch}"`;
    return result;
  }

  function failure(operation: string, response: Response): Error {
    // Status only: upstream bodies can echo request details.
    void response.body?.cancel().catch(() => undefined);
    return new Error(`R2 ${operation} failed with HTTP ${response.status}`);
  }

  function metadata(key: string, headers: Headers): R2Object {
    // GET responses can carry a weak validator (W/"hex"); the stored value is the bare hex.
    const etag = (headers.get('etag') ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
    return {
      key,
      version: '',
      size: Number(headers.get('content-length') ?? 0),
      etag,
      httpEtag: headers.get('etag') ?? '',
      uploaded: new Date(headers.get('last-modified') ?? 0),
    } as R2Object;
  }

  return {
    async head(key) {
      const response = await send('HEAD', key);
      if (response.status === 404) return null;
      if (!response.ok) throw failure('head', response);
      return metadata(key, response.headers);
    },
    async get(key: string, getOptions?: object) {
      if (getOptions !== undefined) throw new Error('R2 get options are unsupported');
      const response = await send('GET', key);
      if (response.status === 404) {
        void response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok || !response.body) throw failure('get', response);
      return {
        ...metadata(key, response.headers),
        body: response.body,
        arrayBuffer: () => response.arrayBuffer(),
        text: () => response.text(),
        json: <T>() => response.json() as Promise<T>,
      } as unknown as R2ObjectBody;
    },
    async put(key, value, putOptions?: R2PutOptions) {
      if (putOptions?.md5 !== undefined)
        throw new Error('R2 conditional put options are unsupported');
      const preconditions = putPreconditions(putOptions?.onlyIf);
      const body =
        value === null
          ? Buffer.alloc(0)
          : typeof value === 'string'
            ? Buffer.from(value)
            : Buffer.from(await new Response(value as BodyInit).arrayBuffer());
      const meta = putOptions?.httpMetadata;
      const response = await send('PUT', key, {}, body, {
        ...(meta && !(meta instanceof Headers) && meta.contentType
          ? { 'content-type': meta.contentType }
          : {}),
        ...preconditions,
      });
      if (response.status === 412) {
        // Same contract as the Workers binding: a failed precondition returns null.
        void response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok) throw failure('put', response);
      void response.body?.cancel().catch(() => undefined);
      return metadata(key, response.headers);
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const response = await send('DELETE', key);
        if (!response.ok && response.status !== 404) throw failure('delete', response);
        void response.body?.cancel().catch(() => undefined);
      }
    },
    async list(listOptions): Promise<R2Objects> {
      const query: Record<string, string> = {
        'list-type': '2',
        'max-keys': String(Math.min(listOptions?.limit ?? 1000, 1000)),
      };
      if (listOptions?.prefix) query.prefix = listOptions.prefix;
      if (listOptions?.cursor) query['continuation-token'] = listOptions.cursor;
      if (listOptions?.delimiter) query.delimiter = listOptions.delimiter;
      const response = await send('GET', null, query);
      if (!response.ok) throw failure('list', response);
      const xml = await response.text();
      const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
        const block = match[1]!;
        const etag = tag(block, 'ETag') ?? '';
        return {
          key: tag(block, 'Key') ?? '',
          version: '',
          size: Number(tag(block, 'Size') ?? 0),
          etag: etag.replace(/^"|"$/g, ''),
          httpEtag: etag,
          uploaded: new Date(tag(block, 'LastModified') ?? 0),
        } as R2Object;
      });
      const cursor = tag(xml, 'NextContinuationToken');
      return {
        objects,
        truncated: tag(xml, 'IsTruncated') === 'true',
        ...(cursor ? { cursor } : {}),
      };
    },
  } as R2Bucket;
}
