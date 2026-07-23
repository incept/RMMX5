import crypto from 'crypto';

/**
 * Small signing/comparison helpers.
 *
 * Tracking links embed an HMAC (keyed by CRON_SECRET) so /api/track/click
 * only redirects to URLs this app actually put into an email — without it
 * the endpoint would be an open redirect anyone could aim at a phishing
 * site (…/api/track/click?u=https://evil.example).
 */

const secret = () => process.env.CRON_SECRET ?? '';

export function signTrackingUrl(messageId: string, url: string): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`${messageId}|${url}`)
    .digest('hex')
    .slice(0, 32);
}

export function verifyTrackingUrl(messageId: string, url: string, sig: string | null): boolean {
  if (!secret() || !sig) return false;
  return safeEqual(signTrackingUrl(messageId, url), sig);
}

/** Constant-time string comparison (hash first so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
