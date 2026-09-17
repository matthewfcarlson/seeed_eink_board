/** Builds the admin claim-page URL for a device, using the incoming request's
 *  own origin — works for workers.dev, a custom domain, or local `wrangler dev`
 *  without any hardcoded config. When `secret` is given (an unregistered device's
 *  self-generated HMAC key, sent via X-Device-Secret), it's embedded so the claim
 *  page can bind it to the device on submit — see lib/device-signature.ts. This
 *  URL only ever reaches a human by being scanned off the device's own physical
 *  display, which is the out-of-band channel that keeps the secret from being
 *  learnable over the network. */
export function registrationUrl(requestUrl: string, mac: string, secret?: string | null): string {
  const origin = new URL(requestUrl).origin;
  const url = new URL(`${origin}/admin`);
  url.searchParams.set("claim", mac);
  if (secret) url.searchParams.set("secret", secret);
  return url.toString();
}

/** Builds the admin URL for assigning buckets to an already-registered device
 *  that currently has none — same "scan the device's own screen" out-of-band
 *  channel as registrationUrl above, but for a device past the claim step.
 *  `?assign_bucket=<mac>` is read by admin.ts to auto-open that device's
 *  bucket-assignment modal once devices/buckets have loaded. */
export function assignBucketUrl(requestUrl: string, mac: string): string {
  const origin = new URL(requestUrl).origin;
  const url = new URL(`${origin}/admin`);
  url.searchParams.set("assign_bucket", mac);
  return url.toString();
}
