import {
  notificationMessageText,
  postNotificationRequest,
  type NotificationReceipt,
} from './notification-providers.js';

export interface BlueskyMessage {
  kind: 'outage' | 'recovery' | 'reminder' | 'test';
  monitorName: string;
  monitorUrl: string;
  occurredAt: string;
  outageStartedAt: string | null;
}

export interface BlueskyConfig {
  handle: string;
  appPassword: string;
}

interface Session {
  did: string;
  accessJwt: string;
  service: string;
}

interface CachedSession extends Session {
  appPassword: string;
  expiresAt: number;
}

export type BlueskyDeliveryPhase =
  'handle_lookup' | 'did_lookup' | 'pds_validation' | 'login' | 'session_validation' | 'post';

const sessions = new Map<string, CachedSession>();
const pendingSessions = new Map<
  string,
  { did: string; service: string; appPassword: string; promise: Promise<Session> }
>();
const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function fitText(text: string, maxGraphemes: number, maxBytes: number): string {
  let result = '';
  let count = 0;
  let bytes = 0;
  for (const { segment } of segmenter.segment(text)) {
    const segmentBytes = encoder.encode(segment).length;
    if (count + 1 > maxGraphemes || bytes + segmentBytes > maxBytes) {
      const ellipsis = '…';
      while (result && (count + 1 > maxGraphemes || bytes + 3 > maxBytes)) {
        const segments = [...segmenter.segment(result)];
        const last = segments[segments.length - 1]!.segment;
        result = result.slice(0, -last.length);
        count--;
        bytes -= encoder.encode(last).length;
      }
      return result + ellipsis;
    }
    result += segment;
    count++;
    bytes += segmentBytes;
  }
  return result;
}

/** Fit the post lexicon's grapheme and UTF-8 limits while keeping alert context. */
export function blueskyPostText(message: BlueskyMessage): string {
  const full =
    message.kind === 'test'
      ? notificationMessageText(message)
      : [
          { outage: 'OUTAGE', recovery: 'RECOVERED', reminder: 'STILL DOWN' }[message.kind],
          message.monitorName,
          message.monitorUrl,
          `Time: ${message.occurredAt}`,
          ...(message.outageStartedAt ? [`Outage started: ${message.outageStartedAt}`] : []),
        ].join('\n');
  if (fitText(full, 300, 3000) === full) return full;

  if (message.kind === 'test') return fitText(full, 300, 3000);

  const title = { outage: 'OUTAGE', recovery: 'RECOVERED', reminder: 'STILL DOWN' }[message.kind];
  const lines = [title, fitText(message.monitorName, 100, 1000), `Time: ${message.occurredAt}`];
  if (message.outageStartedAt) lines.push(`Outage started: ${message.outageStartedAt}`);
  const context = fitText(lines.join('\n'), 220, 2200);
  const remainingGraphemes = 300 - [...segmenter.segment(context)].length - 1;
  const remainingBytes = 3000 - encoder.encode(context).length - 1;
  const url = fitText(message.monitorUrl, remainingGraphemes, remainingBytes);
  return url ? `${context}\n${url}` : context;
}

function isSession(value: unknown): value is Pick<Session, 'did' | 'accessJwt'> {
  if (typeof value !== 'object' || value === null) return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.did === 'string' &&
    session.did.startsWith('did:') &&
    typeof session.accessJwt === 'string' &&
    session.accessJwt.length > 0
  );
}

function publicHostname(hostname: string): boolean {
  const labels = hostname.toLowerCase().split('.');
  const last = labels[labels.length - 1];
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
    !!last &&
    /^[a-z]{2,}$/.test(last) &&
    !['local', 'localhost', 'internal', 'arpa', 'test', 'invalid'].includes(last)
  );
}

function publicServiceOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !publicHostname(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function didDocumentUrl(did: string): string | null {
  if (/^did:plc:[a-z2-7]+$/.test(did)) return `https://plc.directory/${did}`;
  if (did.startsWith('did:web:')) {
    const hostname = did.slice('did:web:'.length);
    if (publicHostname(hostname)) return `https://${hostname}/.well-known/did.json`;
  }
  return null;
}

function pdsFromDocument(value: unknown, did: string, handle: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const document = value as Record<string, unknown>;
  if (document.id !== did || !Array.isArray(document.alsoKnownAs)) return null;
  const claimedHandle = document.alsoKnownAs.find(
    (alias): alias is string => typeof alias === 'string' && /^at:\/\/[a-z0-9.-]+$/i.test(alias),
  );
  if (claimedHandle?.toLowerCase() !== `at://${handle.toLowerCase()}`) return null;
  if (!Array.isArray(document.service)) return null;
  const pds = document.service.find((item: unknown) => {
    if (typeof item !== 'object' || item === null) return false;
    const entry = item as Record<string, unknown>;
    return (
      (entry.id === '#atproto_pds' || entry.id === `${did}#atproto_pds`) &&
      entry.type === 'AtprotoPersonalDataServer'
    );
  }) as Record<string, unknown> | undefined;
  return publicServiceOrigin(pds?.serviceEndpoint);
}

function remember(handle: string, appPassword: string, session: Session): void {
  sessions.delete(handle);
  sessions.set(handle, {
    did: session.did,
    accessJwt: session.accessJwt,
    service: session.service,
    appPassword,
    expiresAt: accessTokenExpiry(session.accessJwt),
  });
  if (sessions.size > 32) sessions.delete(sessions.keys().next().value!);
}

function accessTokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(
      atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as {
      exp?: unknown;
    };
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
      return Math.max(Date.now(), payload.exp * 1000 - 60_000);
    }
  } catch {
    // Keep opaque or malformed test tokens briefly; the post retry handles expiry.
  }
  return Date.now() + 120_000;
}

