/**
 * Client-side fetch wrapper for our own JSON API routes. Never throws:
 * a non-2xx response yields the server's `error` message (or a generic
 * fallback), and a network failure yields the fallback, so callers can
 * always show something inline instead of failing silently.
 */

export const GENERIC_API_ERROR = "Something went wrong, try again.";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function callApi<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
  fallback = GENERIC_API_ERROR
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, error: fallback };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data && typeof data.error === "string" && data.error ? data.error : fallback;
    return { ok: false, error: message };
  }
  return { ok: true, data: data as T };
}

/** callApi() for a POST/PATCH with a JSON body. */
export function sendJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  method: "POST" | "PATCH" = "POST",
  fallback?: string
): Promise<ApiResult<T>> {
  return callApi<T>(
    url,
    { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    fallback
  );
}
