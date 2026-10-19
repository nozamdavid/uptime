import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Build stamp shown in the corner of the UI: UTC date.time plus the short commit. */
function buildVersion() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '.');
  try {
    const commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return `${stamp}-${commit}`;
  } catch {
    return stamp;
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
  plugins: [react()],
  server: {
    port: 5176,
    // Polling avoids exhausting the low per-user inotify instance limit on
    // Linux workstations running several Electron and development processes.
    watch: { usePolling: true, interval: 500 },
    proxy: {
      '/api': process.env.UPTIME_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
      '/oauth': process.env.UPTIME_API_PROXY_TARGET ?? 'http://127.0.0.1:8787',
      '/reports': process.env.UPTIME_REPORTS_PROXY_TARGET ?? 'http://127.0.0.1:8787',
    },
    // Set UPTIME_ALLOWED_HOSTS="example.com,10.0.0.5" when the dev server is
    // reached through another hostname. Never commit machine-specific hosts.
    allowedHosts: (process.env.UPTIME_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  },
});
