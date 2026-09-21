/**
 * Yahoo's Fantasy Sports JSON responses represent lists as objects with
 * numeric string keys plus a "count" key (an artifact of their XML->JSON
 * conversion), and represent each resource's fields as an array of
 * single-key objects rather than one flat object. These helpers normalize
 * both shapes so the rest of the sync code can work with plain
 * arrays/objects.
 */

/** Loose shape of every Yahoo Fantasy API JSON response. */
export interface YahooResponse {
  fantasy_content?: Record<string, unknown>;
}

export function fantasyContent(data: unknown): Record<string, unknown> {
  return (data as YahooResponse)?.fantasy_content ?? {};
}

export function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "count")
      .map(([, v]) => v);
  }
  return [];
}

/** Merges an array of single-key (or already-flat) objects into one object. */
export function mergeMeta(value: unknown): Record<string, unknown> {
  const arr = toArray(value);
  const out: Record<string, unknown> = {};
  for (const item of arr) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      Object.assign(out, item);
    } else if (Array.isArray(item)) {
      Object.assign(out, mergeMeta(item));
    }
  }
  return out;
}
