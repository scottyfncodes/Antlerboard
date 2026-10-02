import { describe, expect, it } from "vitest";
import { PRIMARY_NAV_ITEMS, isNavItemActive } from "./nav-items";

const item = (href: string) => PRIMARY_NAV_ITEMS.find((i) => i.href === href)!;

describe("isNavItemActive", () => {
  it("only lights Board on the exact root", () => {
    expect(isNavItemActive(item("/"), "/")).toBe(true);
    expect(isNavItemActive(item("/"), "/players")).toBe(false);
  });

  it("lights League for every League hub tab, including nested routes", () => {
    for (const path of ["/league", "/league/transactions", "/teams", "/teams/abc", "/keepers", "/history", "/history/draft/2024"]) {
      expect(isNavItemActive(item("/league"), path)).toBe(true);
    }
    expect(isNavItemActive(item("/league"), "/trades")).toBe(false);
  });

  it("matches whole path segments, not raw prefixes", () => {
    expect(isNavItemActive(item("/players"), "/players/123")).toBe(true);
    expect(isNavItemActive(item("/players"), "/playersfoo")).toBe(false);
  });
});
