import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { createHttpBinding, createPublicOnlyFetch } from './node-bindings.js';
import { createR2S3Bucket } from './r2-s3.js';

describe('public-only fetch', () => {
  it('rejects literal private addresses without connecting', async () => {
    const guarded = createPublicOnlyFetch();
    const refused = 'private or reserved address';
    await expect(guarded('http://127.0.0.1:1234/')).rejects.toThrow(refused);
    await expect(guarded('http://[::1]:1234/')).rejects.toThrow(refused);
    await expect(guarded('http://169.254.169.254/latest/meta-data')).rejects.toThrow(refused);
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    const rebinding = createPublicOnlyFetch({
      lookup: (_host, _options, callback) => callback(null, [{ address: '10.0.0.5', family: 4 }]),
    });
    await expect(rebinding('http://rebinding.example/')).rejects.toMatchObject({
      cause: { message: expect.stringContaining('private or reserved address') },
    });
    // Real system resolver: localhost must be refused at connect time.
    await expect(createPublicOnlyFetch()('http://localhost:1234/')).rejects.toMatchObject({
      cause: { message: expect.stringContaining('private or reserved address') },
    });
  });
});

describe('http binding', () => {
  it('keeps the path but always targets the configured base', async () => {
    const calls: Request[] = [];
    const binding = createHttpBinding('https://imported.example', (async (input: Request) => {
      calls.push(input);
      return new Response('{}', { headers: { 'content-encoding': 'gzip', 'x-kept': '1' } });
    }) as unknown as typeof fetch);
    const response = await binding.fetch(
      new Request('https://attacker.example/api/monitors/public/x?a=1'),
    );
    expect(calls[0]!.url).toBe('https://imported.example/api/monitors/public/x?a=1');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('x-kept')).toBe('1');
  });

  it('refuses plain http to non-loopback hosts', () => {
    expect(() => createHttpBinding('http://imported.example')).toThrow();
  });
});

describe('R2 S3 adapter', () => {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');

  async function withBucket<T>(
    handler: Parameters<typeof createServer>[1],
    run: (bucket: ReturnType<typeof createR2S3Bucket>) => Promise<T>,
  ) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      return await run(
        createR2S3Bucket({
          endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          bucket: 'reports',
          accessKeyId: 'AKID',
          secretAccessKey: 'SECRET',
          now: () => new Date('2026-10-05T12:00:00.000Z'),
        }),
      );
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  it('signs requests with SigV4 and reads objects', async () => {
    let expected = '';
    let received = '';
    let url = '';
    const text = await withBucket(
      (req, res) => {
        url = req.url ?? '';
        const auth = req.headers.authorization ?? '';
        const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1] ?? '';
        received = /Signature=([0-9a-f]+)/.exec(auth)?.[1] ?? '';
        // Server-side SigV4 verification, written independently of the adapter.
        const [path, query = ''] = url.split('?');
        const canonical = [
          req.method,
          path,
          query,
          signedHeaders
            .split(';')
            .map((name) => `${name}:${req.headers[name]}\n`)
            .join(''),
          signedHeaders,
          req.headers['x-amz-content-sha256'],
        ].join('\n');
        const key = ['20261005', 'auto', 's3', 'aws4_request'].reduce(
          (secret, part) => createHmac('sha256', secret).update(part).digest(),
          Buffer.from('AWS4SECRET'),
        );
        expected = createHmac('sha256', key)
          .update(
            `AWS4-HMAC-SHA256\n20261005T120000Z\n20261005/auto/s3/aws4_request\n${sha(canonical)}`,
          )
          .digest('hex');
        res.writeHead(200, { etag: '"abc"' });
        res.end('{"generation":"1"}');
      },
      async (bucket) => {
        const object = await bucket.get('tenants/w/public/cohort.json');
        return object!.text();
      },
    );
    expect(text).toBe('{"generation":"1"}');
    expect(url).toBe('/reports/tenants/w/public/cohort.json');
    expect(received).toHaveLength(64);
    expect(received).toBe(expected);
  });

  it('returns null for missing objects and parses listings', async () => {
    await withBucket(
      (req, res) => {
        if (req.url?.startsWith('/reports?')) {
          res.end(
            '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken>' +
              '<Contents><Key>tenants/w/a&amp;b.json</Key><Size>3</Size><ETag>&quot;e1&quot;</ETag>' +
              '<LastModified>2026-10-05T00:00:00.000Z</LastModified></Contents></ListBucketResult>',
          );
        } else {
          res.writeHead(404).end();
        }
      },
      async (bucket) => {
        expect(await bucket.get('missing')).toBeNull();
        const list = await bucket.list({ prefix: 'tenants/w/', limit: 10 });
        expect(list.truncated).toBe(true);
        expect(list.cursor).toBe('tok');
        expect(list.objects[0]).toMatchObject({ key: 'tenants/w/a&b.json', size: 3, etag: 'e1' });
      },
    );
  });

  it('reads weak ETags as bare values', async () => {
    await withBucket(
      (_req, res) => res.writeHead(200, { etag: 'W/"abc123"' }).end('x'),
      async (bucket) => {
        expect((await bucket.get('k'))?.etag).toBe('abc123');
        expect((await bucket.head('k'))?.etag).toBe('abc123');
      },
    );
  });

  it('sends ETag preconditions on put and returns null when they fail', async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    await withBucket(
      (req, res) => {
        seen.push({ match: req.headers['if-match'], none: req.headers['if-none-match'] });
        req.resume();
        res.writeHead(req.headers['if-match'] === '"stale"' ? 412 : 200, { etag: '"e2"' }).end();
      },
      async (bucket) => {
        const created = await bucket.put('pointer', 'x', {
          onlyIf: new Headers({ 'if-none-match': '*' }),
        });
        expect(created).toMatchObject({ etag: 'e2' });
        expect(await bucket.put('pointer', 'x', { onlyIf: { etagMatches: 'e1' } })).toMatchObject({
          etag: 'e2',
        });
        expect(await bucket.put('pointer', 'x', { onlyIf: { etagMatches: 'stale' } })).toBeNull();
        await expect(
          bucket.put('pointer', 'x', { onlyIf: { uploadedBefore: new Date() } }),
        ).rejects.toThrow('unsupported');
      },
    );
    expect(seen).toEqual([
      { match: undefined, none: '*' },
      { match: '"e1"', none: undefined },
      { match: '"stale"', none: undefined },
    ]);
  });

  it('rejects traversal keys and unsupported options', async () => {
    await withBucket(
      (_req, res) => res.end(),
      async (bucket) => {
        await expect(bucket.get('a/../b')).rejects.toThrow('Invalid R2 object key');
        await expect(bucket.get('a', { range: { offset: 1 } })).rejects.toThrow('unsupported');
      },
    );
  });
});
