import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    // Polling avoids exhausting the low per-user inotify instance limit on
    // Linux workstations running several Electron and development processes.
    watch: { usePolling: true, interval: 500 },
    proxy: { '/api': process.env.UPTIME_API_PROXY_TARGET ?? 'http://127.0.0.1:8787' },
    // Set UPTIME_ALLOWED_HOSTS="example.com,10.0.0.5" when the dev server is
    // reached through another hostname. Never commit machine-specific hosts.
    allowedHosts: (process.env.UPTIME_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  },
});
