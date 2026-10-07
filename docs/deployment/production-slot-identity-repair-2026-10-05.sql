-- One-time reconciliation. The caller must verify physical database contents
-- under the workspace lease and hold all nine unused slots before execution.
WITH expected(binding_name, old_id, new_id) AS (VALUES
  ('TENANT_DB_000', '', '6af68e2a-f8a9-4d80-b04f-c42f35b1897b'),
  ('TENANT_DB_001', '6af68e2a-f8a9-4d80-b04f-c42f35b1897b', '6d2f4022-a685-4b85-8b2f-11b2e44006fd'),
  ('TENANT_DB_002', '6d2f4022-a685-4b85-8b2f-11b2e44006fd', '15040e32-414e-48f9-95a2-29d4d5b8d2ba'),
  ('TENANT_DB_003', '15040e32-414e-48f9-95a2-29d4d5b8d2ba', '1683e140-cac1-4887-96bd-78717d74a955'),
  ('TENANT_DB_004', '1683e140-cac1-4887-96bd-78717d74a955', '4118d771-1bff-4a09-878b-927669b4de28'),
  ('TENANT_DB_005', '4118d771-1bff-4a09-878b-927669b4de28', '652929c9-021c-46e2-a8e8-537d1ee56e9f'),
  ('TENANT_DB_006', '652929c9-021c-46e2-a8e8-537d1ee56e9f', '81d670cc-5af5-470e-93d7-c4bd54ee2522'),
  ('TENANT_DB_007', '81d670cc-5af5-470e-93d7-c4bd54ee2522', 'b8fbef52-3172-4d36-bc50-8673a96509fb'),
  ('TENANT_DB_008', 'b8fbef52-3172-4d36-bc50-8673a96509fb', '3378f64a-dfbd-468e-8658-85365d977a94'),
  ('TENANT_DB_009', '3378f64a-dfbd-468e-8658-85365d977a94', '2caa96ad-b22d-44ca-b162-e745e0c02d32')
), guard AS (
  SELECT 1 WHERE
    EXISTS(SELECT 1 FROM workspaces WHERE id='a8965287-71af-4afd-8786-c3fb33c54a74'
      AND owner_did='did:plc:lmkzmvv6sdxntwtyxpg7fqqq' AND state='active'
      AND execution_lease_token='slot-identity-repair:20f90bd2-b6d2-4440-b6b3-3bcff6dbbb88'
      AND execution_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id='a8965287-71af-4afd-8786-c3fb33c54a74'
      AND did='did:plc:lmkzmvv6sdxntwtyxpg7fqqq' AND role='owner')
    AND (SELECT count(*) FROM tenant_slots)=10
    AND (SELECT count(*) FROM expected e JOIN tenant_slots s ON s.binding_name=e.binding_name
      WHERE s.database_id=e.old_id AND s.schema_version=13
        AND ((e.binding_name='TENANT_DB_000' AND s.status='assigned'
          AND s.workspace_id='a8965287-71af-4afd-8786-c3fb33c54a74')
          OR (e.binding_name<>'TENANT_DB_000' AND s.status='available' AND s.workspace_id IS NULL)))=10
    AND (SELECT count(*) FROM tenant_slot_controls c JOIN expected e ON e.binding_name=c.binding_name
      WHERE e.binding_name<>'TENANT_DB_000' AND c.admission_enabled=0)=9
)
UPDATE tenant_slots
SET database_id=(SELECT new_id FROM expected WHERE expected.binding_name=tenant_slots.binding_name)
WHERE binding_name IN (SELECT binding_name FROM expected) AND EXISTS(SELECT 1 FROM guard);
