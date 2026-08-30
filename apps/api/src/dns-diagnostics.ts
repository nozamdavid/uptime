import type { DnsDiagnosticResult } from '@uptime/contracts';
import { dnsDiagnosticResultSchema } from '@uptime/contracts';

export interface DnsDiagnosticLog {
  warn: (bindings: Record<string, unknown>, message: string) => void;
}

/** Keeps malformed historical JSON isolated at the database seam. */
export function parseStoredDnsDiagnostic(
  value: unknown,
  diagnosticId: string,
  log: DnsDiagnosticLog,
): DnsDiagnosticResult | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeJsonb(value);
  const parsed = decoded === undefined ? null : dnsDiagnosticResultSchema.safeParse(decoded);
  if (parsed?.success) return parsed.data;
  log.warn(
    { event: 'invalid_legacy_dns_diagnostic', diagnosticId },
    'Ignoring invalid stored DNS diagnostic',
  );
  return null;
}

function decodeJsonb(value: unknown): unknown | undefined {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
