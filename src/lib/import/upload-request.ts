/**
 * Upload guards for the commissioner import wizards.
 *
 * Vercel rejects a request body over 4.5 MB before it reaches the route, and
 * answers with a plain-text 413 rather than JSON. The wizard used to call
 * res.json() on that, which threw and left the button on "Building
 * preview…" forever. These helpers catch an oversized upload before it is
 * sent, and turn any non-JSON or failed response into a readable error.
 */

/** Vercel's request body limit (4.5 MB), less headroom for multipart framing. */
export const MAX_UPLOAD_BYTES = 4_400_000;

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export const TOO_LARGE_HINT =
  "Use the compressed .csv.gz Yahoo transaction file (about 0.3 MB) instead of the uncompressed .csv.";

/** An error message when the files together are too big to upload, else null. */
export function uploadSizeError(files: { size: number }[], hint = TOO_LARGE_HINT): string | null {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= MAX_UPLOAD_BYTES) return null;
  return `${files.length === 1 ? "This upload is" : "These files add up to"} ${mb(total)}, over the ${mb(MAX_UPLOAD_BYTES)} upload limit. ${hint}`;
}

export type JsonResult<T> = { ok: true; data: T } | { ok: false; error: string; data?: Record<string, unknown> };

/**
 * Reads a route's response without ever throwing. Errors carry the route's
 * own `error` message when it sent JSON, and a readable fallback otherwise.
 */
export async function readJsonResponse<T>(res: Response, fallback: string, tooLargeHint = TOO_LARGE_HINT): Promise<JsonResult<T>> {
  if (res.status === 413) {
    return { ok: false, error: `The upload is too large for the server. ${tooLargeHint}` };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: `${fallback} The server answered ${res.status} without details - try again.` };
  }
  if (!res.ok) {
    const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    return { ok: false, error: typeof body.error === "string" ? body.error : fallback, data: body };
  }
  return { ok: true, data: data as T };
}
