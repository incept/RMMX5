import { createAdminClient } from '@/lib/supabase/server';
import { logActivity } from '@/lib/activity';
import { logDebug } from '@/lib/debug-log';
import { lookupPhoneIdentity, type PhoneIdentity } from '@/lib/integrations/trestle';

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
  /** What the provider said, verbatim, for a human to read. */
  identity?: PhoneIdentity | null;
}

export async function enrichContactFromPhone(
  contactId: string,
  opts?: { actorId?: string | null; force?: boolean }
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
  // before the request so a re-run costs nothing. A force run (an admin's
  // explicit button press) skips this and spends the lookup anyway — the
  // point of that button is to SEE what the provider says, even when every
  // field is already set. It still only ever writes blanks below.
  const needsName = isPlaceholderName(contact.name);
  const needsLocation = !contact.city?.trim() || !contact.state?.trim();
  if (!needsName && !needsLocation && !opts?.force) {
    return { ok: true, filled: [], reason: 'Already has a name and location' };
  }

  const identity = await lookupPhoneIdentity(contact.phone, { contactId });
  if (!identity) {
    return { ok: false, filled: [], reason: 'No result from provider (is the Trestle API key configured?)', identity: null };
  }

  const filled: string[] = [];

  if (needsName && identity.name) {
    // Mark the name as reverse-lookup-derived so the UI can flag it as
    // "verify me" — a caller-ID/Trestle name is a lead, not confirmed truth.
    // Cleared when a human edits the name (see the contact PATCH route).
    const { data, error: nameError } = await supabase
      .from('contacts')
      .update({ name: identity.name, name_source: 'reverse_lookup' })
      .eq('id', contactId)
      .eq('name', contact.name)
      .select('id')
      .maybeSingle();
    if (nameError) throw new Error(nameError.message);
    if (data) filled.push('name');
  }
  // City and state move together. A city without its state cannot narrow a
  // search, and worse, can point it at the wrong state entirely.
  if (needsLocation && identity.city && identity.state) {
    if (!contact.city?.trim()) {
      let cityUpdate = supabase.from('contacts').update({ city: identity.city }).eq('id', contactId);
      cityUpdate =
        contact.city == null ? cityUpdate.is('city', null) : cityUpdate.eq('city', contact.city);
      const { data, error: cityError } = await cityUpdate.select('id').maybeSingle();
      if (cityError) throw new Error(cityError.message);
      if (data) filled.push('city');
    }
    if (!contact.state?.trim()) {
      let stateUpdate = supabase
        .from('contacts')
        .update({ state: identity.state })
        .eq('id', contactId);
      stateUpdate =
        contact.state == null ? stateUpdate.is('state', null) : stateUpdate.eq('state', contact.state);
      const { data, error: stateError } = await stateUpdate.select('id').maybeSingle();
      if (stateError) throw new Error(stateError.message);
      if (data) filled.push('state');
    }
  }

  if (!filled.length) {
    await logDebug({
      level: 'info',
      source: 'trestle:enrichment',
      message: 'Enrichment made no changes; provider returned no missing data or a user edited the contact first',
      context: { provider_has_name: !!identity.name, provider_has_location: !!(identity.city && identity.state) },
      contactId,
    });
    return { ok: true, filled: [], reason: 'Provider returned nothing we were missing', identity };
  }

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

  return { ok: true, filled, identity };
}
