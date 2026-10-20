import { PageHeader } from "@/components/ui/PageHeader";
import { SearchBox } from "@/components/search/SearchBox";

export default function SearchPage() {
  return (
    <div className="space-y-4">
      <PageHeader title="Search" subtitle="Players, teams, managers, trades, and prop bets." />
      <SearchBox autoFocus />
    </div>
  );
}
