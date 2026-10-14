import { describe, it, expect } from "vitest";
import { buildTeamMatcher, type MatchableTeam } from "./team-match";

// Production's current Team.name values - Yahoo's spellings since the first
// sync - next to the spellings older CSVs use.
const TEAMS: MatchableTeam[] = [
  { id: "t-andrew", name: "Killer B’s FC", yahooTeamId: "469.l.8891.t.5", managerName: "Andrew" },
  { id: "t-hugo", name: "JUICED BALLZ 🧃", yahooTeamId: "469.l.8891.t.7", managerName: "Hugo" },
  { id: "t-neel", name: "Big fat panda", yahooTeamId: "469.l.8891.t.12", managerName: "Neel" },
  { id: "t-ed", name: "Sho-ing off the Big Dumper", yahooTeamId: "469.l.8891.t.4", managerName: "Ed" },
  { id: "t-jorge", name: "Pitches Be Trippin’", yahooTeamId: "469.l.8891.t.9", managerName: "Jorge" },
  { id: "t-michael", name: "The Rhino Kings", yahooTeamId: "469.l.8891.t.11", managerName: "Michael" },
  { id: "t-scott", name: "Ranger Thingz", yahooTeamId: null, managerName: "Scott" },
];
const match = buildTeamMatcher(TEAMS);

describe("buildTeamMatcher", () => {
  it("keeps the original behavior: exact names, any case, surrounding whitespace", () => {
    expect(match("Ranger Thingz")).toEqual({ teamId: "t-scott" });
    expect(match("ranger thingz")).toEqual({ teamId: "t-scott" });
    expect(match("  RANGER THINGZ  ")).toEqual({ teamId: "t-scott" });
    expect(match("Killer B’s FC")).toEqual({ teamId: "t-andrew" });
  });

  it("matches the pre-Yahoo spellings of the five renamed teams", () => {
    expect(match("Killer B's FC")).toEqual({ teamId: "t-andrew" }); // straight vs curly apostrophe
    expect(match("JUICED BALLZ")).toEqual({ teamId: "t-hugo" }); // emoji added by Yahoo
    expect(match("Big Fat Panda")).toEqual({ teamId: "t-neel" }); // case
    expect(match("Sho-ing Off the Big Dumper")).toEqual({ teamId: "t-ed" }); // case
    expect(match("Pitches Be Trippin'")).toEqual({ teamId: "t-jorge" }); // apostrophe
  });

  it("tolerates punctuation, emoji and whitespace noise", () => {
    expect(match("Sho ing off the Big   Dumper")).toEqual({ teamId: "t-ed" });
    expect(match("Rhino Kings")).toEqual({ teamId: "t-michael" }); // leading "The"
    expect(match("🧃 juiced ballz!")).toEqual({ teamId: "t-hugo" });
    expect(match("Killer Bs FC")).toEqual({ teamId: "t-andrew" });
  });

  it("accepts stable identifiers: the Antlerboard team id and the Yahoo team key", () => {
    expect(match("t-neel")).toEqual({ teamId: "t-neel" });
    expect(match("469.l.8891.t.7")).toEqual({ teamId: "t-hugo" });
  });

  it("falls back to the manager's name only when no team name matches", () => {
    expect(match("Andrew")).toEqual({ teamId: "t-andrew" });
    expect(match("hugo")).toEqual({ teamId: "t-hugo" });
  });

  it("never guesses: near-misses are unknown", () => {
    expect(match("Ranger Things")).toEqual({ error: 'Unknown C&A team "Ranger Things"' });
    expect(match("Killer B")).toEqual({ error: 'Unknown C&A team "Killer B"' });
    expect(match("   ")).toEqual({ error: "Missing team name" });
  });

  it("reports ambiguity instead of picking when two teams normalize to the same name", () => {
    const m = buildTeamMatcher([
      { id: "a", name: "Killer B's FC", yahooTeamId: null, managerName: "Andrew" },
      { id: "b", name: "Killer Bs FC", yahooTeamId: null, managerName: "Zach" },
    ]);
    // Each exact spelling still resolves on its own...
    expect(m("Killer B's FC")).toEqual({ teamId: "a" });
    expect(m("Killer Bs FC")).toEqual({ teamId: "b" });
    // ...but a spelling that only matches after normalization is ambiguous.
    const result = m("Killer B’s FC");
    expect(result.teamId).toBeUndefined();
    expect("error" in result && result.error).toContain("is ambiguous");
    expect("error" in result && result.error).toContain('"Killer B\'s FC" (Andrew)');
    expect("error" in result && result.error).toContain('"Killer Bs FC" (Zach)');
  });

  it("reports ambiguity on duplicate exact names and on shared manager names", () => {
    const dupNames = buildTeamMatcher([
      { id: "a", name: "Dallas Eagles", yahooTeamId: null, managerName: "Aaron" },
      { id: "b", name: "dallas eagles", yahooTeamId: null, managerName: "Kurt" },
    ]);
    expect(dupNames("Dallas Eagles").teamId).toBeUndefined();
    expect(dupNames("a")).toEqual({ teamId: "a" }); // the id still resolves it

    const sharedManager = buildTeamMatcher([
      { id: "a", name: "Old Team", yahooTeamId: null, managerName: "Scott" },
      { id: "b", name: "New Team", yahooTeamId: null, managerName: "Scott" },
    ]);
    expect(sharedManager("Scott").teamId).toBeUndefined();
  });

  it("prefers a team-name match over a manager-name match", () => {
    const m = buildTeamMatcher([
      { id: "a", name: "Zach", yahooTeamId: null, managerName: "Aaron" },
      { id: "b", name: "Los Skeletos", yahooTeamId: null, managerName: "Zach" },
    ]);
    expect(m("Zach")).toEqual({ teamId: "a" });
  });
});
