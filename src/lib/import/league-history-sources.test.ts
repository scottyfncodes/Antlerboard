import { describe, it, expect } from "vitest";
import { gzipSync } from "zlib";
import { yahooCsvText } from "./league-history-sources";

describe("yahooCsvText", () => {
  const csv = 'season,league_key,transaction_raw\n2024,431.l.2411,"{""transaction_key"":""431.l.2411.tr.1""}"\n';

  it("reads a plain CSV and the history export's .csv.gz alike (by content, not name)", () => {
    expect(yahooCsvText(Buffer.from(csv))).toBe(csv);
    expect(yahooCsvText(gzipSync(Buffer.from(csv)))).toBe(csv);
  });

  it("refuses a gzip that unpacks past the cap (a gzip bomb), rather than filling memory", () => {
    const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => yahooCsvText(bomb)).toThrow();
  });
});
