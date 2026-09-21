#!/usr/bin/env bash
# Vercel's Postgres/Neon marketplace integration creates its connection
# strings as write-only "sensitive" env vars under whatever prefix was
# chosen when the storage was connected (e.g. DATABASE_URL_POSTGRES_PRISMA_URL)
# rather than the literal DATABASE_URL Prisma expects. If that prefixed var
# is present, prefer it; otherwise fall back to a plain DATABASE_URL/DIRECT_URL
# (local dev, or any provider that sets them directly).
set -euo pipefail

# Only remap when the Neon-prefixed vars are actually present (i.e. this is
# a Vercel build with that integration connected). Otherwise leave the
# environment untouched so Prisma's own .env loading (local dev, or any
# provider that sets DATABASE_URL/DIRECT_URL directly) works as normal.
if [ -n "${DATABASE_URL_POSTGRES_PRISMA_URL:-}" ]; then
  export DATABASE_URL="$DATABASE_URL_POSTGRES_PRISMA_URL"
  export DIRECT_URL="${DATABASE_URL_POSTGRES_URL_NON_POOLING:-$DATABASE_URL_POSTGRES_PRISMA_URL}"
fi

npx prisma migrate deploy
next build
