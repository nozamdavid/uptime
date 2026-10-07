import { describe, expect, it, vi } from 'vitest';
import {
  parsePostgresRuntimeCatalog,
  resolveRuntimeSource,
  withPostgresRuntime,
} from './runtime.js';
import { scopePostgresDatabase, type Database } from './database.js';

const manifest = (sources: unknown[] = []) => JSON.stringify({ controlSchema: 'control', sources });
const hosted = {
  sourceDatabaseId: 'original-source-id',
  schema: 'tenant_a',
  profile: 'full-hosted',
};

describe('trusted Worker PostgreSQL runtime catalog', () => {
  it('derives hosted policy views and deeply freezes trusted scope inventories', () => {
    const catalog = parsePostgresRuntimeCatalog(manifest([hosted]));
    expect(catalog.sources[0]?.tables).toContain('tier_schedulable_monitors');
    expect(catalog.sources[0]?.tables).toContain('tier_active_notification_services');
    expect(catalog.sources[0]?.sourceDatabaseId).toBe('original-source-id');
    expect(catalog.sources[0]?.identityTable).toBe('workspace_metadata');
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.control.tables)).toBe(true);
    expect(Object.isFrozen(catalog.sources)).toBe(true);
    expect(Object.isFrozen(catalog.sources[0])).toBe(true);
    expect(Object.isFrozen(catalog.sources[0]?.tables)).toBe(true);
  });

  it.each(['legacy-staging', 'legacy-production'] as const)(
    'preserves explicit %s marker and exemptions',
    (profile) => {
      const source = parsePostgresRuntimeCatalog(manifest([{ ...hosted, profile }])).sources[0]!;
      expect(source.identityTable).toBe(
        profile === 'legacy-staging'
          ? 'staging_workspace_identity'
          : 'production_workspace_identity',
      );
      expect(source.tables).toContain(source.identityTable);
      expect(source.tables).not.toContain('workspace_metadata');
      expect(source.tables).not.toContain('verified_targets');
      expect(source.tables).not.toContain('tier_schedulable_monitors');
    },
  );

  it.each([
    undefined,
    '',
    '{}',
    '{',
    '[]',
    manifest([{ ...hosted, schema: 'public; DROP TABLE users' }]),
    manifest([{ ...hosted, schema: 'x'.repeat(64) }]),
    manifest([{ ...hosted, schema: 'control' }]),
    manifest([hosted, { ...hosted, schema: 'tenant_b' }]),
    manifest([hosted, { ...hosted, sourceDatabaseId: 'another' }]),
    manifest([{ ...hosted, sourceDatabaseId: '' }]),
    manifest([{ ...hosted, profile: 'legacy' }]),
    manifest([{ ...hosted, identityTable: 'production_workspace_identity' }]),
    manifest([{ ...hosted, workspaceId: 'request-controlled' }]),
  ])('rejects malformed or ambiguous configuration (%#)', (value) => {
    expect(() => parsePostgresRuntimeCatalog(value)).toThrow();
  });

  it('fails closed before invoking event work without a Hyperdrive binding', async () => {
    const work = vi.fn();
    await expect(
      withPostgresRuntime({ POSTGRES_RUNTIME_CATALOG: manifest([hosted]) }, work),
    ).rejects.toThrow('POSTGRES Hyperdrive');
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects a physical source reassigned between source lookup and workspace resolution', async () => {
    const catalog = parsePostgresRuntimeCatalog(
      manifest([hosted, { ...hosted, sourceDatabaseId: 'source-b', schema: 'tenant_b' }]),
    );
    const base = {
      schema: 'control',
      query: async (sql: string) => ({
        rowCount: 1,
        rows: sql.includes('WHERE source_database_id')
          ? [{ workspace_id: 'workspace' }]
          : sql.includes('postgres_tenant_registry')
            ? [
                {
                  workspace_id: 'workspace',
                  source_database_id: 'source-b',
                  schema_name: 'tenant_b',
                  status: 'assigned',
                },
              ]
            : [{ workspace_id: 'workspace', database_id: 'source-b', marker_count: 1 }],
      }),
      transaction: vi.fn(),
      table: vi.fn(),
    } as unknown as Database;
    const control = scopePostgresDatabase(base, catalog.control);
    await expect(resolveRuntimeSource(control, catalog, hosted.sourceDatabaseId)).rejects.toThrow(
      'Physical source assignment changed',
    );
  });
});
