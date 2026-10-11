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

  /** Yahoo's rate limit answer is a 999 ("Request denied"); 429 and 5xx are worth one more try too. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 999 || this.status >= 500;
  }
}

/**
 * Yahoo refused the stored refresh token (revoked from the Yahoo account
 * page, expired, or issued to a different Client ID). Nothing retries past
 * this - the commissioner has to Disconnect and Connect Yahoo again.
 */
export class YahooAuthError extends Error {
  constructor(
    readonly status: number,
    readonly description: string | null
  ) {
    super(
      `Yahoo authorization expired or was revoked (${status}${description ? `: ${description}` : ""}). ` +
        "Disconnect and Connect Yahoo again on Commissioner > Yahoo."
    );
    this.name = "YahooAuthError";
  }
}

/**
 * Pulls the human-readable reason out of a Yahoo error body, which is usually
 * `{"error": {"description": "..."}}` (or the OAuth endpoint's
 * `{"error": "...", "error_description": "..."}`) but is occasionally XML or
 * an HTML page.
 */
export function parseYahooErrorDescription(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    const error = parsed?.error as { description?: unknown } | string | undefined;
    if (error && typeof error === "object" && typeof error.description === "string") return error.description;
    // OAuth token endpoint errors: {"error": "invalid_grant", "error_description": "..."}
    if (typeof error === "string") {
      return typeof parsed.error_description === "string" ? `${error}: ${parsed.error_description}` : error;
    }
  } catch {
    // not JSON - fall through
  }
  const xml = body.match(/<description>([^<]*)<\/description>/i);
  if (xml) return xml[1].trim();
  return body.slice(0, 300).trim() || null;
}
