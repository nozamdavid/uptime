export default {
  fetch(request: Request): Response {
    const path = new URL(request.url).pathname;
    if (path === '/healthy') return new Response('healthy\n', { status: 200 });
    if (path === '/unhealthy') return new Response('unhealthy\n', { status: 503 });
    return new Response('not found\n', { status: 404 });
  },
};
