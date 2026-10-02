import type { DnsDiagnosticResult } from '@uptime/contracts';
import { dnsDiagnosticResultSchema } from '@uptime/contracts';
import { decodeStoredJson } from './stored-json.js';

export interface DnsDiagnosticLog {
  warn: (bindings: Record<string, unknown>, message: string) => void;
}

/** Parse historical diagnostic JSON without throwing. */
export function parseStoredDnsDiagnostic(
  value: unknown,
  diagnosticId: string,
  log: DnsDiagnosticLog,
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
