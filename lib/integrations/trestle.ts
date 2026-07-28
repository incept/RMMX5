import { getSetting } from '@/lib/settings';
import { logDebug, errorMessage } from '@/lib/debug-log';
import { finishUsage, reserveUsage } from '@/lib/usage';
import { readResponseText } from '@/lib/request-limits';
import { parsePhoneIdentity, toE164, type PhoneIdentity } from './trestle-parse.ts';

export { parsePhoneIdentity, toE164, type PhoneIdentity };

export class TrestleLookupError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'TrestleLookupError';
  }
}

/**
 * Trestle Reverse Phone (https://trestleiq.com) — turns a caller's number into
 * a name and a current city/state.
 *
 * Why this matters here specifically: a CallScaler lead arrives as a phone
 * number and nothing else. Deep search refuses to run without a location, and
 * the auto search is useless without a real name — so a call-in lead that never
 * volunteered either is stuck until somebody works it by hand. One lookup
 * unblocks both.
 *
 * Never called from a webhook request. CallScaler retries a slow delivery, and a
 * retried webhook is how one submission became several contacts before; this
 * runs on the queue instead.
 */

/**
 * Looks up a phone number. Returns null when the tier is unconfigured, the
 * number is unusable, or the provider has nothing — all normal outcomes that
 * must not fail the job that asked.
 */
export async function lookupPhoneIdentity(
  phone: string | null | undefined,
  opts?: { contactId?: string | null }
): Promise<PhoneIdentity | null> {
  const cfg = await getSetting<{
    api_key?: string;
    monthly_limit?: number | string;
  }>('trestle');
  // Trimmed defensively: per Trestle's own docs, an invisible character pasted
  // into the key (leading/trailing space) is a common cause of HTTP 403.
  const apiKey = cfg.api_key?.trim();
  if (!apiKey) return null;

  const e164 = toE164(phone ?? '');
  if (!e164) return null;

  const configuredLimit = Number(cfg.monthly_limit);
  const usage = await reserveUsage({
    provider: 'trestle',
    operation: 'reverse_phone',
    monthlyLimit:
      Number.isInteger(configuredLimit) && configuredLimit > 0 && configuredLimit <= 2_147_483_647
        ? configuredLimit
        : null,
    metadata: { contact_id: opts?.contactId ?? null },
  });

  try {
    // 3.2 is the currently documented Reverse Phone version; a key provisioned
    // today may not be enabled for the retired 3.0 path.
    const url =
      'https://api.trestleiq.com/3.2/phone?phone=' +
      encodeURIComponent(e164) +
      '&country_hint=US';
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    const bodyText = await readResponseText(res, 256 * 1024);

    if (!res.ok) {
      if (res.status === 404) {
        await finishUsage(usage.id, 'failed', 'HTTP 404');
        await logDebug({
          level: 'info',
          source: 'trestle',
          message: 'Reverse phone lookup returned no record',
          contactId: opts?.contactId ?? null,
        });
        return null;
      }
      // 403 has three documented causes, none retryable and none visible from
      // the bare status: a wrong/deactivated key, stray whitespace pasted into
      // it, or a key not scoped to the Reverse Phone product (Trestle keys are
      // per-product). Say so, and pass Trestle's own message through.
      const detail = bodyText ? ` — ${bodyText.slice(0, 200)}` : '';
      throw new TrestleLookupError(
        res.status === 403
          ? `Trestle HTTP 403${detail}. Check in the Trestle dashboard that this key is enabled for the Reverse Phone API specifically (keys are scoped per product), and re-paste it without stray spaces.`
          : `Trestle HTTP ${res.status}${detail}`,
        res.status === 429 || res.status >= 500
      );
    }

    let data: any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new TrestleLookupError('Trestle returned invalid JSON', true);
    }

    const identity = parsePhoneIdentity(data);
    await finishUsage(usage.id, 'succeeded');

    // A 200 that yields nothing usable is worth recording: it is the difference
    // between "the provider has no record" and "we are reading the wrong
    // fields", and only the top-level keys can tell those apart later.
    if (!identity.name && !identity.city) {
      await logDebug({
        level: 'info',
        source: 'trestle',
        message: 'Reverse phone returned no name or address',
        context: { top_level_keys: Object.keys(data ?? {}), line_type: identity.lineType },
        contactId: opts?.contactId ?? null,
      });
    }
    return identity;
  } catch (e) {
    await finishUsage(usage.id, 'failed', errorMessage(e));
    await logDebug({
      level: 'warn',
      source: 'trestle',
      message: `Reverse phone lookup error: ${errorMessage(e)}`,
      contactId: opts?.contactId ?? null,
    });
    if (e instanceof TrestleLookupError) throw e;
    throw new TrestleLookupError(errorMessage(e), true);
  }
}
