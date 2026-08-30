import type {
  CdnProvider,
  CdnEvidenceHeader,
  EndpointContinent,
  EndpointEvidence,
  EndpointSignal,
  EndpointSignalName,
  ParsedCdnEvidence,
} from '@uptime/contracts';

const parserVersion = '1';
const signalNames = [
  'cf-ray',
  'cf-cache-status',
  'x-amz-cf-pop',
  'x-cache',
  'x-served-by',
  'x-cache-hits',
  'x-vercel-id',
  'server',
  'via',
] as const satisfies readonly EndpointSignalName[];

const continentByEdgePrefix: Readonly<Record<string, EndpointContinent>> = {
  ACC: 'africa',
  AMS: 'europe',
  ARN: 'europe',
  BOM: 'asia',
  CDG: 'europe',
  CPT: 'africa',
  DFW: 'north_america',
  DUB: 'europe',
  EWR: 'north_america',
  FRA: 'europe',
  GRU: 'south_america',
  HKG: 'asia',
  HND: 'asia',
  IAD: 'north_america',
  ICN: 'asia',
  JNB: 'africa',
  LAX: 'north_america',
  LCY: 'europe',
  LHR: 'europe',
  MAD: 'europe',
  MEL: 'oceania',
  MIA: 'north_america',
  NRT: 'asia',
  ORD: 'north_america',
  SCL: 'south_america',
  SFO: 'north_america',
  SIN: 'asia',
  SJC: 'north_america',
  SYD: 'oceania',
  WAW: 'europe',
  YYZ: 'north_america',
};

function sanitize(value: string): string | null {
  // Header values are platform-bounded, but cap our own input work as well as
  // the stored output. Every emitted character is one ASCII/UTF-8 byte.
  let output = '';
  let pendingSpace = false;
  const inputLimit = Math.min(value.length, 2_048);
  for (let index = 0; index < inputLimit && output.length < 512; index += 1) {
    const code = value.charCodeAt(index);
    const isPrintableNonSpace = code >= 0x21 && code <= 0x7e;
    if (!isPrintableNonSpace) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace && output.length < 512) output += ' ';
    pendingSpace = false;
    if (output.length < 512) output += value[index];
  }
  return output || null;
}

function continentFor(edge: string): EndpointContinent | null {
  return continentByEdgePrefix[edge.slice(0, 3).toUpperCase()] ?? null;
}

function parsed(
  provider: CdnProvider,
  reportedEdge: string,
  evidenceHeader: CdnEvidenceHeader,
): ParsedCdnEvidence {
  return {
    provider,
    reportedEdge,
    inferredContinent: continentFor(reportedEdge),
    confidence: 'provider_reported',
    evidenceHeader,
    parserVersion,
  };
}

function parseProvider(signals: readonly EndpointSignal[]): ParsedCdnEvidence | null {
  const byName = new Map(signals.map((signal) => [signal.name, signal.value]));
  const candidates: ParsedCdnEvidence[] = [];

  const ray = byName.get('cf-ray')?.match(/^[a-f0-9]{8,32}-([a-z]{3})$/i);
  if (ray?.[1]) candidates.push(parsed('cloudflare', ray[1].toUpperCase(), 'cf-ray'));

  const cloudFrontPop = byName.get('x-amz-cf-pop')?.match(/^([A-Z]{3}\d{1,2})(?:-[A-Z0-9]+)?$/);
  if (cloudFrontPop?.[1]) candidates.push(parsed('cloudfront', cloudFrontPop[1], 'x-amz-cf-pop'));

  const servedBy = byName.get('x-served-by');
  if (servedBy && !servedBy.includes(',')) {
    const fastlyEdge = servedBy.match(/-([A-Z]{3})$/)?.[1];
    if (fastlyEdge) candidates.push(parsed('fastly', fastlyEdge, 'x-served-by'));
  }

  const vercelEdge = byName.get('x-vercel-id')?.match(/^([a-z]{3}\d)::/i)?.[1];
  if (vercelEdge) candidates.push(parsed('vercel', vercelEdge.toLowerCase(), 'x-vercel-id'));

  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * Collects bounded response-reported endpoint evidence without I/O.
 * It never throws; null means even the final hostname could not be represented.
 */
export function collectEndpointEvidence(
  finalUrl: string,
  headers: Headers,
): EndpointEvidence | null {
  let finalHostname: string;
  try {
    finalHostname = new URL(finalUrl).hostname.toLowerCase().slice(0, 253);
    if (!finalHostname) return null;
  } catch {
    return null;
  }

  const signals: EndpointSignal[] = [];
  try {
    for (const name of signalNames) {
      const value = headers.get(name);
      if (value === null) continue;
      const sanitized = sanitize(value);
      if (sanitized) signals.push({ name, value: sanitized });
    }
  } catch {
    return { finalHostname, signals: [], primaryCdn: null };
  }

  try {
    return { finalHostname, signals, primaryCdn: parseProvider(signals) };
  } catch {
    return { finalHostname, signals, primaryCdn: null };
  }
}
