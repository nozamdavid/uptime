import { hmacSha256Base64Url, randomId } from '@uptime/cloudflare';

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

/**
 * Sign a probe request envelope with the pre-existing canonical form:
 * `v1\n<issuedAt>\n<requestId>\n<body>` HMAC-SHA256, base64url.
 *
 * The canonical envelope and shared HMAC helper produce signatures accepted
 * by the regional probe Worker.
 */
export async function signProbeRequestBody(
  bodyForEnvelope: (requestId: string, issuedAt: string) => unknown,
  secret: string,
  now: Date,
): Promise<SignedProbeRequest> {
  const issuedAt = now.toISOString();
  const requestId = randomId();
  const body = JSON.stringify(bodyForEnvelope(requestId, issuedAt));
  const canonical = `${signatureVersion}\n${issuedAt}\n${requestId}\n${body}`;
  const signature = await hmacSha256Base64Url(secret, canonical);
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
