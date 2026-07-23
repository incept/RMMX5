import { getSetting } from '@/lib/settings';

/**
 * Voicemail drop (ringless voicemail) — provider-agnostic.
 *
 * There's no single standard API for ringless voicemail, so the admin
 * configures any provider that accepts a JSON POST (Drop Cowboy, Slybroadcast
 * relay, VoiceDrop, or an internal bridge) under Admin → Integrations:
 *   voicemail: { provider_url, api_key, caller_id }
 *
 * We POST { phone, audio_url, caller_id } with a Bearer key and treat any
 * 2xx as accepted. The audio file itself is served from Supabase Storage
 * via a signed URL that stays valid long enough for the provider to fetch it.
 */
export async function sendVoicemailDrop(opts: {
  phone: string;
  audioUrl: string;
}): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getSetting<{ provider_url?: string; api_key?: string; caller_id?: string }>('voicemail');
  if (!cfg.provider_url) {
    return { ok: false, error: 'Voicemail provider is not configured (Admin → Integrations).' };
  }

  const res = await fetch(cfg.provider_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.api_key ? { Authorization: `Bearer ${cfg.api_key}` } : {}),
    },
    body: JSON.stringify({
      phone: opts.phone,
      audio_url: opts.audioUrl,
      caller_id: cfg.caller_id ?? '',
    }),
  });

  if (!res.ok) {
    return { ok: false, error: `Voicemail provider error: ${res.status} ${await res.text()}` };
  }
  return { ok: true };
}
