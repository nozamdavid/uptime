import { createHmac, randomUUID } from 'node:crypto';

import type { ProbeRequest } from '@uptime/contracts';

export const signatureHeader = 'x-uptime-signature';
export const issuedAtHeader = 'x-uptime-issued-at';
export const requestIdHeader = 'x-uptime-request-id';
export const signatureVersionHeader = 'x-uptime-signature-version';
export const signatureVersion = 'v1';

export interface SignedProbeRequest {
  readonly body: string;
  readonly headers: Record<string, string>;
}

/** HMAC covers the exact UTF-8 body bytes and the freshness/identity envelope. */
export function signProbeRequest(
  request: Omit<ProbeRequest, 'requestId' | 'issuedAt'>,
  secret: string,
  now = new Date(),
): SignedProbeRequest {
  const issuedAt = now.toISOString();
  const requestId = randomUUID();
  const body = JSON.stringify({ ...request, requestId, issuedAt });
  const canonical = `${signatureVersion}\n${issuedAt}\n${requestId}\n${body}`;
  const signature = createHmac('sha256', secret).update(canonical).digest('base64url');

  return {
    body,
    headers: {
      'content-type': 'application/json',
      [signatureHeader]: signature,
      [issuedAtHeader]: issuedAt,
      [requestIdHeader]: requestId,
      [signatureVersionHeader]: signatureVersion,
    },
  };
}
