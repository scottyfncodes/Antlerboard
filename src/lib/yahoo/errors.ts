/**
 * Lives in its own module (not client.ts) so tests that vi.mock the client
 * can still import the real class for instanceof checks.
 */
export class YahooApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly description: string | null
  ) {
    super(`Yahoo API request failed (${status}): ${path}${description ? ` - ${description}` : ""}`);
    this.name = "YahooApiError";
  }

  /**
   * Since 2026-07-22 Yahoo returns this for every Fantasy API call made by an
   * app whose Client ID hasn't been confirmed through the Yahoo Sports
   * developer program, even though OAuth login itself keeps working.
   */
  get isAppNotAuthorized(): boolean {
    return this.status === 403 && /not authorized to perform this action/i.test(this.description ?? "");
  }
}

/**
 * Pulls the human-readable reason out of a Yahoo error body, which is usually
 * `{"error": {"description": "..."}}` but is occasionally XML or an HTML page.
 */
export function parseYahooErrorDescription(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { description?: unknown } };
    if (typeof parsed?.error?.description === "string") return parsed.error.description;
  } catch {
    // not JSON - fall through
  }
  const xml = body.match(/<description>([^<]*)<\/description>/i);
  if (xml) return xml[1].trim();
  return body.slice(0, 300).trim() || null;
}
