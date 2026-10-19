import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createNodeAdapter,
  resolveClientAddress,
  type NodeAdapterOptions,
} from './node-adapter.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function start(options: Partial<NodeAdapterOptions> & Pick<NodeAdapterOptions, 'handler'>) {
  const adapter = createNodeAdapter({
    publicOrigin: new URL('https://uptime.example'),
    maxBodyBytes: 1024,
    trustedProxies: new Set(),
    gatewayToken: null,
    ...options,
  });
  const server = createServer(adapter.listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { adapter, port: (server.address() as AddressInfo).port };
}

/** Raw request so tests control the request target and chunked bodies. */
function send(
  port: number,
  init: { method?: string; path: string; headers?: Record<string, string>; body?: string[] },
) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const req = httpRequest(
      {
        port,
        host: '127.0.0.1',
        method: init.method ?? 'GET',
        path: init.path,
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    for (const part of init.body ?? []) req.write(part);
    req.end();
  });
}

describe('node adapter compression', () => {
  const payload = JSON.stringify({ rows: 'x'.repeat(5000) });
  const handler = async () =>
    new Response(payload, { headers: { 'content-type': 'application/json' } });

  it('gzips JSON bodies for clients that accept gzip', async () => {
    const { port } = await start({ handler });
    const response = await new Promise<{ encoding: unknown; body: string }>((resolve, reject) => {
      httpRequest(
        { port, host: '127.0.0.1', path: '/x', headers: { 'accept-encoding': 'gzip' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              encoding: res.headers['content-encoding'],
              body: gunzipSync(Buffer.concat(chunks)).toString(),
            }),
          );
        },
      )
        .on('error', reject)
        .end();
    });
    expect(response.encoding).toBe('gzip');
    expect(response.body).toBe(payload);
  });

  it('leaves bodies uncompressed without an accept-encoding header', async () => {
    const { port } = await start({ handler });
    const response = await send(port, { path: '/x' });
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body).toBe(payload);
  });
});

