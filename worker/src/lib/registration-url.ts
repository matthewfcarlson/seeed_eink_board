/** Builds the admin claim-page URL for a device, using the incoming request's
 *  own origin — works for workers.dev, a custom domain, or local `wrangler dev`
 *  without any hardcoded config. */
export function registrationUrl(requestUrl: string, mac: string): string {
  const origin = new URL(requestUrl).origin;
  return `${origin}/admin?claim=${mac}`;
}
