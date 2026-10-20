/** Only same-site paths: "/x" yes; "//evil.example", "/\\evil.example" or "https://..." never. */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
