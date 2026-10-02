/**
 * A tiny fetch-style router for the Workers API.
 *
 * Patterns support `:name` parameters and a trailing `*` wildcard. Route
 * matching is exact on method + path length so no server framework is needed.
 */

export interface RouteContext<Env> {
  request: Request;
  env: Env;
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler<Env> = (context: RouteContext<Env>) => Promise<Response> | Response;
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

interface Route<Env> {
  method: Method;
  segments: string[];
  handler: RouteHandler<Env>;
}

export class Router<Env> {
  private readonly routes: Route<Env>[] = [];

  add(method: Method, path: string, handler: RouteHandler<Env>): void {
    this.routes.push({ method, segments: splitPath(path), handler });
  }

  match(
    method: Method,
    pathname: string,
  ): { handler: RouteHandler<Env>; params: Record<string, string> } | null {
    const segments = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (params) return { handler: route.handler, params };
    }
    return null;
  }

  /** True when a different method has a matching path, for accurate 405s. */
  hasPath(pathname: string): boolean {
    const segments = splitPath(pathname);
    return this.routes.some((route) => matchSegments(route.segments, segments) !== null);
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function matchSegments(
  pattern: readonly string[],
  actual: readonly string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    if (expected === '*') {
      params['*'] = actual.slice(index).join('/');
      return params;
    }
    const value = actual[index];
    if (value === undefined) return null;
    if (expected.startsWith(':')) {
      // Malformed percent-encoding must be a non-match, not a 500.
      try {
        params[expected.slice(1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (expected !== value) {
      return null;
    }
  }
  return pattern.length === actual.length ? params : null;
}
