import { AntlerboardMark } from "./AntlerboardMark";

/**
 * The full brand lockup: mark + wordmark + league subtitle. Reserved for
 * the one place a first impression actually matters - the login screen.
 * Everywhere else in the app (nav, tabs) is dense, functional UI where a
 * compact mark plus a plain-weight "Antlerboard" wordmark already does the
 * job without competing for space - this bigger, more ceremonial lockup
 * would be too heavy repeated on every page.
 *
 * "Claw & Antler League" stays visually subordinate (smaller, lighter,
 * letter-spaced, muted) - it's the league's name, not the product's.
 */
export function AntlerboardLogotype({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="flex items-center gap-4">
        <AntlerboardMark detailed className="h-16 w-16 shrink-0 drop-shadow-[0_2px_4px_rgba(0,0,0,0.35)]" />
        <div className="flex flex-col">
          <span className="font-display text-3xl font-bold tracking-tight text-foreground leading-none">
            Antlerboard
          </span>
          <span className="mt-1.5 text-[11px] font-medium uppercase tracking-[0.2em] text-antler">
            Claw &amp; Antler League
          </span>
        </div>
      </div>
    </div>
  );
}
