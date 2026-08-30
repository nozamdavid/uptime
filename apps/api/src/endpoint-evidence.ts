import type { EndpointEvidence } from '@uptime/contracts';
import { endpointEvidenceSchema } from '@uptime/contracts';

export interface EndpointEvidenceLog {
  warn: (bindings: Record<string, unknown>, message: string) => void;
}

/**
 * Adapts stored JSON to the contract at the database seam. Historical JSON is
 * untrusted: a bad legacy row is observable in logs but never prevents history
 * pages from loading.
 */
export function parseStoredEndpointEvidence(
  value: unknown,
  observationId: string,
  finalUrl: string | null,
  log: EndpointEvidenceLog,
): EndpointEvidence | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeJsonb(value);
  if (!decoded.ok) {
    log.warn(
      { event: 'invalid_legacy_endpoint_evidence', observationId },
      'Ignoring invalid stored endpoint evidence',
    );
    return null;
  }
  if (decoded.value === null) return null;
  const parsed = endpointEvidenceSchema.safeParse(decoded.value);
  if (parsed.success && hostnameMatchesFinalUrl(parsed.data.finalHostname, finalUrl)) {
    return parsed.data;
  }
  log.warn(
    { event: 'invalid_legacy_endpoint_evidence', observationId },
    'Ignoring invalid stored endpoint evidence',
  );
  return null;
}

function hostnameMatchesFinalUrl(evidenceHostname: string, finalUrl: string | null): boolean {
  if (!finalUrl) return false;
  try {
    return new URL(finalUrl).hostname.toLowerCase() === evidenceHostname;
  } catch {
    return false;
  }
}

function decodeJsonb(value: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof value !== 'string') return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}
