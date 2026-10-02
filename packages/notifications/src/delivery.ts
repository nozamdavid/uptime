export class NotificationDeliveryError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly retryAfterSeconds = 60,
  ) {
    super(
      retryable
        ? 'Notification delivery temporarily failed'
        : 'Notification service rejected the message; check its settings',
    );
    this.name = 'NotificationDeliveryError';
  }
}

export async function post(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Fetch errors can contain the request URL, including provider credentials.
    throw new NotificationDeliveryError(true);
  }
}

export function responseError(response: Response, retryAfter?: number): NotificationDeliveryError {
  const seconds = retryAfter ?? Number(response.headers.get('retry-after'));
  return new NotificationDeliveryError(
    response.status === 429 || response.status >= 500,
    Number.isFinite(seconds) && seconds > 0 ? Math.min(86_400, Math.ceil(seconds)) : 60,
  );
}
