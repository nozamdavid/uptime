import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { createGzip } from 'node:zlib';

import { errorResponse } from './http.js';

export interface NodeAdapterOptions {
  publicOrigin: URL;
  maxBodyBytes: number;
  trustedProxies: ReadonlySet<string>;
  gatewayToken: string | null;
  handler(request: Request, context: ExecutionContext): Promise<Response>;
  log?(event: string, fields?: Record<string, unknown>): void;
}

export interface NodeAdapter {
  listener(req: IncomingMessage, res: ServerResponse): void;
  /** Resolves once in-flight requests and waitUntil work finish, or false on timeout. */
  drain(timeoutMs: number): Promise<boolean>;
}

const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/** Headers a client could forge to pose as another address or origin. */
const forwardingHeaders = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
];

const gatewayHeader = 'x-uptime-gateway-token';

class BodyTooLarge extends Error {}

function stripMappedPrefix(address: string): string {
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

/** Resolve the client address: socket peer, or the forwarded value only from a trusted peer. */
export function resolveClientAddress(
  peer: string | undefined,
  headers: Headers,
  trusted: ReadonlySet<string>,
): string {
  const socket = peer ? stripMappedPrefix(peer) : 'unknown';
  if (!trusted.has(socket)) return socket;
  const direct = headers.get('cf-connecting-ip')?.trim();
  if (direct && isIP(direct) !== 0) return stripMappedPrefix(direct);
  // The rightmost entry is the one our trusted proxy appended itself.
  const forwarded = headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (forwarded && isIP(forwarded) !== 0) return stripMappedPrefix(forwarded);
  return socket;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildUrl(rawUrl: string | undefined, origin: URL): URL | null {
  // Reject absolute-form, authority-form, and protocol-relative targets so the
  // request can only ever resolve against the configured public origin.
  if (!rawUrl || !/^\/(?![/\\])/.test(rawUrl)) return null;
  try {
    const url = new URL(rawUrl, origin);
    return url.origin === origin.origin ? url : null;
  } catch {
    return null;
  }
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]!.toLowerCase();
    if (hopByHop.has(name)) continue;
    try {
      headers.append(name, req.rawHeaders[index + 1]!);
    } catch {
      // Header values Fetch cannot represent are dropped rather than failing the request.
    }
  }
  return headers;
}

function sendJson(res: ServerResponse, response: Response) {
  const body = response.status === 204 ? null : response.body;
  void writeResponse(res, response, body, false);
}

/** Large JSON reports cross a slow tunnel, so compress text bodies the client accepts as gzip. */
function shouldGzip(response: Response, acceptEncoding: string | undefined): boolean {
  if (response.status !== 200 || !acceptEncoding || !/\bgzip\b/i.test(acceptEncoding)) return false;
  if (response.headers.has('content-encoding')) return false;
  return /^(?:application\/(?:json|javascript)|text\/)/i.test(
    response.headers.get('content-type') ?? '',
  );
}

async function writeResponse(
  res: ServerResponse,
  response: Response,
  body: ReadableStream | null,
  head: boolean,
  acceptEncoding?: string,
): Promise<void> {
  const compress = !head && !!body && shouldGzip(response, acceptEncoding);
  const flat: string[] = [];
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie' || hopByHop.has(name)) continue;
    if (compress && name === 'content-length') continue;
    flat.push(name, compress && name === 'etag' && !value.startsWith('W/') ? `W/${value}` : value);
  }
  // One Set-Cookie header per cookie; iterating Headers would fold them together.
  for (const cookie of response.headers.getSetCookie()) flat.push('set-cookie', cookie);
  if (compress) flat.push('content-encoding', 'gzip', 'vary', 'accept-encoding');
  res.writeHead(response.status, flat);
  const bodyless = head || !body || response.status === 204 || response.status === 304;
  if (bodyless) {
    void body?.cancel().catch(() => undefined);
    res.end();
    return;
  }
  const source = Readable.fromWeb(body as never);
  const stream = compress ? source.pipe(createGzip()) : source;
  if (compress) source.once('error', (error) => stream.destroy(error));
  await new Promise<void>((resolve) => {
    // Destroy both sides on failure so a client abort cancels the upstream stream.
    const finish = () => resolve();
    stream.once('error', () => {
      res.destroy();
      finish();
    });
    res.once('close', () => {
      stream.destroy();
      finish();
    });
    res.once('finish', finish);
    stream.pipe(res);
  });
}

