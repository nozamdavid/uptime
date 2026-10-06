-- Initialization script for uptime_staging database and roles
-- Run via: psql -U postgres -f init-uptime-staging.sql

-- 1. Create migration owner role (NOLOGIN, can be assumed by local peer postgres)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'uptime_staging_owner') THEN
    CREATE ROLE uptime_staging_owner WITH NOLOGIN;
  END IF;
END
$$;

-- 2. Create runtime worker role (LOGIN, unprivileged, no DDL rights)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'uptime_staging_worker') THEN
    CREATE ROLE uptime_staging_worker WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- 3. Allow postgres superuser to SET ROLE to uptime_staging_owner
GRANT uptime_staging_owner TO postgres;

-- 4. Create uptime_staging database if it does not already exist
SELECT 'CREATE DATABASE uptime_staging WITH OWNER uptime_staging_owner ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'uptime_staging')\gexec

-- 5. Configure database-level defaults
ALTER DATABASE uptime_staging SET timezone TO 'UTC';

-- 6. Lock down database connection privileges
REVOKE ALL ON DATABASE uptime_staging FROM PUBLIC;
REVOKE CONNECT ON DATABASE uptime_staging FROM PUBLIC;

GRANT CONNECT ON DATABASE uptime_staging TO uptime_staging_owner;
GRANT CONNECT ON DATABASE uptime_staging TO uptime_staging_worker;

-- 7. Schema public lockdown inside uptime_staging
\connect uptime_staging

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM uptime_staging_worker;

GRANT USAGE ON SCHEMA public TO uptime_staging_owner;
GRANT ALL PRIVILEGES ON SCHEMA public TO uptime_staging_owner;
