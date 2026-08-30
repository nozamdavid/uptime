import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  decodeDnsDiagnosticCursor,
  encodeCursor,
  encodeDnsDiagnosticCursor,
  dnsDiagnosticListQuerySchema,
  observationListQuerySchema,
} from './server.js';

const cursor = {
  startedAt: '2026-08-30T00:00:00.000Z',
  id: '73d8a1ef-f98c-42fb-9482-e4c4e15f6ed1',
};

describe('observation list query contract', () => {
  it('preserves region filtering, page size, and a cursor across pages', () => {
    const encoded = encodeCursor(cursor);
    expect(
      observationListQuerySchema.parse({
        range: '7d',
        regionId: 'eu-west',
        limit: '25',
        cursor: encoded,
      }),
    ).toEqual({ range: '7d', regionId: 'eu-west', limit: 25, cursor: encoded });
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it('rejects a malformed pagination cursor before querying observations', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow('Cursor is invalid');
  });
});

describe('DNS diagnostic history query contract', () => {
  it('limits history to 7d/30d and uses a newest-first keyset cursor', () => {
    const diagnosticCursor = { requestedAt: cursor.startedAt, id: cursor.id };
    const encoded = encodeDnsDiagnosticCursor(diagnosticCursor);
    expect(
      dnsDiagnosticListQuerySchema.parse({ range: '30d', regionId: 'asia', cursor: encoded }),
    ).toEqual({
      range: '30d',
      regionId: 'asia',
      cursor: encoded,
      limit: 50,
    });
    expect(decodeDnsDiagnosticCursor(encoded)).toEqual(diagnosticCursor);
  });
});
