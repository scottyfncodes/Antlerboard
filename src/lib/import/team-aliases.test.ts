import { describe, it, expect } from "vitest";
import { FranchiseResolver, normalizeTeamName } from "./team-aliases";

const records = [
  { managerSheetName: "Scott", seasonYear: 2021, teamName: "Ranger Thingz" },
  { managerSheetName: "Aaron", seasonYear: 2021, teamName: "Bluth Co. Softball" },
  { managerSheetName: "Aaron", seasonYear: 2023, teamName: "Dallas Eagles" },
  { managerSheetName: "MattyJ", seasonYear: 2023, teamName: "Cron & Cronenworth LLP" },
  { managerSheetName: "Jorge", seasonYear: 2023, teamName: "Pitches Be Trippin'" },
  { managerSheetName: "Tyler", seasonYear: 2023, teamName: "Pfaadt Tatis" },
  { managerSheetName: "Michael", seasonYear: 2022, teamName: "Scott's Chubby Little Brother" },
  { managerSheetName: "Kurt", seasonYear: 2021, teamName: "Wrigleyville Whales" },
];
const managers = ["Aaron", "Andrew", "Ed", "Hugo", "Jorge", "Kurt", "MattyJ", "Michael", "Neel", "Scott", "Tyler", "Zach"];
const resolver = new FranchiseResolver(records, managers);

describe("normalizeTeamName", () => {
  it("ignores case, curly quotes, emoji, accents, a trailing 'Team' and a leading 'The'", () => {
    expect(normalizeTeamName("Scott’s CHUBBY little BROTHER")).toBe(normalizeTeamName("Scott's Chubby Little Brother"));
    expect(normalizeTeamName("JUICED BALLZ 🧃")).toBe("juiced ballz");
    expect(normalizeTeamName("Los Dildõs")).toBe("los dildos");
    expect(normalizeTeamName("Bluth Co. Softball Team")).toBe("bluth co softball");
    expect(normalizeTeamName("The Pfaadt Tatis")).toBe("pfaadt tatis");
  });
});

describe("FranchiseResolver", () => {
  it("resolves any team name a franchise has used, in any season", () => {
    expect(resolver.resolve("Bluth Co. Softball Team")).toEqual({ managerSheetName: "Aaron", confidence: "exact" });
    expect(resolver.resolve("Dallas Eagles")).toEqual({ managerSheetName: "Aaron", confidence: "exact" });
  });

  it("resolves manager first names, known predecessors, and hub-style '(Ed)' annotations", () => {
    expect(resolver.resolve("Matty J")).toEqual({ managerSheetName: "MattyJ", confidence: "manager" });
    expect(resolver.resolve("Drew")).toEqual({ managerSheetName: "Michael", confidence: "manager" });
    expect(resolver.resolve("Holman")).toEqual({ managerSheetName: "Neel", confidence: "manager" });
    expect(resolver.resolve("Seattle Pilots (Ed)")).toEqual({ managerSheetName: "Ed", confidence: "manager" });
  });

  it("resolves Yahoo's truncated draft-result names by unique prefix", () => {
    expect(resolver.resolve("Cron & Cronenwort...")).toEqual({ managerSheetName: "MattyJ", confidence: "alias" });
    expect(resolver.resolve("Scott’s CHUBBY ...")).toEqual({ managerSheetName: "Michael", confidence: "alias" });
    expect(resolver.resolve("Pitches Be Trippi...")).toEqual({ managerSheetName: "Jorge", confidence: "alias" });
  });

  it("tolerates one-letter misspellings and known renames the workbook never recorded", () => {
    expect(resolver.resolve("Ranger Things")).toEqual({ managerSheetName: "Scott", confidence: "fuzzy" });
    expect(resolver.resolve("Wrigleyville Whalers")).toEqual({ managerSheetName: "Kurt", confidence: "alias" });
    expect(resolver.resolve("Acuña Matata")).toEqual({ managerSheetName: "Tyler", confidence: "alias" });
  });

  it("returns null rather than guessing for unknown or ambiguous names", () => {
    expect(resolver.resolve("Kangaroo Ct Rangers")).toBeNull();
    expect(resolver.resolve("")).toBeNull();
    expect(resolver.resolve(null)).toBeNull();
    const ambiguous = new FranchiseResolver(
      [
        { managerSheetName: "A", seasonYear: 2021, teamName: "Same Name" },
        { managerSheetName: "B", seasonYear: 2022, teamName: "Same Name" },
      ],
      ["A", "B"]
    );
    expect(ambiguous.resolve("Same Name")).toBeNull();
  });
});
