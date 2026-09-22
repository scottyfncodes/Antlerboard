/**
 * The Antlerboard crest: a baseball crowned by a pair of antlers, read
 * together as a compact badge (and, in silhouette, a nod to the letter A).
 * One geometry serves every context - nav, favicon, app icon, login screen
 * - so the mark stays consistent; only `detailed` (stitch ticks on the
 * seams) is optional, since that texture disappears at small sizes anyway
 * and isn't worth the visual noise below ~40px.
 *
 * This is the app's only mark - it always renders in its own brand colors
 * (never currentColor). Antlerboard is dark-theme-only, and the cream
 * ball/gold antlers read clearly against every surface tone in the
 * palette, so there's no separate "mono" variant to keep in sync.
 *
 * The depth here is deliberately restrained and shape-based (a soft radial
 * gradient on the ball, a duotone stroke on each antler - a dim base pass
 * under a slim bright highlight pass) rather than filter/shadow-based, so
 * it survives being rasterized to a static PNG/ICO for the favicon and app
 * icon without losing anything.
 */
export function AntlerboardMark({
  className,
  detailed = false,
}: {
  className?: string;
  detailed?: boolean;
}) {
  return (
    <svg viewBox="0 0 128 128" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <radialGradient id="ab-ball" cx="38%" cy="32%" r="80%">
          <stop offset="0%" stopColor="#f7f0e3" />
          <stop offset="100%" stopColor="#ddccaa" />
        </radialGradient>
      </defs>

      {/* Antlers - dim base stroke first, slim bright highlight on top */}
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M52 50V30L38 14M52 40L41 30" stroke="#6b5730" strokeWidth="7" />
        <path d="M76 50V30L90 14M76 40L87 30" stroke="#6b5730" strokeWidth="7" />
        <path d="M52 50V30L38 14M52 40L41 30" stroke="#e6bd6e" strokeWidth="2.75" />
        <path d="M76 50V30L90 14M76 40L87 30" stroke="#e6bd6e" strokeWidth="2.75" />
      </g>

      {/* The ball */}
      <circle cx="64" cy="70" r="30" fill="url(#ab-ball)" stroke="#6b5730" strokeWidth="2.5" />

      {/* Seams */}
      <g fill="none" stroke="#c1523c" strokeWidth="3.25" strokeLinecap="round">
        <path d="M40 56Q64 70 40 90" />
        <path d="M88 56Q64 70 88 90" />
      </g>

      {detailed && (
        <g stroke="#c1523c" strokeWidth="2" strokeLinecap="round">
          <path d="M45 59.5 47 61.5" />
          <path d="M50 65.5 52.5 67" />
          <path d="M52.5 70 55 70" />
          <path d="M50 74.5 52.5 73" />
          <path d="M45 80.5 47 78.5" />
          <path d="M83 59.5 81 61.5" />
          <path d="M78 65.5 75.5 67" />
          <path d="M75.5 70 73 70" />
          <path d="M78 74.5 75.5 73" />
          <path d="M83 80.5 81 78.5" />
        </g>
      )}
    </svg>
  );
}
