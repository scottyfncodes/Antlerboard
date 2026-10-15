#!/usr/bin/env bash
# League-history import rehearsal on a fresh local replica (see README.md).
#   REHEARSAL_DATABASE_URL=postgresql://postgres:...@localhost:5432/antlerboard_rehearsal \
#   REHEARSAL_REPLICA=.rehearsal/replica \
#   REHEARSAL_WORKBOOK=... REHEARSAL_AUCTION=... REHEARSAL_YAHOO=... REHEARSAL_OUT=report.json \
#   bash scripts/rehearsal/run.sh
set -euo pipefail
: "${REHEARSAL_DATABASE_URL:?}" "${REHEARSAL_REPLICA:?}" "${REHEARSAL_WORKBOOK:?}" "${REHEARSAL_AUCTION:?}" "${REHEARSAL_YAHOO:?}"
case "$REHEARSAL_DATABASE_URL" in *@localhost:*|*@127.0.0.1:*) ;; *) echo "REHEARSAL_DATABASE_URL must be local" >&2; exit 2;; esac
db="${REHEARSAL_DATABASE_URL##*/}"; db="${db%%\?*}"
admin="${REHEARSAL_DATABASE_URL%/*}/postgres"
psql "$admin" -q -c "drop database if exists \"$db\"" -c "create database \"$db\""
DATABASE_URL="$REHEARSAL_DATABASE_URL" DIRECT_URL="$REHEARSAL_DATABASE_URL" npx prisma db push --skip-generate >/dev/null
npx tsx scripts/rehearsal/seed-replica.ts "$REHEARSAL_REPLICA"
npx vitest run --config scripts/rehearsal/vitest.config.ts
