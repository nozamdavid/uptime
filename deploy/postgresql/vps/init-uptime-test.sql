-- Initialization script for isolated test database and testadmin role
-- Target: uptime_migration_test database, uptime_test_admin role
-- Run via: psql -U postgres -f init-uptime-test.sql

-- 1. Create test admin role (LOGIN, CREATEROLE for harnesses, NOSUPERUSER, NOCREATEDB, NOREPLICATION)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'uptime_test_admin') THEN
    CREATE ROLE uptime_test_admin WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION;
  ELSE
    ALTER ROLE uptime_test_admin WITH LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- 2. Create isolated test database if it does not already exist
SELECT 'CREATE DATABASE uptime_migration_test WITH OWNER uptime_test_admin ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'uptime_migration_test')\gexec

-- 3. Configure database defaults
ALTER DATABASE uptime_migration_test SET timezone TO 'UTC';

-- 4. Lock down database connection privileges
REVOKE ALL ON DATABASE uptime_migration_test FROM PUBLIC;
REVOKE CONNECT ON DATABASE uptime_migration_test FROM PUBLIC;

GRANT CONNECT, CREATE, TEMPORARY ON DATABASE uptime_migration_test TO uptime_test_admin;

-- 5. Explicitly block uptime_test_admin from uptime_staging and postgres
REVOKE ALL ON DATABASE uptime_staging FROM uptime_test_admin;
REVOKE CONNECT ON DATABASE uptime_staging FROM uptime_test_admin;

REVOKE CONNECT ON DATABASE postgres FROM uptime_test_admin;

-- 6. Schema setup inside uptime_migration_test
\connect uptime_migration_test

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL PRIVILEGES ON SCHEMA public TO uptime_test_admin;
ALTER SCHEMA public OWNER TO uptime_test_admin;
