import type { EndpointEvidence } from '@uptime/contracts';
import { endpointEvidenceSchema } from '@uptime/contracts';
import { decodeStoredJson } from './stored-json.js';

export interface EndpointEvidenceLog {
  warn: (bindings: Record<string, unknown>, message: string) => void;
}

/** Parse historical JSON without allowing malformed rows to break history pages. */
export function parseStoredEndpointEvidence(
  value: unknown,
  observationId: string,
  finalUrl: string | null,
  log: EndpointEvidenceLog,
): EndpointEvidence | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeStoredJson(value);
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
