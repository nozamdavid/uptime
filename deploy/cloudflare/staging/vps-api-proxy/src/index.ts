/**
 * Cloudflare Worker VPC Proxy for Staging Node API.
 *
 * Forwards requests across Cloudflare Tunnel via Workers VPC HTTP Service
 * binding `STAGING_NODE_API` to Node.js 24 API running on VPS 217.217.227.164:3001.
 */

export interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
  noRetry(): void;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface Env {
  STAGING_NODE_API?: Fetcher;
  API_GATEWAY_TOKEN?: string;
  PUBLIC_ORIGIN?: string;
  ENVIRONMENT?: string;
}

const HOP_BY_HOP_HEADERS = new Set([
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

const GATEWAY_HEADERS = ['x-uptime-gateway-token', 'x-gateway-token'];

export default {
  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    if (!env.STAGING_NODE_API) {
      return new Response(
        JSON.stringify({
          error: 'configuration_error',
          message: 'VPC service binding STAGING_NODE_API is not configured',
        }),
        {
          status: 500,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      );
    }

    const incomingUrl = new URL(request.url);
    // Forward to loopback 127.0.0.1:3001 while strictly preserving pathname and query parameters
    const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, 'http://127.0.0.1:3001');

    // Build forward headers
    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers) {
      const lower = key.toLowerCase();
      // Drop hop-by-hop headers
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      // Strip client-supplied gateway tokens to prevent header spoofing
      if (GATEWAY_HEADERS.includes(lower)) continue;
      forwardHeaders.append(key, value);
    }

    // Preserve trusted client IP header from Cloudflare Edge
    const clientIp = request.headers.get('cf-connecting-ip');
    if (clientIp) {
      forwardHeaders.set('cf-connecting-ip', clientIp);
    }

    // Set origin and protocol forwarding headers
    forwardHeaders.set('x-forwarded-host', incomingUrl.host);
    forwardHeaders.set('x-forwarded-proto', incomingUrl.protocol.replace(':', ''));

    // Authenticate with Node adapter via gateway token
    if (env.API_GATEWAY_TOKEN) {
      forwardHeaders.set('x-uptime-gateway-token', env.API_GATEWAY_TOKEN);
      forwardHeaders.set('x-gateway-token', env.API_GATEWAY_TOKEN);
    }

    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';

    let upstreamResponse: Response;
    try {
      const fetchInit: RequestInit & { duplex?: 'half' } = {
        method,
        headers: forwardHeaders,
        redirect: 'manual',
      };
      if (hasBody && request.body) {
        fetchInit.body = request.body;
        fetchInit.duplex = 'half';
      }

      upstreamResponse = await env.STAGING_NODE_API.fetch(targetUrl.toString(), fetchInit);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'vpc_upstream_fetch_failed',
          path: incomingUrl.pathname,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return new Response(
        JSON.stringify({
          error: 'bad_gateway',
          message: 'Upstream API service temporarily unavailable',
        }),
        {
          status: 502,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      );
    }

    // Sanitize response headers
    const responseHeaders = new Headers();
    for (const [key, value] of upstreamResponse.headers) {
      const lower = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lower)) continue;
      if (GATEWAY_HEADERS.includes(lower)) continue;
      if (lower === 'set-cookie') continue;
      responseHeaders.append(key, value);
    }

    // Preserve all Set-Cookie headers individually
    if (typeof upstreamResponse.headers.getSetCookie === 'function') {
      const cookies = upstreamResponse.headers.getSetCookie();
      for (const cookie of cookies) {
        responseHeaders.append('set-cookie', cookie);
      }
    } else {
      const setCookie = upstreamResponse.headers.get('set-cookie');
      if (setCookie) {
        responseHeaders.set('set-cookie', setCookie);
      }
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },

  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx?: ExecutionContext,
  ): Promise<void> {
    // Scheduled background reconciliation (billing, custom domains, monitor checks)
    // is executed directly inside the Node.js server on the VPS via `reconcileScheduled(env)`
    // running on interval in `node-main.ts`.
    // Retaining this scheduled handler ensures cron triggers complete safely without error
    // when this proxy is deployed under the `uptime-staging-oauth-api` Worker identity.
  },
};
