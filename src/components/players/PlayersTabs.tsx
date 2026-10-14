import { SubTabs } from "@/components/ui/SubTabs";

/** Players hub tabs - the keeper market and the cost history. */
export function PlayersTabs({ active }: { active: "market" | "costs" }) {
  return (
    <SubTabs
      tabs={[
        { href: "/players", label: "Market", active: active === "market" },
        { href: "/players/costs", label: "Costs", active: active === "costs" },
      ]}
    />
  );
}
