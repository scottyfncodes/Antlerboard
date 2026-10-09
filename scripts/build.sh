#!/usr/bin/env bash
set -euo pipefail

# Point Prisma at the right database (see scripts/db-env.sh).
. "$(dirname "$0")/db-env.sh"

npx prisma migrate deploy
next build
