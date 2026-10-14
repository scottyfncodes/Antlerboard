import { Badge } from "@/components/ui/Badge";
import { COMPLETENESS_LABEL, type Completeness } from "@/lib/draft-history";

const VARIANT: Record<Completeness["status"], "green" | "yellow" | "blue" | "default"> = {
  complete: "green",
  incomplete: "yellow",
  unverified: "blue",
  none: "default",
};

/** "Complete" / "Incomplete" / "Total unverified" / "No data" - computed from stored picks, never a status column. */
export function CompletenessBadge({ completeness }: { completeness: Completeness }) {
  return <Badge variant={VARIANT[completeness.status]}>{COMPLETENESS_LABEL[completeness.status]}</Badge>;
}

/** "53/60", "212 picks", or "0" - the short count shown next to a draft's name. */
export function completenessCount(c: Completeness): string {
  if (c.status === "none") return "0";
  if (c.expected !== null) return `${c.recorded}/${c.expected}`;
  return `${c.recorded} picks`;
}
