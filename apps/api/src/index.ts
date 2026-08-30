import { startApi } from './server.js';

const app = await startApi();
let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): void {
  if (shutdownPromise) return;

  app.log.info({ event: 'api_shutdown', signal });
  shutdownPromise = app.close().catch((error: unknown) => {
    app.log.error({ event: 'api_shutdown_failed', signal, error });
    process.exitCode = 1;
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
