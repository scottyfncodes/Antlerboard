import { describe, it, expect } from "vitest";
import { normalizePlayerName, matchPlayerName, editDistance } from "./player-names";

describe("normalizePlayerName", () => {
  it("strips the workbook's MLB-team/position tails in both forms", () => {
    expect(normalizePlayerName("Juan Soto (NYM - OF)").display).toBe("Juan Soto");
    expect(normalizePlayerName("Kyle Tucker LAD - OF").display).toBe("Kyle Tucker");
    expect(normalizePlayerName("José Ramírez(Cle - 2B,3B)").display).toBe("José Ramírez");
    expect(normalizePlayerName("Noelvi Marte (CIN - 3B,OF)").fullKey).toBe("noelvi marte");
  });

  it("produces the same full key for accented and plain spellings", () => {
    expect(normalizePlayerName("José Ramírez").fullKey).toBe(normalizePlayerName("Jose Ramirez").fullKey);
  });

  it("reads 'J.Soto' as an abbreviated first name and drops suffixes", () => {
    const n = normalizePlayerName("J.Soto");
    expect(n.abbreviated).toBe(true);
    expect(n.initialKey).toBe("j soto");
    expect(normalizePlayerName("B. Witt Jr.").initialKey).toBe("b witt");
    expect(normalizePlayerName("Bobby Witt Jr.").initialKey).toBe("b witt");
    expect(normalizePlayerName("Bobby Witt Jr.").fullKey).toBe("bobby witt");
  });

  it("keeps Ohtani's two-way marker separately", () => {
    const n = normalizePlayerName("S. Ohtani (B)");
    expect(n.twoWayMarker).toBe("B");
    expect(n.initialKey).toBe("s ohtani");
  });

  it("handles two-letter first names and hyphenated last names", () => {
    expect(normalizePlayerName("JJ Wetherholt").abbreviated).toBe(false);
    expect(normalizePlayerName("Pete Crow-Armstrong").lastKey).toBe("crow-armstrong");
    expect(normalizePlayerName("I.Kiner-Filefa").initialKey).toBe("i kiner-filefa");
  });
});

describe("editDistance", () => {
  it("counts single-character edits", () => {
    expect(editDistance("whales", "whalers")).toBe(1);
    expect(editDistance("filefa", "falefa")).toBe(1);
    expect(editDistance("same", "same")).toBe(0);
  });
});

describe("matchPlayerName", () => {
  const roster = [
    { name: "Juan Soto", value: "soto" },
    { name: "Jorge Soler", value: "soler" },
    { name: "Bobby Witt Jr.", value: "witt" },
    { name: "Isiah Kiner-Falefa", value: "ikf" },
    { name: "Robbie Ray", value: "ray" },
    { name: "Rhys Hoskins", value: "hoskins" },
  ];

  it("matches full names exactly and abbreviations by initial + last name", () => {
    expect(matchPlayerName("Juan Soto (NYM - OF)", roster)).toEqual({ value: "soto", confidence: "exact" });
    expect(matchPlayerName("J.Soto", roster)).toEqual({ value: "soto", confidence: "initial" });
    expect(matchPlayerName("B. Witt Jr.", roster)).toEqual({ value: "witt", confidence: "initial" });
  });

  it("tolerates a typo in a longer last name", () => {
    expect(matchPlayerName("I.Kiner-Filefa", roster)).toEqual({ value: "ikf", confidence: "fuzzy" });
  });

  it("refuses to guess between two candidates or on short names", () => {
    const twoJs = [...roster, { name: "Jarred Soto", value: "other-soto" }];
    expect(matchPlayerName("J.Soto", twoJs)).toBeNull();
    expect(matchPlayerName("R.Rea", roster)).toBeNull();
    expect(matchPlayerName("Nobody Here", roster)).toBeNull();
  });
});