export async function sendBlueskyNotification(
  fetchImpl: typeof fetch,
  config: BlueskyConfig,
  message: BlueskyMessage,
  onFailure: (response: Response, phase: BlueskyDeliveryPhase) => never,
  onFetchError: (error: unknown, phase: BlueskyDeliveryPhase) => never,
  onMalformedSession: (phase: BlueskyDeliveryPhase) => never,
): Promise<NotificationReceipt> {
  const getJson = async (url: string, phase: BlueskyDeliveryPhase): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      return onFetchError(error, phase);
    }
    if (!response.ok) return onFailure(response, phase);
    return response.json().catch(() => onMalformedSession(phase));
  };

  const discover = async (): Promise<{ did: string; service: string }> => {
    const resolved = await getJson(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(config.handle)}`,
      'handle_lookup',
    );
    const did =
      typeof resolved === 'object' && resolved !== null
        ? (resolved as Record<string, unknown>).did
        : null;
    if (typeof did !== 'string') return onMalformedSession('handle_lookup');
    const url = didDocumentUrl(did);
    if (!url) return onMalformedSession('did_lookup');
    const document = await getJson(url, 'did_lookup');
    const service = pdsFromDocument(document, did, config.handle);
    if (!service) return onMalformedSession('pds_validation');
    return { did, service };
  };

  const createSession = async (identity: { did: string; service: string }): Promise<Session> => {
    const response = await postNotificationRequest(
      fetchImpl,
      {
        url: `${identity.service}/xrpc/com.atproto.server.createSession`,
        body: { identifier: config.handle, password: config.appPassword },
      },
      (error) => onFetchError(error, 'login'),
    );
    if (!response.ok) return onFailure(response, 'login');
    const payload: unknown = await response.json().catch(() => null);
    if (!isSession(payload) || payload.did !== identity.did)
      return onMalformedSession('session_validation');
    const session = { did: payload.did, accessJwt: payload.accessJwt, service: identity.service };
    remember(config.handle, config.appPassword, session);
    return session;
  };

  const login = (identity: { did: string; service: string }): Promise<Session> => {
    const pending = pendingSessions.get(config.handle);
    if (
      pending?.appPassword === config.appPassword &&
      pending.did === identity.did &&
      pending.service === identity.service
    )
      return pending.promise;
    const promise = createSession(identity).finally(() => {
      if (pendingSessions.get(config.handle)?.promise === promise) {
        pendingSessions.delete(config.handle);
      }
    });
    pendingSessions.set(config.handle, { ...identity, appPassword: config.appPassword, promise });
    return promise;
  };

  const identity = await discover();
  const cached = sessions.get(config.handle);
  let session =
    cached &&
    cached.appPassword === config.appPassword &&
    cached.did === identity.did &&
    cached.service === identity.service &&
    cached.expiresAt > Date.now()
      ? cached
      : await login(identity);

  const text = blueskyPostText(message);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await postNotificationRequest(
      fetchImpl,
      {
        url: `${session.service}/xrpc/com.atproto.repo.createRecord`,
        headers: { Authorization: `Bearer ${session.accessJwt}` },
        body: {
          repo: session.did,
          collection: 'app.bsky.feed.post',
          record: {
            $type: 'app.bsky.feed.post',
            text,
            createdAt: new Date().toISOString(),
          },
        },
      },
      (error) => onFetchError(error, 'post'),
    );
    if (response.ok) {
      let payload: unknown = null;
      try {
        payload = await response.clone().json();
      } catch {
        // Successful posting does not depend on optional receipt metadata.
      }
      let externalUrl: string | null = null;
      if (typeof payload === 'object' && payload !== null) {
        const uri = (payload as Record<string, unknown>).uri;
        if (typeof uri === 'string') {
          const match =
            /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/([A-Za-z0-9.-]+)\/([A-Za-z0-9._~:-]+)$/.exec(
              uri,
            );
          if (match && match[1] === session.did && match[2] === 'app.bsky.feed.post') {
            const rkey = match[3];
            const repo = match[1];
            if (rkey && repo && rkey !== '.' && rkey !== '..') {
              // Bluesky's profile route expects the canonical DID spelling
              // (including its colons), rather than a percent-encoded path segment.
              externalUrl = `https://bsky.app/profile/${repo}/post/${rkey}`;
            }
          }
        }
      }
      return { text, externalUrl };
    }
    if ((response.status === 401 || response.status === 403) && attempt === 0) {
      sessions.delete(config.handle);
      session = await login(await discover());
      continue;
    }
    return onFailure(response, 'post');
  }
  throw new Error('Bluesky post retry limit reached');
}
