# Sourced by scripts/build.sh (and its parity test) - picks the database
# `prisma migrate deploy` runs against. Must match resolveDatabaseUrl() in
# src/lib/database-url.ts, which picks the database the app queries at
# runtime; if they ever disagree, the build migrates one database while the
# app reads another.
#
# Vercel's Postgres/Neon marketplace integration creates its connection
# strings as write-only "sensitive" env vars under whatever prefix was
# chosen when the storage was connected (e.g. DATABASE_URL_POSTGRES_PRISMA_URL)
# rather than the literal DATABASE_URL Prisma expects. If that prefixed var
# is present, prefer it; otherwise leave the environment untouched so a plain
# DATABASE_URL/DIRECT_URL (local dev, or any provider that sets them
# directly) works as normal.
if [ -n "${DATABASE_URL_POSTGRES_PRISMA_URL:-}" ]; then
  if [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" != "$DATABASE_URL_POSTGRES_PRISMA_URL" ]; then
    # Never prints credentials or hosts - only whether both point at the same
    # database, plus the database names.
    node -e '
      const parse = (s) => { try { const u = new URL(s); return { host: u.hostname.replace("-pooler", ""), db: u.pathname.slice(1) }; } catch { return null; } };
      const a = parse(process.env.DATABASE_URL), b = parse(process.env.DATABASE_URL_POSTGRES_PRISMA_URL);
      const same = a && b && a.host === b.host && a.db === b.db;
      console.warn(`[db-env] DATABASE_URL and DATABASE_URL_POSTGRES_PRISMA_URL are both set (${same ? "same database" : "DIFFERENT databases"}: "${a ? a.db : "unparseable"}" vs "${b ? b.db : "unparseable"}"). Migrations and runtime both use DATABASE_URL_POSTGRES_PRISMA_URL.`);
    ' || true
  fi
  export DATABASE_URL="$DATABASE_URL_POSTGRES_PRISMA_URL"
  export DIRECT_URL="${DATABASE_URL_POSTGRES_URL_NON_POOLING:-$DATABASE_URL_POSTGRES_PRISMA_URL}"
fi
