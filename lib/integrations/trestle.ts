import { getSetting } from '@/lib/settings';
import { logDebug, errorMessage } from '@/lib/debug-log';
import { finishUsage, reserveUsage } from '@/lib/usage';
import { parsePhoneIdentity, toE164, type PhoneIdentity } from './trestle-parse.ts';

export { parsePhoneIdentity, toE164, type PhoneIdentity };

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
  if (!cfg.api_key) return null;

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
    const url =
      'https://api.trestleiq.com/3.0/phone?phone=' +
      encodeURIComponent(e164) +
      '&country_hint=US';
    const res = await fetch(url, {
      headers: { 'x-api-key': cfg.api_key },
      signal: AbortSignal.timeout(15_000),
    });
    const bodyText = await res.text();

    if (!res.ok) {
      await finishUsage(usage.id, 'failed', `HTTP ${res.status}`);
      await logDebug({
        level: 'warn',
        source: 'trestle',
        message: `Reverse phone lookup failed: HTTP ${res.status}`,
        context: { response: bodyText.slice(0, 300) },
        contactId: opts?.contactId ?? null,
      });
      return null;
    }

    let data: any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      await finishUsage(usage.id, 'failed', 'Non-JSON response');
      await logDebug({
        level: 'warn',
        source: 'trestle',
        message: 'Reverse phone returned a non-JSON body',
        context: { response: bodyText.slice(0, 300) },
        contactId: opts?.contactId ?? null,
      });
      return null;
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
    return null;
  }
}
