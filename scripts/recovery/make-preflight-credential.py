#!/usr/bin/env python3
"""
Generate the password for the read-only antlerboard_preflight role, on your
own computer, without it ever appearing in the Neon console, chat, or logs.

Usage:  python3 -I scripts/recovery/make-preflight-credential.py

Prints two things for you alone:
  1. An ALTER ROLE statement carrying only the SCRAM-SHA-256 verifier (a salted
     hash). Run it in the Neon SQL editor; Neon stores the verifier and never
     sees the password.
  2. The connection URL to paste into the GitHub secret PREFLIGHT_DATABASE_URL.
Nothing is written to disk. Close or clear the terminal afterwards.
"""
import base64, hashlib, hmac, secrets

ROLE = "antlerboard_preflight"
# Production branch "main", direct (unpooled) endpoint: session settings such
# as default_transaction_read_only only take effect without the pooler.
HOST = "ep-divine-smoke-avq2vhuj.c-11.us-east-1.aws.neon.tech"
DATABASE = "neondb"
ITERATIONS = 4096


def scram_verifier(password: str, salt: bytes, iterations: int = ITERATIONS) -> str:
    """The SCRAM-SHA-256 verifier PostgreSQL stores for a password (RFC 5802/7677)."""
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    b64 = lambda b: base64.b64encode(b).decode()
    return f"SCRAM-SHA-256${iterations}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


def main():
    password = secrets.token_urlsafe(32)  # 256 bits, URL-safe so the URL needs no escaping
    verifier = scram_verifier(password, secrets.token_bytes(16))
    print("1. Run this in the Neon SQL editor (branch main, database neondb):\n")
    print(f"   ALTER ROLE {ROLE} WITH PASSWORD '{verifier}';\n")
    print("2. Paste this as the GitHub repository secret PREFLIGHT_DATABASE_URL:\n")
    print(f"   postgresql://{ROLE}:{password}@{HOST}/{DATABASE}?sslmode=require&channel_binding=require\n")
    print("Nothing was saved. Clear this terminal once both are done.")


if __name__ == "__main__":
    main()