describe('node adapter', () => {
  it('builds the URL from the public origin and ignores Host', async () => {
    let seen = '';
    const { port } = await start({
      handler: async (request) => {
        seen = request.url;
        return new Response('ok');
      },
    });
    await send(port, { path: '/api/plans?x=1', headers: { host: 'evil.example' } });
    expect(seen).toBe('https://uptime.example/api/plans?x=1');
  });

  it('rejects targets that could leave the public origin', async () => {
    const { port } = await start({ handler: async () => new Response('never') });
    for (const path of ['//evil.example/x', '/\\evil.example', 'http://evil.example/x']) {
      expect((await send(port, { path })).status).toBe(400);
    }
  });

  it('ignores forwarded addresses from untrusted peers and honors them from trusted ones', async () => {
    const seen: (string | null)[] = [];
    const handler = async (request: Request) => {
      seen.push(request.headers.get('cf-connecting-ip'));
      seen.push(request.headers.get('x-forwarded-for'));
      return new Response('ok');
    };
    const spoof = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.10' };

    const untrusted = await start({ handler });
    await send(untrusted.port, { path: '/', headers: spoof });
    expect(seen).toEqual(['127.0.0.1', null]);

    seen.length = 0;
    const trusted = await start({ handler, trustedProxies: new Set(['127.0.0.1']) });
    await send(trusted.port, { path: '/', headers: spoof });
    expect(seen).toEqual(['203.0.113.9', null]);
  });

  it('resolves forwarded addresses only when they are valid IPs', () => {
    const trusted = new Set(['10.0.0.1']);
    const headers = (value: Record<string, string>) => new Headers(value);
    expect(
      resolveClientAddress(
        '::ffff:10.0.0.1',
        headers({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }),
        trusted,
      ),
    ).toBe('2.2.2.2');
    expect(
      resolveClientAddress('10.0.0.1', headers({ 'cf-connecting-ip': 'not-an-ip' }), trusted),
    ).toBe('10.0.0.1');
    expect(
      resolveClientAddress('198.51.100.1', headers({ 'cf-connecting-ip': '1.1.1.1' }), trusted),
    ).toBe('198.51.100.1');
  });

  it('keeps every Set-Cookie header separate', async () => {
    const { port } = await start({
      handler: async () => {
        const headers = new Headers();
        headers.append('set-cookie', 'a=1; Path=/; HttpOnly; Secure');
        headers.append('set-cookie', 'b=2; Path=/; HttpOnly; Secure');
        return new Response('ok', { headers });
      },
    });
    const response = await send(port, { path: '/' });
    expect(response.headers['set-cookie']).toEqual([
      'a=1; Path=/; HttpOnly; Secure',
      'b=2; Path=/; HttpOnly; Secure',
    ]);
  });

  it('streams request bodies and rejects oversized ones', async () => {
    const { port } = await start({
      // The hosted handler clones the request to measure the body, then reads it.
      handler: async (request) => {
        await request.clone().arrayBuffer();
        return new Response(`len:${(await request.text()).length}`);
      },
    });
    expect((await send(port, { method: 'POST', path: '/', body: ['x'.repeat(100)] })).body).toBe(
      'len:100',
    );

    const declared = await send(port, {
      method: 'POST',
      path: '/',
      headers: { 'content-length': '5000' },
      body: ['x'],
    }).catch(() => ({ status: 413 }));
    expect(declared.status).toBe(413);

    // Chunked, so there is no declared length to reject early.
    const chunked = await send(port, {
      method: 'POST',
      path: '/',
      headers: { 'transfer-encoding': 'chunked' },
      body: ['x'.repeat(800), 'x'.repeat(800)],
    });
    expect(chunked.status).toBe(413);
  });

  it('requires the gateway token except for health checks and never forwards it', async () => {
    let forwarded: string | null = 'unset';
    const { port } = await start({
      gatewayToken: 't'.repeat(32),
      handler: async (request) => {
        forwarded = request.headers.get('x-uptime-gateway-token');
        return new Response('ok');
      },
    });
    expect((await send(port, { path: '/api/plans' })).status).toBe(403);
    expect(
      (await send(port, { path: '/api/plans', headers: { 'x-uptime-gateway-token': 'wrong' } }))
        .status,
    ).toBe(403);
    expect((await send(port, { path: '/health' })).status).toBe(200);
    expect(
      (
        await send(port, {
          path: '/api/plans',
          headers: { 'x-uptime-gateway-token': 't'.repeat(32) },
        })
      ).status,
    ).toBe(200);
    expect(forwarded).toBeNull();
  });

  it('turns handler failures into a generic 500', async () => {
    const events: string[] = [];
    const { port } = await start({
      log: (event) => events.push(event),
      handler: async () => {
        throw new Error('secret detail');
      },
    });
    const response = await send(port, { path: '/' });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('secret detail');
    expect(events).toContain('request_failed');
  });

  it('aborts the request signal when the client disconnects', async () => {
    let aborted!: () => void;
    const signalled = new Promise<void>((resolve) => (aborted = resolve));
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { port } = await start({
      handler: (request) =>
        new Promise<Response>(() => {
          request.signal.addEventListener('abort', aborted);
          started();
        }),
    });
    const req = httpRequest({ port, host: '127.0.0.1', path: '/' });
    req.on('error', () => undefined);
    req.end();
    await running;
    req.destroy();
    await signalled;
  });

  it('drains waitUntil work before reporting completion', async () => {
    let finished = false;
    const { port, adapter } = await start({
      handler: async (_request, context) => {
        context.waitUntil(
          new Promise<void>((resolve) =>
            setTimeout(() => {
              finished = true;
              resolve();
            }, 50),
          ),
        );
        return new Response('ok');
      },
    });
    await send(port, { path: '/' });
    expect(await adapter.drain(2_000)).toBe(true);
    expect(finished).toBe(true);
  });
});
