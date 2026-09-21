import { describe, it, expect } from "vitest";
import { fantasyContent, toArray, mergeMeta } from "./parse";

describe("fantasyContent", () => {
  it("unwraps the fantasy_content envelope", () => {
    const data = { fantasy_content: { league: [{ league_key: "422.l.1" }] } };
    expect(fantasyContent(data)).toEqual({ league: [{ league_key: "422.l.1" }] });
  });

  it("returns an empty object for a malformed response", () => {
    expect(fantasyContent(null)).toEqual({});
    expect(fantasyContent(undefined)).toEqual({});
    expect(fantasyContent({})).toEqual({});
    expect(fantasyContent("not json")).toEqual({});
  });
});

describe("toArray", () => {
  it("passes real arrays through unchanged", () => {
    expect(toArray([{ a: 1 }, { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("converts Yahoo's numeric-keyed-object-plus-count list shape into an array", () => {
    // Yahoo's XML->JSON conversion represents every list this way instead of
    // a plain JSON array.
    const yahooList = {
      "0": { team: [{ team_key: "422.l.1.t.1" }] },
      "1": { team: [{ team_key: "422.l.1.t.2" }] },
      count: 2,
    };
    const result = toArray(yahooList);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ team: [{ team_key: "422.l.1.t.1" }] });
  });

  it("returns an empty array for primitives and nullish values", () => {
    expect(toArray(undefined)).toEqual([]);
    expect(toArray(null)).toEqual([]);
    expect(toArray("x")).toEqual([]);
    expect(toArray(42)).toEqual([]);
  });
});

describe("mergeMeta", () => {
  it("merges an array of single-key field objects into one flat object", () => {
    // Yahoo represents a resource's fields as an array of single-key
    // objects rather than one flat object.
    const meta = [
      { team_key: "422.l.1.t.1" },
      { team_id: "1" },
      { name: "The Antlers" },
    ];
    expect(mergeMeta(meta)).toEqual({
      team_key: "422.l.1.t.1",
      team_id: "1",
      name: "The Antlers",
    });
  });

  it("recurses into nested arrays", () => {
    const meta = [{ team_key: "422.l.1.t.1" }, [{ name: "The Antlers" }, { url: "http://example.com" }]];
    expect(mergeMeta(meta)).toEqual({
      team_key: "422.l.1.t.1",
      name: "The Antlers",
      url: "http://example.com",
    });
  });

  it("does NOT extract fields from an already-flat multi-key object - it is only for merging arrays of single-key field objects", () => {
    // This is a real, documented limitation (see src/lib/yahoo/sync.ts's
    // handling of the player `name` sub-resource, which Yahoo returns as an
    // already-flat object): toArray() on a plain object discards its keys
    // and returns just the values, so mergeMeta has nothing object-shaped
    // left to merge. Callers must read a known-flat object's fields
    // directly instead of routing it through mergeMeta.
    expect(mergeMeta({ rank: "1", wins: "10" })).toEqual({});
  });

  it("returns an empty object for nullish input", () => {
    expect(mergeMeta(undefined)).toEqual({});
    expect(mergeMeta(null)).toEqual({});
  });
});
