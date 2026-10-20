/**
 * Small, pure helpers for reading and rewriting URL query params, so a
 * hand-typed or stale link (?season=abc) can't crash a server component.
 */

/** A whole, non-negative number from a route or query param; null for anything else. */
export function parseIntParam(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * `path?query` with `key` set to `value` (or removed when value is empty),
 * keeping every other param as it was.
 */
export function hrefWithParam(
  path: string,
  params: Record<string, string | undefined> | URLSearchParams,
  key: string,
  value: string | number | null | undefined
): string {
  const next = new URLSearchParams();
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  for (const [k, v] of entries) if (v !== undefined && k !== key) next.set(k, v);
  if (value !== null && value !== undefined && value !== "") next.set(key, String(value));
  const qs = next.toString();
  return qs ? `${path}?${qs}` : path;
}

/** `path?query` keeping only the listed params (e.g. the season when clearing filters). */
export function hrefKeepingParams(path: string, params: URLSearchParams, keep: string[]): string {
  const next = new URLSearchParams();
  for (const k of keep) {
    const v = params.get(k);
    if (v) next.set(k, v);
  }
  const qs = next.toString();
  return qs ? `${path}?${qs}` : path;
}
