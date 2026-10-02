import { createHmac, randomUUID } from 'node:crypto';

import type { ProbeBatchRequest, ProbeRequest } from '@uptime/contracts';

export const signatureHeader = 'x-uptime-signature';
export const issuedAtHeader = 'x-uptime-issued-at';
export const requestIdHeader = 'x-uptime-request-id';
export const signatureVersionHeader = 'x-uptime-signature-version';
export const signatureVersion = 'v1';

export interface SignedProbeRequest {
  readonly requestId: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

function signBody(
  bodyForEnvelope: (requestId: string, issuedAt: string) => unknown,
  secret: string,
  now: Date,
): SignedProbeRequest {
  const issuedAt = now.toISOString();
  const requestId = randomUUID();
  const body = JSON.stringify(bodyForEnvelope(requestId, issuedAt));
  const canonical = `${signatureVersion}\n${issuedAt}\n${requestId}\n${body}`;
  const signature = createHmac('sha256', secret).update(canonical).digest('base64url');

  return {
    requestId,
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

/** HMAC covers the exact UTF-8 body bytes and the freshness/identity envelope. */
export function signProbeRequest(
  request: Omit<ProbeRequest, 'requestId' | 'issuedAt'>,
  secret: string,
  now = new Date(),
): SignedProbeRequest {
  return signBody((requestId, issuedAt) => ({ ...request, requestId, issuedAt }), secret, now);
}

export function signProbeBatchRequest(
  request: Omit<ProbeBatchRequest, 'requestId' | 'issuedAt'>,
  secret: string,
  now = new Date(),
): SignedProbeRequest {
  return signBody((requestId, issuedAt) => ({ ...request, requestId, issuedAt }), secret, now);
}
