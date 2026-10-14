/**
 * Machine-readable provenance for rows the league-history import writes,
 * carried on their `sourceRef` (which already says where a row came from,
 * and is never shown to managers).
 *
 *   league-history:auction:Auctions_AllSeasons!12|price=recorded|order=source
 *
 * - price (Acquisition): how trustworthy `cost` is. The column is NOT NULL
 *   with a default of 0, so a missing price has to be said here - never
 *   left to look like a real $0.
 *     recorded  the source states this price (a real $0 Yahoo claim included)
 *     missing   the source had no price; `cost` is a 0 placeholder
 *     inferred  the import back-solved the price (e.g. from a keeper cost)
 *     rule      set by league rule, not paid (FYPD call-up: $0, $4 keeper base)
 * - order (DraftPick): where `overallPick` came from.
 *     source    the auction file's own pick/nomination number
 *     sheet     workbook row order - the real nomination order is unknown
 * - keeper-recorded (Acquisition, the stint's origin): seasons whose keeper
 *   cost the workbook recorded and the engine reproduced exactly, so the
 *   KeeperRecord for that season is a recorded cost even when the origin
 *   price itself was inferred.
 *
 * Rows without tags (hand-entered, app-created, or imported before this
 * existed) parse to an empty result; readers decide what that means.
 */

export type PriceProvenance = "recorded" | "missing" | "inferred" | "rule";
export type OrderProvenance = "source" | "sheet";

export interface Provenance {
  price?: PriceProvenance;
  order?: OrderProvenance;
  keeperRecorded: number[];
}

const PRICE_VALUES: PriceProvenance[] = ["recorded", "missing", "inferred", "rule"];
const ORDER_VALUES: OrderProvenance[] = ["source", "sheet"];

export function readProvenance(sourceRef: string | null | undefined): Provenance {
  const out: Provenance = { keeperRecorded: [] };
  if (!sourceRef) return out;
  for (const part of sourceRef.split("|").slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "price" && (PRICE_VALUES as string[]).includes(value)) out.price = value as PriceProvenance;
    else if (key === "order" && (ORDER_VALUES as string[]).includes(value)) out.order = value as OrderProvenance;
    else if (key === "keeper-recorded") {
      out.keeperRecorded = value
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n));
    }
  }
  return out;
}

/** The base ref with any provenance tags removed. */
export function baseRef(sourceRef: string): string {
  return sourceRef.split("|")[0];
}

/**
 * Appends provenance tags to a raw (untagged) ref. A "|" inside the raw ref
 * would read as a tag boundary; the import's refs never contain one, but a
 * sheet name could, so it is replaced.
 */
export function tagRef(rawRef: string, p: Partial<Provenance>): string {
  const parts = [rawRef.replace(/\|/g, "/")];
  if (p.price) parts.push(`price=${p.price}`);
  if (p.order) parts.push(`order=${p.order}`);
  const seasons = [...new Set(p.keeperRecorded ?? [])].sort((a, b) => a - b);
  if (seasons.length > 0) parts.push(`keeper-recorded=${seasons.join(",")}`);
  return parts.join("|");
}
