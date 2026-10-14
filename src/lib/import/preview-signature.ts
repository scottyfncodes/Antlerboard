/**
 * The league-history commit writes the preview the browser sends back. To
 * guarantee that is exactly what the server built from the uploaded files
 * (not an older preview, or one edited in transit), /check signs the parts
 * the commit writes and /commit refuses anything whose signature doesn't
 * verify. Database-side staleness (a Yahoo sync between preview and commit)
 * is handled separately: the commit re-runs every identity and overlap
 * check against the database inside its own transaction.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { LeagueHistoryPreview } from "./league-history-builder";

const CONTEXT = "league-history-preview:v1";

type Signed = Pick<LeagueHistoryPreview, "players" | "events" | "draftPicks" | "keeperChecks">;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set - required to sign the import preview.");
  return s;
}

function digest(p: Signed): string {
  const payload = JSON.stringify([p.players, p.events, p.draftPicks, p.keeperChecks]);
  return createHmac("sha256", secret()).update(`${CONTEXT}\n${payload}`).digest("hex");
}

export function signPreview(p: Signed): string {
  return `v1.${digest(p)}`;
}

export function verifyPreview(p: Signed, token: unknown): boolean {
  if (typeof token !== "string" || !token.startsWith("v1.")) return false;
  const expected = Buffer.from(digest(p), "hex");
  const given = Buffer.from(token.slice(3), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
