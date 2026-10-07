import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

import { isForbiddenIp } from './security.js';

type Lookup = (
  hostname: string,
  options: unknown,
  callback: (error: Error | null, address?: unknown, family?: number) => void,
) => void;

/**
 * Workers run with `global_fetch_strictly_public`; Node on a shared VPS does
 * not, so user-supplied notification and OAuth URLs could reach loopback
 * PostgreSQL or the metadata service. Check every resolved address at connect
 * time, which also covers redirects and DNS rebinding.
 */
export function createPublicOnlyFetch(options: { lookup?: Lookup } = {}): typeof fetch {
  const lookup = options.lookup ?? (dnsLookup as unknown as Lookup);
  const connector = buildConnector({
    lookup: ((hostname: string, lookupOptions: object, callback: Function) => {
      lookup(hostname, { ...lookupOptions, all: true }, (error, addresses, family) => {
        if (error) return callback(error);
        const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family }]) as {
          address: string;
          family: number;
        }[];
        if (list.length === 0 || list.some((entry) => isForbiddenIp(entry.address)))
          return callback(new Error('Destination resolves to a private or reserved address'));
        // `all: true` was ours; honor the caller's expectation of a single result.
        return (lookupOptions as { all?: boolean }).all
          ? callback(null, list)
          : callback(null, list[0]!.address, list[0]!.family);
      });
    }) as never,
  });
  const dispatcher = new Agent({
    // Node skips `lookup` for IP literals, so a redirect to http://127.0.0.1/ would
    // otherwise connect; check literals here for every hop.
    connect: (connectOptions, callback) => {
      const host = connectOptions.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) !== 0 && isForbiddenIp(host))
        return callback(new Error('Destination is a private or reserved address'), null);
      return connector(connectOptions, callback);
    },
  });
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const target = request ? request.url : String(input);
    const host = new URL(target).hostname;
    // Literal addresses skip DNS, so the connect-time lookup never sees them.
    if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 && isForbiddenIp(host))
      return Promise.reject(new TypeError('Destination is a private or reserved address'));
    return undiciFetch(target, {
      ...(request
        ? {
            method: request.method,
            headers: request.headers,
            body: request.body,
            duplex: 'half',
            signal: request.signal,
            redirect: request.redirect,
          }
        : {}),
      ...(init as object),
      dispatcher,
    } as never) as unknown as Promise<Response>;
  }) as typeof fetch;
}

/**
 * Narrow replacement for a Worker service binding: requests keep their path and
 * query but always go to the configured base URL, never a caller-chosen host.
 */
export function createHttpBinding(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): { fetch(request: Request): Promise<Response> } {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname))
    throw new Error('Binding URLs must use https unless they target loopback');
  return {
    async fetch(request) {
      const source = new URL(request.url);
      const target = new URL(`${source.pathname}${source.search}`, base);
      const hasBody = !['GET', 'HEAD'].includes(request.method);
      const headers = new Headers(request.headers);
      headers.delete('host');
      const response = await fetchImpl(
        new Request(target, {
          method: request.method,
          headers,
          redirect: 'manual',
          signal: request.signal,
          ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
        } as RequestInit),
      );
      // fetch has already decoded the body; the original encoding headers no longer apply.
      const out = new Headers(response.headers);
      out.delete('content-encoding');
      out.delete('content-length');
      return new Response(response.body, { status: response.status, headers: out });
    },
  };
}
