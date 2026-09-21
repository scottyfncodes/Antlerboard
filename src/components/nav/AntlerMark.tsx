export function AntlerMark({ className }: { className?: string }) {
  // A minimal geometric antler mark - angular branching lines, not a cartoon deer.
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M9 30V16.5L4 10M9 20L4.5 15.5M9 16.5L13 11V4M13 11L17 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M23 30V16.5L28 10M23 20L27.5 15.5M23 16.5L19 11V4M19 11L15 6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
