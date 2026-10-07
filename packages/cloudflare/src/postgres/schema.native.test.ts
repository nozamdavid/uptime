import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresTestDatabase, type PostgresTestDatabase } from '../testing/postgres.js';
import { openPostgresDatabase, type Database } from './database.js';
import { importPostgresData } from './import.js';
import { applyPostgresMigrations } from './migrate.js';
import {
  CONTROL_TABLES,
  TENANT_TABLES,
  loadMigrationsForProfile,
  type MigrationProfile,
} from './migrations/plan.js';
import { resolvePostgresWorkspaceDatabase } from './tenancy.js';

const timestamp = '2026-10-05T00:00:00.000Z';
const profiles = ['control', 'full-hosted', 'legacy-staging', 'legacy-production'] as const;
const fixtures = new Map<MigrationProfile, PostgresTestDatabase>();
const fixture = (profile: MigrationProfile) => fixtures.get(profile)!;

async function monitor(db: Database, id: string) {
  await db.query(
    `INSERT INTO ${db.table('monitors')}
    (id,url,interval_seconds,timeout_ms,outage_threshold,recovery_threshold,next_check_at)
    VALUES ($1,'https://example.com',300,1000,2,1,$2)`,
    [id, timestamp],
  );
}

async function run(db: Database, id: string, monitorId: string, day: string) {
  await db.query(
    `INSERT INTO ${db.table('check_runs')}
    (id,monitor_id,window_started_at,expected_region_count,expected_regions,monitor_url,timeout_ms,deadline_at)
    VALUES ($1,$2,$3,3,'["eu-west","us-east","asia"]','https://example.com',1000,$3)`,
    [id, monitorId, day],
  );
}

async function observe(
  db: Database,
  id: string,
  runId: string,
  monitorId: string,
  region: string,
  day: string,
) {
  await db.query(
    `INSERT INTO ${db.table('observations')}
    (id,check_run_id,monitor_id,region_id,scheduled_window,status,success,response_ms,started_at)
    VALUES ($1,$2,$3,$4,$5,'success',1,10,$5)`,
    [id, runId, monitorId, region, day],
  );
}

async function finalize(db: Database, id: string, status: string) {
  await db.transaction(async (tx) => {
    await tx.query(`SELECT id FROM ${tx.table('check_runs')} WHERE id=$1 FOR NO KEY UPDATE`, [id]);
    await tx.query(`UPDATE ${tx.table('check_runs')} SET status=$2 WHERE id=$1`, [id, status]);
  });
}

/** The contender starts only after the first transaction has acquired its lock. */
async function race(
  first: Database,
  second: Database,
  hold: (tx: Database) => Promise<void>,
  compete: (db: Database) => Promise<void>,
) {
  const backend = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  let locked!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const one = first.transaction(async (tx) => {
    await hold(tx);
    locked();
    await gate;
  });
  await Promise.race([ready, one]);
  const two = compete(second);
  const outcomes = Promise.allSettled([one, two]);
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const check = await fixture('legacy-production').adminDb.query<{ count: number }>(
        'SELECT cardinality(pg_blocking_pids($1))::integer AS count',
        [backend.rows[0]!.pid],
      );
      if ((check.rows[0]?.count ?? 0) > 0) {
        blocked = true;
        break;
      }
    }
    expect(blocked, 'contender must actually wait on the first transaction').toBe(true);
  } finally {
    release();
    await outcomes;
  }
  return outcomes;
}

