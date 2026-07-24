import { createAdminClient } from '@/lib/supabase/server';
import { runGoogleSearch } from '@/lib/integrations/brightdata';
import { applyScores, matchUrlRule, type UrlRule } from '@/lib/scoring';
import { logActivity } from '@/lib/activity';
import { getSetting } from '@/lib/settings';
import { lookupIpLocation } from '@/lib/integrations/ipapi';
import { logDebug, errorMessage } from '@/lib/debug-log';

/**
 * Lead intake pipeline (Fluent Forms webhook → contact → auto search).
 *
 * 1. Create the contact from the form payload (name/email/phone/city/state
 *    plus tracking data: IP, browser, source, UTM, PPC keyword).
 * 2. Run the automatic Google search for the lead's name (+ admin-configured
 *    extra terms, e.g. `"John Smith" city`) through BrightData.
 * 3. Keep only results whose domain matches a RELEVANT url_rule (the admin's
 *    filter of "sites we care about" — mugshot sites, complaint boards, etc.)
 * 4. Fill link slots 1–14 with those results and compute the scores.
 */
export async function runAutoSearchForContact(contactId: string, actorId?: string | null) {
  const supabase = createAdminClient();

  const { data: contact } = await supabase.from('contacts').select('*').eq('id', contactId).single();
  if (!contact?.name) throw new Error('Contact has no name to search for');

  const searchCfg = await getSetting<{ extra_terms?: string }>('search');

  // A name with no location searches far too broadly. When the lead has no
  // city/state (Fluent Forms often only gives us an IP), geolocate the IP and
  // use that, persisting it so the contact record and later searches benefit.
  let city: string | null = contact.city;
  let state: string | null = contact.state;
  if ((!city || !state) && contact.ip) {
    const located = await lookupIpLocation(contact.ip);
    if (located) {
      city = city || located.city;
      state = state || located.region || located.regionName;
      if (city !== contact.city || state !== contact.state) {
        await supabase.from('contacts').update({ city, state }).eq('id', contactId);
        await logActivity({
          contactId,
          actorId,
          type: 'updated',
          description: `Location resolved from IP ${contact.ip}: ${[city, state].filter(Boolean).join(', ')}`,
          meta: { source: 'ip-api' },
        });
      }
    }
  }

  const query = [`"${contact.name}"`, city, state, searchCfg.extra_terms]
    .filter(Boolean)
    .join(' ');

  const results = await runGoogleSearch(query);

  const { data: rules } = await supabase.from('url_rules').select('*');
  const ruleRows = (rules ?? []) as UrlRule[];

  // Keep results from admin-flagged relevant sites, preserve SERP order.
  const relevant = results.filter((r) => {
    const rule = matchUrlRule(r.link, ruleRows);
    return rule ? rule.relevant : false;
  });

  // Fill empty link slots (don't clobber links someone entered by hand).
  const { data: existing } = await supabase
    .from('contact_links')
    .select('position, url')
    .eq('contact_id', contactId);
  const usedPositions = new Set((existing ?? []).filter((l) => l.url).map((l) => l.position));
  const existingUrls = new Set((existing ?? []).map((l) => l.url));

  let inserted = 0;
  let position = 1;
  for (const result of relevant) {
    if (existingUrls.has(result.link)) continue;
    while (usedPositions.has(position) && position <= 14) position += 1;
    if (position > 14) break;

    await supabase.from('contact_links').upsert(
      { contact_id: contactId, position, url: result.link, status: 'live' },
      { onConflict: 'contact_id,position' }
    );
    usedPositions.add(position);
    inserted += 1;
  }

  const scores = await applyScores(contactId);

  await logActivity({
    contactId,
    actorId,
    type: 'search',
    description: `Auto Google search ran (“${query}”): ${results.length} results, ${relevant.length} relevant, ${inserted} link(s) added. Reputation score: ${scores.reputation}`,
    meta: { query, total: results.length, relevant: relevant.length, inserted },
  });

  return { query, total: results.length, relevant: relevant.length, inserted, ...scores };
}

/**
 * Fluent Forms sends "Submitted On" as a MySQL-style local datetime
 * ("2026-07-24 02:34:01"), which `new Date()` parses inconsistently across
 * runtimes. Normalise to ISO; return null rather than store an Invalid Date.
 */
function parseSubmittedAt(value: string | null): string | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Maps a Fluent Forms webhook payload to a new contact + kicks off the auto search. */
export async function processFluentFormsLead(payload: Record<string, any>) {
  const supabase = createAdminClient();

  // Fluent Forms posts field values keyed by the form field names; support
  // both flat payloads and the { data: {...} } wrapper, and common aliases.
  const data = payload.data ?? payload;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const v = data[key] ?? payload[key];
      if (v != null && v !== '') return String(v);
    }
    return null;
  };

  const firstName = pick('first_name', 'fname');
  const lastName = pick('last_name', 'lname');
  const name =
    pick('name', 'full_name', 'names') ??
    [firstName, lastName].filter(Boolean).join(' ');

  const { data: newStatus } = await supabase
    .from('statuses')
    .select('id')
    .eq('name', 'New')
    .maybeSingle();

  const { data: contact, error } = await supabase
    .from('contacts')
    .insert({
      name: name || '(no name)',
      email: pick('email', 'email_address'),
      phone: pick('phone', 'phone_number', 'tel'),
      city: pick('city'),
      state: pick('state', 'region'),
      status_id: newStatus?.id ?? null,
      // Fluent Forms' default metadata block. It labels these "User IP",
      // "Source URL", "Browser", "Device", "User" and "Submitted On"; the
      // aliases below cover the key spellings its webhook feed actually sends.
      browser: pick('browser', 'user_agent', '__user_agent'),
      ip: pick('ip', 'ip_address', 'user_ip', '__ip'),
      device: pick('device', 'platform', 'os', 'device_type'),
      source_url: pick('source_url', '__source_url', 'page_url', 'referer', 'referrer'),
      wp_user: pick('wp_user', 'user', 'username', 'user_login', 'user_email'),
      submitted_at: parseSubmittedAt(
        pick('submitted_on', 'submitted_at', 'created_at', 'submission_date')
      ),
      source: pick('source', 'utm_source') ?? 'fluent_forms',
      utm: pick('utm', 'utm_campaign', 'utm_medium'),
      ppc_kw: pick('ppc_kw', 'keyword', 'utm_term', 'gclid_keyword'),
    })
    .select('*')
    .single();
  if (error || !contact) throw new Error(error?.message ?? 'contact insert failed');

  await logActivity({
    contactId: contact.id,
    type: 'created',
    description: `Lead captured from Fluent Forms (${contact.email ?? 'no email'})`,
    meta: { source: 'fluent_forms' },
  });

  // Auto search is best-effort: a missing BrightData key shouldn't lose the lead.
  let search: any = null;
  try {
    search = await runAutoSearchForContact(contact.id);
  } catch (e: any) {
    await logActivity({
      contactId: contact.id,
      type: 'search',
      description: `Auto search skipped: ${errorMessage(e)}`,
    });
    await logDebug({
      source: 'lead-intake:auto-search',
      message: errorMessage(e),
      context: { contact_name: contact.name, ip: contact.ip },
      contactId: contact.id,
    });
  }

  return { contact, search };
}
