import { reconcileScheduled } from './reconcile.js';
import { createPublicOnlyFetch } from './node-bindings.js';
import { loadNodeRuntime, type NodeRuntime } from './node-env.js';
import { createNodeServer } from './node-server.js';

/** Single-line JSON events. Fields must never carry secrets or request data. */
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

let runtime: NodeRuntime;
try {
  runtime = loadNodeRuntime(process.env);
} catch (error) {
  // Messages name the offending variable and never include its value.
  log('invalid_configuration', { message: error instanceof Error ? error.message : 'unknown' });
  process.exit(1);
}

// Replaces the Workers `global_fetch_strictly_public` guarantee for all outbound fetches.
globalThis.fetch = createPublicOnlyFetch();

const { config, env } = runtime;
const { server, adapter } = createNodeServer(runtime, {
  log: (event, fields) => log(event, fields ?? {}),
});

let reconciling: Promise<void> | null = null;
const reconcile = () => {
  // A slow pass must not stack with the next tick.
  reconciling ??= reconcileScheduled(env).finally(() => {
    reconciling = null;
  });
};
const timer = setInterval(reconcile, config.reconcileIntervalMs);
timer.unref();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log('shutdown_started', { signal });
  clearInterval(timer);
  server.close();
  server.closeIdleConnections();
  const drained = await adapter.drain(config.shutdownGraceMs);
  await Promise.race([reconciling, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  server.closeAllConnections();
  log('shutdown_complete', { drained });
  process.exit(drained ? 0 : 1);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) =>
  log('unhandled_rejection', { name: reason instanceof Error ? reason.name : 'unknown' }),
);

server.on('error', (error) => {
  log('server_error', { name: error.name });
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  log('listening', {
    host: config.host,
    port: config.port,
    publicOrigin: config.publicOrigin.origin,
  });
  reconcile();
});
