import { describe, expect, it } from 'vitest';
import { createTestContext } from './testing/test-utils.js';
import { workspaceTelemetry } from './operator-health.js';

describe('operator telemetry', () => {
  it('distinguishes unavailable metrics from measured zero and probe failures from target failures', async () => {
    const context = await createTestContext({ isolated: true });
    try {
      const db = context.db;
      const now = new Date('2026-10-05T00:00:00Z');
      expect(await workspaceTelemetry(db, now)).toMatchObject({
        lastSuccessfulTickAt: null,
        regionalProbes: null,
        reports: { lastSuccessfulAt: null, stale: null },
        notificationFailures: { count: 0, truncated: false },
      });
      await db.query(
        `INSERT INTO ${db.table('jobs')}(name,state_json,updated_at) VALUES('coordinator',$1,$2)`,
        [
          JSON.stringify({
            regionalProbes: { 'us-east': { attempts: 2, failures: 1, missingResults: 0 } },
          }),
          now.toISOString(),
        ],
      );
      expect((await workspaceTelemetry(db, now)).regionalProbes).toEqual({
        'us-east': { attempts: 2, failures: 1, missingResults: 0 },
      });
      await db.query(
        `INSERT INTO ${db.table('report_publications')}(report_key,kind,object_key,schema_version,status,updated_at) VALUES($1,'index',$2,'1','complete',$3)`,
        ['old', 'old.json', '2026-10-04T23:00:00Z'],
      );
      await db.query(
        `INSERT INTO ${db.table('report_publications')}(report_key,kind,object_key,schema_version,status,updated_at) VALUES($1,'index',$2,'1','complete',$3)`,
        ['fresh', 'fresh.json', now.toISOString()],
      );
      expect((await workspaceTelemetry(db, now)).reports).toMatchObject({
        stale: null,
        lastSuccessfulAt: null,
      });
      await db.query(
        `INSERT INTO ${db.table('report_publications')}
        (report_key,kind,object_key,schema_version,status,updated_at)
        VALUES('cohort','index','public/cohort.json','1','complete',$1)`,
        ['2026-10-04T23:00:00Z'],
      );
      expect((await workspaceTelemetry(db, now)).reports.stale).toBe(true);
      await db.query(
        `UPDATE ${db.table('report_publications')} SET updated_at=$1 WHERE report_key='cohort'`,
        [now.toISOString()],
      );
      await db.query(
        `UPDATE ${db.table('report_publications')} SET status='failed' WHERE report_key='old'`,
      );
      expect((await workspaceTelemetry(db, now)).reports).toMatchObject({
        stale: false,
        failedCount: 0,
        oldestSuccessfulAt: now.toISOString(),
      });
      await db.query(
        `UPDATE ${db.table('report_publications')} SET status='failed' WHERE report_key='cohort'`,
      );
      expect((await workspaceTelemetry(db, now)).reports).toMatchObject({
        stale: true,
        failedCount: 1,
        lastSuccessfulAt: null,
      });
      const plan = await db.transaction(async (tx) => {
        await tx.query('SET LOCAL enable_seqscan=off');
        return tx.query(
          `EXPLAIN SELECT updated_at FROM ${tx.table('report_publications')} WHERE report_key='cohort' AND status='complete'`,
        );
      });
      expect(JSON.stringify(plan.rows)).toContain('Index Scan');
      await context.postgresDb.adminDb.query(`DROP TABLE ${db.table('jobs')}`);
      await expect(workspaceTelemetry(db, now)).rejects.toThrow('does not exist');
    } finally {
      await context.close();
    }
  });
});
