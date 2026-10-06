import { createServer, type Server } from 'node:http';

import { hostedFetch } from './hosted-app.js';
import { createNodeAdapter, type NodeAdapter, type NodeAdapterOptions } from './node-adapter.js';
import type { NodeRuntime } from './node-env.js';

export interface NodeServer {
  server: Server;
  adapter: NodeAdapter;
}

/** Wrap the existing hosted fetch handler in a Node HTTP server. Does not listen. */
export function createNodeServer(
  runtime: NodeRuntime,
  overrides: Partial<Pick<NodeAdapterOptions, 'handler' | 'log'>> = {},
): NodeServer {
  const { config, env } = runtime;
  const adapter = createNodeAdapter({
    publicOrigin: config.publicOrigin,
    maxBodyBytes: config.maxBodyBytes,
    trustedProxies: config.trustedProxies,
    gatewayToken: config.gatewayToken,
    handler: (request, context) => hostedFetch(request, env, context),
    ...overrides,
  });
  const server = createServer(
    // Slow clients are cut off here; the handler has its own database timeouts.
    { requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 65_000 },
    adapter.listener,
  );
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return { server, adapter };
}
