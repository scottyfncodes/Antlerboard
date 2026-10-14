/**
 * Vercel Cron authenticates with "Authorization: Bearer $CRON_SECRET"
 * (Vercel adds the header itself when the project has a CRON_SECRET env
 * var). Fails closed: with no secret configured, nothing is authorized -
 * a missing env var must never turn a cron route into a public endpoint.
 */
export function isAuthorizedCronRequest(req: { headers: { get(name: string): string | null } }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}
