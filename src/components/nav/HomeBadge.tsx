"use client";

import Link from "next/link";
import clsx from "clsx";
import { AntlerboardMark } from "@/components/brand/AntlerboardMark";

/**
 * The mobile bottom-nav's Home control, reskinned around the Antlerboard
 * crest instead of a generic icon - see the redesign brief's "the home
 * button should feel like a piece of Antlerboard's identity." The chip
 * behind the mark reads as a small physical badge (soft raised shadow at
 * rest, a quick inset/scale-down on tap) rather than a flat icon button.
 */
export function HomeBadge({ active }: { active: boolean }) {
  return (
    <Link
      href="/"
      className="relative flex flex-col items-center justify-center gap-1 py-2 text-[10px] font-medium tracking-tight"
    >
      {active && <span className="absolute top-0 h-0.5 w-6 rounded-full bg-antler-strong" />}
      <span
        className={clsx(
          "flex h-9 w-9 items-center justify-center rounded-xl transition-transform duration-100 active:scale-90",
          active
            ? "bg-surface-raised ring-1 ring-antler-dim shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.45)] active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.55)]"
            : "bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.05)] active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.55)]"
        )}
      >
        <AntlerboardMark className="h-6 w-6" />
      </span>
      <span className={active ? "text-antler-strong" : "text-muted"}>Board</span>
    </Link>
  );
}
