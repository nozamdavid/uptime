export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === '/api' ||
      url.pathname.startsWith('/api/') ||
      url.pathname === '/oauth' ||
      url.pathname.startsWith('/oauth/')
    ) {
      return env.API.fetch(request);
    }
    if (url.pathname.startsWith('/reports/')) return env.API.fetch(request);
    return env.ASSETS.fetch(request);
  },
};
