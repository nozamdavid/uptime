import { loadMigrationsForProfile } from '../packages/cloudflare/src/postgres/migrations/plan.js';
import {
  executePsqlAsOwner,
  generateSchemaMigrationSql,
  HOSTED_SLOTS,
  loadCatalog,
  planSchemaMigrations,
  type LedgerEntry,
} from './postgres-staging-bootstrap.js';

const schemas = [
  ...HOSTED_SLOTS.map(({ schema }) => ({ schema, profile: 'full-hosted' as const })),
  { schema: 'legacy_staging', profile: 'legacy-staging' as const },
];

export async function readPopulatedLedger(
  schema: string,
  execute: (sql: string) => Promise<string>,
): Promise<LedgerEntry[]> {
  const output = await execute(
    `\\t\n\\a\nSELECT json_agg(json_build_object('profile', profile, 'id', id, 'checksum', checksum))::text FROM "${schema}"."_postgres_migrations";\n`,
  );
  const json = output.trim().split('\n').at(-1);
  if (!json || json === '') throw new Error(`Missing migration ledger in ${schema}`);
  const ledger = JSON.parse(json) as LedgerEntry[] | null;
  if (!ledger?.length) throw new Error(`Empty migration ledger in ${schema}`);
  return ledger;
}

export async function main(
  args = process.argv.slice(2),
  execute: (sql: string) => Promise<string> = executePsqlAsOwner,
): Promise<void> {
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--apply')) {
    throw new Error('Usage: postgres-staging-upgrade.ts [--apply] (default: read-only plan)');
  }
  const apply = args[0] === '--apply';
  const catalog = loadCatalog();
  const expected = new Map(schemas.map((entry) => [entry.schema, entry.profile]));
  if (
    catalog.sources.length !== expected.size ||
    catalog.sources.some((source) => expected.get(source.schema) !== source.profile)
  ) {
    throw new Error('Staging catalog does not match the 14 reviewed tenant schemas');
  }

  const migrations = {
    'full-hosted': await loadMigrationsForProfile('full-hosted'),
    'legacy-staging': await loadMigrationsForProfile('legacy-staging'),
  };
  const plans = [];
  for (const { schema, profile } of schemas) {
    if (schema === 'legacy_staging') {
      const output = await execute(
        "\\t\n\\a\nSELECT CASE WHEN to_regnamespace('legacy_staging') IS NULL THEN 'absent' ELSE 'present' END;\n",
      );
      if (output.trim().split('\n').at(-1) === 'absent') {
        console.log('legacy_staging (legacy-staging): schema absent; no populated data to migrate');
        continue;
      }
    }
    const existingLedger = await readPopulatedLedger(schema, execute);
    const plan = planSchemaMigrations({
      schema,
      profile,
      migrations: migrations[profile],
      existingLedger,
    });
    const plannedMigrationIds = new Set(migrations[profile].map((migration) => migration.id));
    if (plan.pending.some((migration) => !plannedMigrationIds.has(migration.id))) {
      throw new Error(`Unexpected pending migration in ${schema}; review before applying`);
    }
    plans.push({ schema, profile, existingLedger, plan });
  }

  for (const { schema, profile, existingLedger, plan } of plans) {
    console.log(
      `${schema} (${profile}): ${plan.skippedCount} applied, ${plan.pendingCount} pending: ${plan.pending.map((migration) => migration.id).join(', ') || 'none'}`,
    );
    if (apply && plan.pendingCount > 0) {
      await execute(
        generateSchemaMigrationSql({
          schema,
          profile,
          migrations: migrations[profile],
          existingLedger,
        }),
      );
      console.log(`${schema}: committed`);
    }
  }
  if (!apply) console.log('Read-only plan. Pass --apply to execute pending migrations.');
}

if (process.argv[1]?.endsWith('postgres-staging-upgrade.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
