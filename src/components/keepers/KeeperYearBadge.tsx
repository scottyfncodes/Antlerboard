import { Badge } from "@/components/ui/Badge";
import { MAX_CONSECUTIVE_KEEPER_YEARS } from "@/lib/config";

export function KeeperYearBadge({ keeperYear, status }: { keeperYear: number; status?: string }) {
  if (keeperYear === 0) {
    return <Badge variant="default">Acquired this season</Badge>;
  }
  if (status === "FORCED_BACK" || keeperYear > MAX_CONSECUTIVE_KEEPER_YEARS) {
    return <Badge variant="red">FORCED BACK</Badge>;
  }
  if (keeperYear === MAX_CONSECUTIVE_KEEPER_YEARS) {
    return (
      <Badge variant="red">
        Keeper Year {keeperYear}/{MAX_CONSECUTIVE_KEEPER_YEARS}
      </Badge>
    );
  }
  if (keeperYear === MAX_CONSECUTIVE_KEEPER_YEARS - 1) {
    return (
      <Badge variant="yellow">
        Keeper Year {keeperYear}/{MAX_CONSECUTIVE_KEEPER_YEARS}
      </Badge>
    );
  }
  return (
    <Badge variant="default">
      Keeper Year {keeperYear}/{MAX_CONSECUTIVE_KEEPER_YEARS}
    </Badge>
  );
}
