#!/bin/sh
set -eu
pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"
