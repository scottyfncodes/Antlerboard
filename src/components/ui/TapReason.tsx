import clsx from "clsx";

/**
 * A short value ("Unavailable", "None", "$12*") whose reason opens on tap -
 * phones have no hover, so a title= tooltip alone is never seen there. The
 * Player Costs page spells the reason out under the value; dense rows and
 * table cells use this to keep the reason one tap away instead. No JS: a
 * native <details>. Without a reason it's just the text.
 */
export function TapReason({ reason, className, children }: { reason: string | undefined; className?: string; children: React.ReactNode }) {
  if (!reason) return <span className={className}>{children}</span>;
  return (
    <details className="inline-block align-top">
      <summary
        title={reason}
        className={clsx(
          "cursor-pointer list-none underline decoration-dotted underline-offset-2 [&::-webkit-details-marker]:hidden",
          className
        )}
      >
        {children}
      </summary>
      <span className="block max-w-[14rem] whitespace-normal text-left text-[11px] font-normal leading-snug text-muted">{reason}</span>
    </details>
  );
}
