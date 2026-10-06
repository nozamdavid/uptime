interface Env {
  OAUTH: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.OAUTH.fetch(request);
  },
};