describe.skipIf(!process.env.POSTGRES_TEST_ADMIN_URL)('PostgreSQL 18 schema behavior', () => {
  beforeAll(async () => {
    for (const profile of profiles) {
      fixtures.set(
        profile,
        await createPostgresTestDatabase({
          migrations: await loadMigrationsForProfile(profile),
          profile,
          tables: [
            ...CONTROL_TABLES,
            ...TENANT_TABLES,
            'workspace_seat_limits',
            'tier_schedulable_monitors',
            'tier_active_notification_services',
            'staging_workspace_identity',
            'production_workspace_identity',
          ],
        }),
      );
    }
    const { rows } = await fixture('control').db.query<{ version: number; database: string }>(
      `SELECT current_setting('server_version_num')::int AS version, current_database() AS database`,
    );
    expect(rows[0]?.version).toBeGreaterThanOrEqual(180000);
    expect(rows[0]?.version).toBeLessThan(190000);
    expect(rows[0]?.database).toBe('uptime_migration_test');
  }, 120_000);

  afterAll(async () => {
    for (const testDb of fixtures.values()) await testDb.close();
  }, 120_000);

  it.each(profiles)(
    'applies and checksum-reruns %s with the actual table shape',
    async (profile) => {
      const testDb = fixture(profile);
      const migrations = await loadMigrationsForProfile(profile);
      await applyPostgresMigrations(testDb.adminDb, migrations, profile);
      await expect(
        applyPostgresMigrations(testDb.adminDb, migrations, 'different-profile'),
      ).rejects.toThrow('profile is immutable');
      const { rows } = await testDb.db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE'`,
        [testDb.schema],
      );
      const names = rows.map((row) => row.table_name).sort();
      const expected =
        profile === 'control'
          ? CONTROL_TABLES
          : profile === 'full-hosted'
            ? TENANT_TABLES
            : [
                ...TENANT_TABLES.filter(
                  (name) => name !== 'workspace_metadata' && name !== 'verified_targets',
                ),
                profile === 'legacy-staging'
                  ? 'staging_workspace_identity'
                  : 'production_workspace_identity',
              ];
      // The runtime role cannot see the owner-only migration ledger.
      expect(names).toEqual([...expected].sort());
      if (profile === 'full-hosted') {
        await testDb.db.query("SELECT set_config('TimeZone', 'Pacific/Auckland', false)");
        await testDb.db.query(`INSERT INTO ${testDb.db.table('badges')}(id,name,color)
        VALUES ('utc-default','UTC native','#123456')`);
        const clock = await testDb.db.query<{ current_utc: boolean; created_at: string }>(
          `SELECT abs(extract(epoch FROM (created_at::timestamptz-clock_timestamp()))) < 10 AS current_utc,
          created_at FROM ${testDb.db.table('badges')} WHERE id='utc-default'`,
        );
        expect(clock.rows[0]?.current_utc).toBe(true);
        expect(clock.rows[0]?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        await testDb.db.query("SELECT set_config('TimeZone', 'UTC', false)");
      }
      await expect(
        applyPostgresMigrations(
          testDb.adminDb,
          [{ ...migrations[0]!, sql: `${migrations[0]!.sql}\n-- changed` }],
          profile,
        ),
      ).rejects.toThrow('migration changed');
    },
    120_000,
  );

  it('loads preserved history, restores trigger modes on success/failure, and advances identity IDs', async () => {
    for (const profile of profiles) {
      const testDb = fixture(profile);
      const trigger =
        profile === 'control'
          ? 'product_catalog_revision_immutable_delete'
          : 'monitor_daily_uptime_closed_delete_revision';
      const table = profile === 'control' ? 'product_catalog_revisions' : 'monitor_daily_uptime';
      await testDb.adminDb.query(
        `ALTER TABLE ${testDb.adminDb.table(table)} DISABLE TRIGGER ${trigger}`,
      );
      const replicaTrigger =
        profile === 'control'
          ? 'product_catalog_revision_immutable_update'
          : 'monitor_daily_uptime_closed_insert_revision';
      const alwaysTrigger =
        profile === 'control'
          ? 'workspace_tier_assignment_update'
          : 'monitor_daily_uptime_closed_update_revision';
      const alwaysTable = profile === 'control' ? 'workspace_tier_assignments' : table;
      await testDb.adminDb.query(
        `ALTER TABLE ${testDb.adminDb.table(table)} ENABLE REPLICA TRIGGER ${replicaTrigger}`,
      );
      await testDb.adminDb.query(
        `ALTER TABLE ${testDb.adminDb.table(alwaysTable)} ENABLE ALWAYS TRIGGER ${alwaysTrigger}`,
      );
      const states = () =>
        testDb.adminDb.query(
          `SELECT t.tgname, t.tgenabled FROM pg_trigger t
        JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND NOT t.tgisinternal ORDER BY t.tgname`,
          [testDb.schema],
        );
      const before = (await states()).rows;
      await importPostgresData(testDb.adminDb, profile, async (tx) => {
        if (profile === 'control') {
          await tx.query(
            `INSERT INTO ${tx.table('users')} VALUES ('owner','owner.test','active',$1,$1,$1)`,
            [timestamp],
          );
          await tx.query(
            `INSERT INTO ${tx.table('workspaces')}(id,owner_did,name,created_at,updated_at)
            VALUES ('workspace','owner','test',$1,$1)`,
            [timestamp],
          );
        } else {
          await monitor(tx, 'historical');
          await run(tx, 'historical-run', 'historical', timestamp);
          await tx.query(
            `UPDATE ${tx.table('check_runs')} SET status='complete' WHERE id='historical-run'`,
          );
          await observe(
            tx,
            'historical-observation',
            'historical-run',
            'historical',
            'eu-west',
            timestamp,
          );
          await tx.query(`INSERT INTO ${tx.table('monitor_daily_uptime')}
            (monitor_id,day,uptime_percentage,weight,received_count,success_count,response_sum_ms,response_count_ms,source)
            VALUES ('historical','2026-10-05',75,4,4,3,30,3,'imported')`);
          await tx.query(`INSERT INTO ${tx.table('report_latency_changes')}
            (sequence,operation,observation_id,monitor_id) VALUES (900,1,'original-id','historical')`);
        }
      });
      expect((await states()).rows).toEqual(before);
      await expect(
        importPostgresData(testDb.adminDb, profile, async (tx) => {
          if (profile === 'control') {
            await tx.query(
              `INSERT INTO ${tx.table('workspace_events')}(id,event,created_at,details)
            VALUES ('rolled-back','test',$1,'{}')`,
              [timestamp],
            );
          } else {
            await tx.query(
              `INSERT INTO ${tx.table('badges')}(id,name,color) VALUES ('rolled-back','test','#112233')`,
            );
          }
          throw new Error('loader failed');
        }),
      ).rejects.toThrow('loader failed');
      expect((await states()).rows).toEqual(before);
      const rollbackTable = profile === 'control' ? 'workspace_events' : 'badges';
      expect(
        (
          await testDb.db.query(
            `SELECT id FROM ${testDb.db.table(rollbackTable)} WHERE id='rolled-back'`,
          )
        ).rows,
      ).toEqual([]);
      await testDb.adminDb.query(
        `ALTER TABLE ${testDb.adminDb.table(table)} ENABLE TRIGGER ${trigger}`,
      );
      await testDb.adminDb.query(
        `ALTER TABLE ${testDb.adminDb.table(table)} ENABLE TRIGGER ${replicaTrigger}`,
      );
      await testDb.adminDb.query(
        `ALTER TABLE ${testDb.adminDb.table(alwaysTable)} ENABLE TRIGGER ${alwaysTrigger}`,
      );
      if (profile !== 'control') {
        expect(
          (
            await testDb.db.query(`INSERT INTO ${testDb.db.table('report_latency_changes')}
          (operation,observation_id,monitor_id) VALUES (1,'new-id','historical') RETURNING sequence::int`)
          ).rows,
        ).toEqual([{ sequence: 901 }]);
        await observe(
          testDb.db,
          'historical-late',
          'historical-run',
          'historical',
          'us-east',
          timestamp,
        );
        expect(
          (
            await testDb.db.query(
              `SELECT received_count,source FROM ${testDb.db.table('monitor_daily_uptime')} WHERE monitor_id='historical'`,
            )
          ).rows,
        ).toEqual([{ received_count: 4, source: 'imported' }]);
      }
    }
  }, 120_000);

  it('counts pending finalization and competing late observations exactly, without retention decrements', async () => {
    const testDb = fixture('full-hosted');
    const second = await testDb.openConnection();
    await monitor(testDb.db, 'aggregate');
    for (const [index, status] of ['complete', 'partial'].entries()) {
      const day = `2026-09-0${index + 1}T00:00:00.000Z`;
      const id = `aggregate-${index}`;
      await run(testDb.db, id, 'aggregate', day);
      expect(
        (
          await testDb.db.query(
            `SELECT received_count FROM ${testDb.db.table('monitor_daily_uptime')}
        WHERE monitor_id='aggregate' AND day=$1`,
            [day.slice(0, 10)],
          )
        ).rows,
      ).toEqual([]);
      const outcomes = await race(
        testDb.db,
        second,
        (tx) => observe(tx, `${id}-early`, id, 'aggregate', 'eu-west', day),
        (db) => finalize(db, id, status),
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      const late = await race(
        testDb.db,
        second,
        (tx) => observe(tx, `${id}-late1`, id, 'aggregate', 'us-east', day),
        (db) => observe(db, `${id}-late2`, id, 'aggregate', 'asia', day),
      );
      expect(late.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(
        (
          await testDb.db.query(
            `SELECT received_count,success_count,response_count_ms,response_sum_ms,
        uptime_percentage,weight FROM ${testDb.db.table('monitor_daily_uptime')} WHERE monitor_id='aggregate' AND day=$1`,
            [day.slice(0, 10)],
          )
        ).rows,
      ).toEqual([
        {
          received_count: 3,
          success_count: 3,
          response_count_ms: 3,
          response_sum_ms: 30,
          uptime_percentage: 100,
          weight: 3,
        },
      ]);
      await finalize(testDb.db, id, status);
      await testDb.db.query(
        `DELETE FROM ${testDb.db.table('observations')} WHERE check_run_id=$1`,
        [id],
      );
      expect(
        (
          await testDb.db.query(
            `SELECT received_count FROM ${testDb.db.table('monitor_daily_uptime')} WHERE monitor_id='aggregate' AND day=$1`,
            [day.slice(0, 10)],
          )
        ).rows,
      ).toEqual([{ received_count: 3 }]);
    }
    const day = '2026-09-03T00:00:00.000Z';
    await run(testDb.db, 'finalize-first', 'aggregate', day);
    const reverse = await race(
      testDb.db,
      second,
      async (tx) => {
        await tx.query(
          `SELECT id FROM ${tx.table('check_runs')} WHERE id='finalize-first' FOR NO KEY UPDATE`,
        );
        await tx.query(
          `UPDATE ${tx.table('check_runs')} SET status='complete' WHERE id='finalize-first'`,
        );
      },
      (db) => observe(db, 'after-finalization', 'finalize-first', 'aggregate', 'eu-west', day),
    );
    expect(reverse.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(
      (
        await testDb.db.query(`SELECT received_count FROM ${testDb.db.table('monitor_daily_uptime')}
      WHERE monitor_id='aggregate' AND day='2026-09-03'`)
      ).rows,
    ).toEqual([{ received_count: 1 }]);
  }, 120_000);

  it('enforces the last monitor and last seat with competing connections, including seat updates', async () => {
    const tenant = fixture('full-hosted');
    await tenant.db
      .query(`INSERT INTO ${tenant.db.table('workspace_metadata')}(workspace_id,database_id,monitor_limit)
      VALUES ('workspace','source',3)`);
    const outcomes = await race(
      tenant.db,
      await tenant.openConnection(),
      (tx) => monitor(tx, 'last-monitor'),
      (db) => monitor(db, 'over-monitor'),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(outcomes[1]).toMatchObject({ reason: { code: '23514' } });
    await expect(
      tenant.db.query(
        `UPDATE ${tenant.db.table('workspace_metadata')} SET allowed_region_ids='[null]'`,
      ),
    ).rejects.toThrow();
    await expect(
      tenant.db.query(
        `UPDATE ${tenant.db.table('workspace_metadata')} SET allowed_region_ids='["eu-west","eu-west","asia"]'`,
      ),
    ).rejects.toThrow();
    await expect(
      tenant.db.query(
        `UPDATE ${tenant.db.table('monitors')} SET uptime_thresholds='invalid' WHERE id='aggregate'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const control = fixture('control');
    await control.db.query(
      `INSERT INTO ${control.db.table('memberships')} VALUES ('workspace','owner','owner',$1)`,
      [timestamp],
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('workspace_invitations')}
      VALUES ('invite-one','workspace','did:one','viewer',$1)`,
      [timestamp],
    );
    const invite = (db: Database, id: string) =>
      db
        .query(
          `INSERT INTO ${db.table('workspace_invitations')}
      VALUES ($1,'workspace',$1,'viewer',$2)`,
          [id, timestamp],
        )
        .then(() => undefined);
    const seats = await race(
      control.db,
      await control.openConnection(),
      (tx) => invite(tx, 'last-seat'),
      (db) => invite(db, 'over-seat'),
    );
    expect(seats.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(seats[1]).toMatchObject({ reason: { code: '23514' } });
    // Replacing an invitation with its member does not consume an extra seat.
    await control.db.query(
      `INSERT INTO ${control.db.table('users')} VALUES ('did:one','one.test','active',$1,$1,$1)`,
      [timestamp],
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('memberships')} VALUES ('workspace','did:one','viewer',$1)`,
      [timestamp],
    );
    await control.db.query(
      `DELETE FROM ${control.db.table('workspace_invitations')} WHERE id='invite-one'`,
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('users')} VALUES ('replacement-member','replacement.test','active',$1,$1,$1)`,
      [timestamp],
    );
    await control.db.query(`UPDATE ${control.db.table('memberships')} SET did='replacement-member'
      WHERE workspace_id='workspace' AND did='did:one'`);
    // Updating an existing invitation's role at capacity excludes its own row.
    await control.db.query(
      `UPDATE ${control.db.table('workspace_invitations')} SET role='maintainer' WHERE id='last-seat'`,
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('users')} VALUES ('second-owner','two.test','active',$1,$1,$1)`,
      [timestamp],
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('workspaces')}(id,owner_did,name,created_at,updated_at)
      VALUES ('other-workspace','second-owner','other',$1,$1)`,
      [timestamp],
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('memberships')} VALUES ('other-workspace','second-owner','owner',$1)`,
      [timestamp],
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('workspace_invitations')}
      VALUES ('other-invite','other-workspace','outsider','viewer',$1)`,
      [timestamp],
    );
    await expect(
      control.db
        .query(`UPDATE ${control.db.table('workspace_invitations')} SET workspace_id='workspace'
      WHERE id='other-invite'`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      control.db.query(`UPDATE ${control.db.table('memberships')} SET workspace_id='workspace'
      WHERE workspace_id='other-workspace'`),
    ).rejects.toMatchObject({ code: '23514' });
  }, 120_000);

  it('serializes the custom-domain last-slot caller transaction and enforces active uniqueness', async () => {
    const testDb = fixture('control');
    const createDomain = (db: Database, id: string) =>
      db.transaction(async (tx) => {
        await tx.query(
          `SELECT id FROM ${tx.table('workspaces')} WHERE id='other-workspace' FOR NO KEY UPDATE`,
        );
        const count = await tx.query<{
          count: number;
        }>(`SELECT count(*)::int AS count FROM ${tx.table('custom_status_domains')}
        WHERE workspace_id='other-workspace' AND deleted_at IS NULL`);
        if (count.rows[0]!.count >= 1) throw new Error('custom_domain_limit');
        await tx.query(
          `INSERT INTO ${tx.table('custom_status_domains')}
        (id,workspace_id,status_page_id,hostname,provider_mode,status,created_at,updated_at)
        VALUES ($1,'other-workspace',$1,$2,'mock','pending',$3,$3)`,
          [id, `${id}.example.com`, timestamp],
        );
      });
    const outcomes = await race(
      testDb.db,
      await testDb.openConnection(),
      async (tx) => {
        await tx.query(
          `SELECT id FROM ${tx.table('workspaces')} WHERE id='other-workspace' FOR NO KEY UPDATE`,
        );
        await tx.query(
          `INSERT INTO ${tx.table('custom_status_domains')}
        (id,workspace_id,status_page_id,hostname,provider_mode,status,created_at,updated_at)
        VALUES ('last-domain','other-workspace','page','last.example.com','mock','pending',$1,$1)`,
          [timestamp],
        );
      },
      (db) => createDomain(db, 'over-domain'),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(outcomes[1]).toMatchObject({ reason: { message: 'custom_domain_limit' } });
    await expect(
      testDb.db.query(
        `INSERT INTO ${testDb.db.table('custom_status_domains')}
      (id,workspace_id,status_page_id,hostname,provider_mode,status,created_at,updated_at)
      VALUES ('duplicate','workspace','different','last.example.com','mock','pending',$1,$1)`,
        [timestamp],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  }, 120_000);

  it('routes only catalog-approved assigned physical identities and rejects cross-schema substitution', async () => {
    const control = fixture('control');
    const tenant = fixture('legacy-staging');
    await tenant.db.query(
      `INSERT INTO ${tenant.db.table('staging_workspace_identity')} VALUES (1,'workspace','legacy-source')`,
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('postgres_tenant_registry')}
      (source_database_id,workspace_id,schema_name,status) VALUES ('legacy-source','workspace',$1,'assigned')`,
      [tenant.schema],
    );
    // Shared owner connection simulates deployment's role having grants to every tenant.
    const catalog = [
      {
        sourceDatabaseId: 'legacy-source',
        schema: tenant.schema,
        tables: ['staging_workspace_identity', 'monitors'],
        identityTable: 'staging_workspace_identity' as const,
      },
    ];
    const resolved = await resolvePostgresWorkspaceDatabase(control.adminDb, 'workspace', catalog);
    expect((await resolved.query(`SELECT id FROM ${resolved.table('monitors')}`)).rows).toEqual([
      { id: 'historical' },
    ]);
    await expect(
      resolvePostgresWorkspaceDatabase(control.adminDb, 'workspace', [
        { ...catalog[0]!, schema: fixture('legacy-production').schema },
      ]),
    ).rejects.toThrow('outside the trusted catalog');
    await expect(
      control.db.query(
        `UPDATE ${control.db.table('postgres_tenant_registry')} SET source_database_id='swapped'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await control.db.query(
      `UPDATE ${control.db.table('postgres_tenant_registry')} SET status='quarantined'`,
    );
    await expect(resolved.query(`SELECT id FROM ${resolved.table('monitors')}`)).rejects.toThrow(
      'no assigned',
    );
    await control.db.query(`INSERT INTO ${control.db.table('postgres_tenant_registry')}
      (source_database_id,schema_name,status) VALUES ('unassigned','tenant_unused','available')`);
  }, 120_000);

  it('serializes resolved tenant quota writes without shared-marker lock upgrade deadlocks', async () => {
    const control = fixture('control');
    const tenant = fixture('full-hosted');
    await control.db.query(
      `INSERT INTO ${control.db.table('users')} VALUES ('resolved-owner','resolved.test','active',$1,$1,$1)`,
      [timestamp],
    );
    await control.db.query(
      `INSERT INTO ${control.db.table('workspaces')}(id,owner_did,name,created_at,updated_at)
      VALUES ('resolved-workspace','resolved-owner','resolved',$1,$1)`,
      [timestamp],
    );
    await tenant.db.query(`UPDATE ${tenant.db.table('workspace_metadata')}
      SET workspace_id='resolved-workspace',database_id='hosted-source',monitor_limit=4`);
    await control.db.query(
      `INSERT INTO ${control.db.table('postgres_tenant_registry')}
      (source_database_id,workspace_id,schema_name,status) VALUES ('hosted-source','resolved-workspace',$1,'assigned')`,
      [tenant.schema],
    );
    const connections = await Promise.all(
      [0, 1].map(() =>
        openPostgresDatabase({
          connectionString: process.env.POSTGRES_TEST_ADMIN_URL!,
          schema: control.schema,
          tables: CONTROL_TABLES,
        }),
      ),
    );
    try {
      const catalog = [
        { sourceDatabaseId: 'hosted-source', schema: tenant.schema, tables: TENANT_TABLES },
      ];
      const first = await resolvePostgresWorkspaceDatabase(
        connections[0]!,
        'resolved-workspace',
        catalog,
      );
      const second = await resolvePostgresWorkspaceDatabase(
        connections[1]!,
        'resolved-workspace',
        catalog,
      );
      const outcomes = await race(
        first,
        second,
        (tx) => monitor(tx, 'resolved-last'),
        (db) => monitor(db, 'resolved-over'),
      );
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
      expect(outcomes[1]).toMatchObject({ reason: { code: '23514' } });
    } finally {
      await Promise.all(connections.map((connection) => connection.close()));
    }
  }, 120_000);

  it('preserves historical legacy exemptions beyond hosted resource caps', async () => {
    const legacy = fixture('legacy-production');
    await legacy.db.query(
      `INSERT INTO ${legacy.db.table('monitors')}
      (id,url,interval_seconds,timeout_ms,next_check_at)
      SELECT 'legacy-extra-' || i,'https://example.com',60,1000,$1 FROM generate_series(1,4) AS i`,
      [timestamp],
    );
    expect(
      (await legacy.db.query(`SELECT count(*)::int AS count FROM ${legacy.db.table('monitors')}`))
        .rows,
    ).toEqual([{ count: 5 }]);
    await expect(
      importPostgresData(legacy.db, 'legacy-production', async () => undefined),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      importPostgresData(legacy.adminDb, 'legacy-production', (tx) =>
        tx.query(
          `INSERT INTO ${tx.table('sessions')}(id,admin_id,token_hash,expires_at)
        VALUES ('invalid-fk','missing-admin','hash',$1)`,
          [timestamp],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  }, 120_000);
});
