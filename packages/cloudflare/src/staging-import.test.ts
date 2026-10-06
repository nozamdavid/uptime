import { describe, expect, it } from 'vitest';
import type { Database } from './postgres/database.js';
import {
  getImportedDatabaseProfile,
  isImportedSlot,
  isImportedWorkspace,
  productionImportedBindingName,
  productionImportedDatabaseId,
  stagingImportedBindingName,
  stagingImportedDatabaseId,
} from './staging-import.js';

function mockDb(rows: Record<string, unknown>[]): Database {
  return {
    schema: 'public',
    table: (t: string) => t,
    query: async () => ({ rows, rowCount: rows.length }),
    transaction: async (cb: (tx: Database) => Promise<unknown>) => cb(mockDb(rows)),
  } as unknown as Database;
}

describe('imported database profiles (pure)', () => {
  it('selects the staging and production profiles from the deployment environment', () => {
    expect(getImportedDatabaseProfile({ ENVIRONMENT: 'staging' })).toEqual({
      environment: 'staging',
      bindingName: stagingImportedBindingName,
      databaseId: stagingImportedDatabaseId,
      identityTable: 'staging_workspace_identity',
      kind: 'staging_import',
    });
    expect(getImportedDatabaseProfile({ ENVIRONMENT: 'production' })).toEqual({
      environment: 'production',
      bindingName: productionImportedBindingName,
      databaseId: productionImportedDatabaseId,
      identityTable: 'production_workspace_identity',
      kind: 'legacy_import',
    });
    expect(getImportedDatabaseProfile({ ENVIRONMENT: 'development' })).toBeNull();
  });

  it('verifies imported slot matching deployment environment', () => {
    const stagingEnv = { ENVIRONMENT: 'staging' };
    expect(isImportedSlot(stagingEnv, stagingImportedBindingName, stagingImportedDatabaseId)).toBe(true);
    expect(isImportedSlot(stagingEnv, 'UNKNOWN_BINDING', 'unknown-id')).toBe(false);

    // Cross-wired environment fails closed
    expect(() =>
      isImportedSlot(stagingEnv, productionImportedBindingName, productionImportedDatabaseId),
    ).toThrow(/Imported database profile does not match this deployment/);
  });

  it('checks imported workspaces in postgres registry and catalog', async () => {
    const importedControl = mockDb([
      { source_database_id: stagingImportedDatabaseId, status: 'assigned' },
    ]);
    expect(await isImportedWorkspace(importedControl, 'ws-imported')).toBe(true);

    const normalControl = mockDb([
      { source_database_id: 'normal-tenant-db', status: 'assigned' },
    ]);
    expect(await isImportedWorkspace(normalControl, 'ws-normal')).toBe(false);

    const emptyControl = mockDb([]);
    expect(await isImportedWorkspace(emptyControl, 'ws-none')).toBe(false);
  });
});