export function createNodeAdapter(options: NodeAdapterOptions): NodeAdapter {
  const log = options.log ?? (() => undefined);
  const inflight = new Set<Promise<unknown>>();

  const track = (promise: Promise<unknown>) => {
    const tracked = promise.catch((error: unknown) =>
      log('background_task_failed', { name: error instanceof Error ? error.name : 'unknown' }),
    );
    inflight.add(tracked);
    void tracked.finally(() => inflight.delete(tracked));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = buildUrl(req.url, options.publicOrigin);
    if (!url) return sendJson(res, errorResponse(400, 'bad_request', 'Invalid request target'));

    const headers = toHeaders(req);
    if (
      options.gatewayToken !== null &&
      !(req.method === 'GET' && url.pathname === '/health') &&
      !safeEqual(headers.get(gatewayHeader) ?? '', options.gatewayToken)
    )
      return sendJson(res, errorResponse(403, 'forbidden', 'Gateway authentication is required'));

    const client = resolveClientAddress(req.socket.remoteAddress, headers, options.trustedProxies);
    for (const name of [...forwardingHeaders, gatewayHeader]) headers.delete(name);
    // The handler reads this header first, so it always carries the vetted value.
    headers.set('cf-connecting-ip', client);

    const method = (req.method ?? 'GET').toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const declared = Number(req.headers['content-length'] ?? 0);
    if (hasBody && declared > options.maxBodyBytes) {
      // The unread body would otherwise corrupt the next request on a kept-alive socket.
      res.setHeader('connection', 'close');
      return sendJson(res, errorResponse(413, 'body_too_large', 'Request body is too large'));
    }

    const abort = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let oversized = false;
    let body: ReadableStream | null = null;
    if (hasBody) {
      let received = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > options.maxBodyBytes) {
            oversized = true;
            callback(new BodyTooLarge('Request body is too large'));
          } else callback(null, chunk);
        },
      });
      req.on('error', (error) => limiter.destroy(error));
      body = Readable.toWeb(req.pipe(limiter)) as unknown as ReadableStream;
    }

    const request = new Request(url, {
      method,
      headers,
      signal: abort.signal,
      ...(body ? { body, duplex: 'half' } : {}),
    } as RequestInit);
    const context = {
      waitUntil: track,
      passThroughOnException() {},
    } as unknown as ExecutionContext;

    let response: Response;
    try {
      response = await options.handler(request, context);
    } catch (error) {
      if (abort.signal.aborted) return;
      log('request_failed', { name: error instanceof Error ? error.name : 'unknown' });
      response = oversized
        ? errorResponse(413, 'body_too_large', 'Request body is too large')
        : errorResponse(500, 'internal_error', 'Unexpected server error');
    }
    // A handler that swallowed the stream error still must not act on a truncated body.
    if (oversized) {
      res.setHeader('connection', 'close');
      response = errorResponse(413, 'body_too_large', 'Request body is too large');
    }
    if (abort.signal.aborted || res.destroyed) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    await writeResponse(
      res,
      response,
      response.body,
      method === 'HEAD',
      req.headers['accept-encoding'] as string | undefined,
    );
  }

  return {
    listener(req, res) {
      const work = handle(req, res).catch((error: unknown) => {
        log('adapter_failed', { name: error instanceof Error ? error.name : 'unknown' });
        if (res.headersSent) res.destroy();
        else sendJson(res, errorResponse(500, 'internal_error', 'Unexpected server error'));
      });
      inflight.add(work);
      void work.finally(() => inflight.delete(work));
    },
    async drain(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (inflight.size > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise((resolve) => (timer = setTimeout(resolve, remaining))),
        ]);
        clearTimeout(timer);
      }
      return true;
    },
  };
}
