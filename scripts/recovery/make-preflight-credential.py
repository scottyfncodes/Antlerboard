#!/usr/bin/env python3
"""
Generate the recovery preflight's two secrets on your own computer, so neither
ever appears in chat or in a log.

Usage:  python3 -I scripts/recovery/make-preflight-credential.py

Prints, for you alone:
  1. The statement that sets the read-only role's password. Run it in the
     Neon SQL editor. (Neon only accepts plaintext passwords, so it can't be
     given a pre-hashed one.)
  2. The value for the GitHub secret PREFLIGHT_DATABASE_URL.
  3. The value for RECOVERY_DRYRUN_TOKEN: the GitHub secret and the Vercel
     Production environment variable, both set to the same value.
Nothing is written to disk. Clear the terminal once all three are saved.
"""
import secrets

ROLE = "antlerboard_preflight"
# Production branch "main", direct (unpooled) endpoint: session settings such
# as default_transaction_read_only only take effect without the pooler.
HOST = "ep-divine-smoke-avq2vhuj.c-11.us-east-1.aws.neon.tech"
DATABASE = "neondb"


def generate():
    # URL-safe, so the password needs no escaping in the URL or the SQL literal.
    password = secrets.token_urlsafe(32)
    return {
        "sql": f"ALTER ROLE {ROLE} WITH PASSWORD '{password}';",
        "database_url": f"postgresql://{ROLE}:{password}@{HOST}/{DATABASE}?sslmode=require&channel_binding=require",
        "dry_run_token": secrets.token_urlsafe(48),
    }


def main():
    g = generate()
    print("1. Neon SQL editor (project hidden-wave-58536414, branch main, database neondb):\n")
    print(f"   {g['sql']}\n")
    print("2. GitHub > Settings > Secrets and variables > Actions > New repository secret")
    print("   Name: PREFLIGHT_DATABASE_URL   Secret:\n")
    print(f"   {g['database_url']}\n")
    print("3. The same value in both places:")
    print("   - GitHub repository secret, Name: RECOVERY_DRYRUN_TOKEN")
    print("   - Vercel > antlerboard > Settings > Environment Variables, Key: RECOVERY_DRYRUN_TOKEN,")
    print("     Environments: Production only, Sensitive: on\n")
    print(f"   {g['dry_run_token']}\n")
    print("Nothing was saved. Clear this terminal once all three are done.")


if __name__ == "__main__":
    main()
