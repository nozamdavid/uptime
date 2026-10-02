import { dnsDiagnosticResultSchema, type DnsDiagnosticResult } from '@uptime/contracts';

import { decodeStoredJson, type StoredJsonLog } from './stored-json.js';
import type { DnsDiagnosticRow } from './types.js';

/** Parse a stored DNS diagnostic result without letting malformed rows break history. */
export function parseStoredDnsDiagnostic(
  value: unknown,
  diagnosticId: string,
  log: StoredJsonLog,
): DnsDiagnosticResult | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeStoredJson(value);
  const parsed = decoded.ok ? dnsDiagnosticResultSchema.safeParse(decoded.value) : null;
  if (parsed?.success) return parsed.data;
  log.warn(
    { event: 'invalid_legacy_dns_diagnostic', diagnosticId },
    'Ignoring invalid stored DNS diagnostic',
  );
  return null;
}

/** Adapter used by query serialization, which passes the already-decoded result string. */
export function parseDnsDiagnosticRow(row: DnsDiagnosticRow, log: StoredJsonLog) {
  return parseStoredDnsDiagnostic(row.result, row.id, log);
}
