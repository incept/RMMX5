import crypto from 'crypto';

const MAX_SIGNATURE_AGE_SECONDS = 300;

function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Verifies a secret sent in a header, never in a logged query string. */
export function verifyBearerSecret(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const authorization = request.headers.get('authorization') ?? '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const presented = bearer ?? request.headers.get('x-rmmx-webhook-secret');
  return !!presented && constantTimeEqual(presented, expected);
}

/**
 * Emailit signs `${timestamp}.${rawBody}` with HMAC-SHA256. The raw body must
 * be used verbatim and the timestamp is bounded to prevent delayed replays.
 */
export function verifyEmailitWebhook(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (!secret || !signature || !timestamp || !/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }

  const signedAt = Number(timestamp);
  if (!Number.isInteger(signedAt) || Math.abs(nowSeconds - signedAt) > MAX_SIGNATURE_AGE_SECONDS) {
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return constantTimeEqual(expected, signature.toLowerCase());
}
