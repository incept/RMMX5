import { createAdminClient } from '@/lib/supabase/server';
import { logActivity } from '@/lib/activity';
import { logDebug } from '@/lib/debug-log';
import { lookupPhoneIdentity } from '@/lib/integrations/trestle';

/**
 * Contact enrichment from a phone number.
 *
 * Built for CallScaler leads, which arrive as a number and nothing else: no
 * name worth searching and no location, which is precisely what the deep-search
 * location gate refuses to run without.
 *
 * The one rule everything here follows: ENRICHMENT ONLY FILLS BLANKS. A value a
 * human typed, or that a person gave on a form, always wins over a data
 * provider's guess — the same precedence the search itself now uses for
 * confirmed facts. The single exception is the placeholder name CallScaler
 * writes for an unidentified caller, which is not information and exists purely
 * to give the row a label.
 */

/** The label written when a call has no usable caller name. Not real data. */
function isPlaceholderName(name: string | null | undefined): boolean {
  return !name?.trim() || /^caller\b/i.test(name.trim());
}

export interface EnrichmentResult {
  ok: boolean;
  filled: string[];
  reason?: string;
}

export async function enrichContactFromPhone(
  contactId: string,
  opts?: { actorId?: string | null }
): Promise<EnrichmentResult> {
  const supabase = createAdminClient();
  const { data: contact, error } = await supabase
    .from('contacts')
    .select('id, name, phone, city, state')
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!contact) return { ok: false, filled: [], reason: 'Contact not found' };
  if (!contact.phone) return { ok: false, filled: [], reason: 'Contact has no phone number' };

  // Nothing to gain: a real name and a location are already known. Checked
  // before the request so a re-run costs nothing.
  const needsName = isPlaceholderName(contact.name);
  const needsLocation = !contact.city?.trim() || !contact.state?.trim();
  if (!needsName && !needsLocation) {
    return { ok: true, filled: [], reason: 'Already has a name and location' };
  }

  const identity = await lookupPhoneIdentity(contact.phone, { contactId });
  if (!identity) return { ok: false, filled: [], reason: 'No result from provider' };

  const patch: Record<string, string> = {};
  const filled: string[] = [];

  if (needsName && identity.name) {
    patch.name = identity.name;
    filled.push('name');
  }
  // City and state move together. A city without its state cannot narrow a
  // search, and worse, can point it at the wrong state entirely.
  if (needsLocation && identity.city && identity.state) {
    if (!contact.city?.trim()) {
      patch.city = identity.city;
      filled.push('city');
    }
    if (!contact.state?.trim()) {
      patch.state = identity.state;
      filled.push('state');
    }
  }

  if (!filled.length) {
    return { ok: true, filled: [], reason: 'Provider returned nothing we were missing' };
  }

  const { error: updateError } = await supabase
    .from('contacts')
    .update(patch)
    .eq('id', contactId);
  if (updateError) throw new Error(updateError.message);

  // Logged against the contact so the origin of a name is auditable. A name
  // that arrived from a data provider should never be mistaken for one the
  // person gave you.
  await logActivity({
    contactId,
    actorId: opts?.actorId ?? null,
    type: 'updated',
    description: `Enriched from phone via Trestle: filled ${filled.join(', ')}`,
    meta: { filled, line_type: identity.lineType },
  });
  await logDebug({
    level: 'info',
    source: 'enrichment',
    message: `Filled ${filled.join(', ')} from reverse phone lookup`,
    contactId,
  });

  return { ok: true, filled };
}
