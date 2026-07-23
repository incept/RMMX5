import { getSetting } from '@/lib/settings';

/**
 * Sends an SMS via the TextLink API.
 * Docs: https://docs.textlinksms.com/api
 *
 * IMPORTANT: TextLink routes messages through a physical Android device
 * (running the TextLink app) tied to a SIM card, rather than a traditional
 * cloud carrier connection. That device must be online and paired in the
 * TextLink dashboard for sends to succeed. The optional `sim_card_id` in
 * settings pins sends to a specific device/SIM.
 */
export async function sendSms(
  phoneNumber: string,
  text: string
): Promise<{ ok: boolean; error?: string; queued?: boolean }> {
  const cfg = await getSetting<{ api_key?: string; sim_card_id?: string }>('textlink');
  if (!cfg.api_key) return { ok: false, error: 'TextLink is not configured (Admin → Integrations).' };

  const res = await fetch('https://textlinksms.com/api/send-sms', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      text,
      ...(cfg.sim_card_id ? { sim_card_id: cfg.sim_card_id } : {}),
    }),
  });

  if (!res.ok) {
    return { ok: false, error: `TextLink HTTP error: ${res.status} ${await res.text()}` };
  }

  const data = await res.json();
  if (!data.ok) {
    return { ok: false, error: data.message || 'TextLink reported failure' };
  }
  return { ok: true, queued: !!data.queued };
}
