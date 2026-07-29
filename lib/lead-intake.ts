import { createAdminClient } from '@/lib/supabase/server';
import {
  runSerpSearch,
  mergeSerpResults,
  canonicalUrl,
  type SearchEngine,
  type SerpResult,
} from '@/lib/integrations/brightdata';
import { applyScores, matchUrlRule, type UrlRule } from '@/lib/scoring';
import { isNonRecordUrl } from '@/lib/deep-search/extract';
import { logActivity } from '@/lib/activity';
import { getSetting } from '@/lib/settings';
import { lookupIpLocation } from '@/lib/integrations/ipapi';
import { logDebug, errorMessage } from '@/lib/debug-log';
import { captureUnruledSerpCandidates } from '@/lib/deep-search';

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
/**
 * Marks (or clears) the contact's search flag. A non-null `flag` is a short
 * human-readable reason shown in the contacts grid and the Link Data panel so a
 * search that skipped or came back partial can be found and re-run by hand.
 * Passing null clears it — done on a fully successful search.
 */
async function setSearchFlag(
  supabase: ReturnType<typeof createAdminClient>,
  contactId: string,
  flag: string | null
) {
  const { error } = await supabase
    .from('contacts')
    .update({ search_flag: flag, search_flagged_at: flag ? new Date().toISOString() : null })
    .eq('id', contactId);
  if (error) {
    // A flag that fails to persist means a broken search nobody will re-run.
    await logDebug({
      source: 'lead-intake:search-flag',
      message: `Failed to persist search flag: ${error.message}`,
      context: { flag },
      contactId,
    });
  }
}

export async function runAutoSearchForContact(
  contactId: string,
  actorId?: string | null,
  requestKey?: string
) {
  const supabase = createAdminClient();

  const { data: contact, error: contactError } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single();
  // Distinguish "could not read" from "has no name" — the old combined check
  // blamed the contact for what was actually a database error.
  if (contactError) throw new Error(`Could not read contact to search: ${contactError.message}`);
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
        const { error: locError } = await supabase
          .from('contacts')
          .update({ city, state })
          .eq('id', contactId);
        if (locError) {
          await logDebug({
            source: 'lead-intake:auto-search',
            message: `Failed to persist geolocated city/state: ${locError.message}`,
            context: { city, state },
            contactId,
          });
        }
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

  // Location is a required search input, not a nice-to-have: a name with no
  // city/state matches far too broadly to be useful and burns BrightData
  // credits on noise. If we still have neither after the IP lookup — the form
  // gave us none AND geolocation failed or was rate-limited — skip the search
  // rather than run a bad one. It surfaces in the log as a skipped search and
  // can be re-run manually once a commercial ip-api key removes the rate limit.
  if (!city && !state) {
    const reason = contact.ip
      ? `no location for the search (IP ${contact.ip} did not geolocate — likely ip-api rate limit; a commercial key removes it)`
      : 'no location for the search (lead has no city/state and no IP to geolocate)';
    await setSearchFlag(
      supabase,
      contactId,
      contact.ip
        ? 'No location to search — IP did not geolocate (likely ip-api rate limit)'
        : 'No location to search — no city/state and no IP'
    );
    await logDebug({
      level: 'warn',
      source: 'lead-intake:auto-search',
      message: `Search skipped: ${reason}`,
      context: { contact_name: contact.name, ip: contact.ip ?? null },
      contactId,
    });
    throw new Error(`Search skipped: ${reason}`);
  }

  const query = [`"${contact.name}"`, city, state, searchCfg.extra_terms]
    .filter(Boolean)
    .join(' ');

  // Query Google and Bing in parallel and merge. allSettled so one engine
  // failing (empty zone response, upstream block) still returns the other's
  // results rather than losing the whole search.
  const engines: SearchEngine[] = ['google', 'bing'];
  const settled = await Promise.allSettled(
    engines.map((engine) =>
      runSerpSearch(query, {
        engine,
        requestKey: requestKey ? `${requestKey}:${engine}` : undefined,
      })
    )
  );

  const lists: SerpResult[][] = [];
  const succeeded: SearchEngine[] = [];
  const failures: string[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      lists.push(outcome.value);
      succeeded.push(engines[i]);
    } else {
      failures.push(`${engines[i]}: ${errorMessage(outcome.reason)}`);
    }
  });

  if (failures.length) {
    await logDebug({
      level: lists.length ? 'warn' : 'error',
      source: 'brightdata',
      message: `Search engine(s) failed: ${failures.join('; ')}`,
      context: { query },
      contactId,
    });
  }
  // Only a total failure aborts — matches the old single-engine behaviour.
  if (lists.length === 0) {
    await setSearchFlag(supabase, contactId, 'All search engines failed');
    throw new Error(`All search engines failed — ${failures.join('; ')}`);
  }

  const results = mergeSerpResults(lists);

  // A failed rules read must abort, not default to []: with no rules every
  // result is "not relevant", so the search would silently report zero links
  // found while sending the whole SERP to the paid classifier.
  const { data: rules, error: rulesError } = await supabase.from('url_rules').select('*');
  if (rulesError) throw new Error(`Could not read url_rules: ${rulesError.message}`);
  const ruleRows = (rules ?? []) as UrlRule[];

  // Keep results from admin-flagged relevant sites, preserve SERP order.
  const relevant = results.filter((r) => {
    const rule = matchUrlRule(r.link, ruleRows);
    return rule ? rule.relevant : false;
  });

  // Results on domains with no rule yet are not dropped any more: about one
  // client in ten has the arrest surface on a news site or social post instead
  // of a booking site, and those domains will never be in url_rules. They go to
  // the candidate queue for review rather than into a link slot. Best-effort —
  // a classification failure must not lose the search.
  let unruledCandidates = 0;
  try {
    unruledCandidates = await captureUnruledSerpCandidates(
      contactId,
      contact.name,
      results,
      ruleRows,
      query,
      { requestKey: requestKey ? `${requestKey}:classify` : undefined }
    );
  } catch (e) {
    await logDebug({
      level: 'warn',
      source: 'lead-intake:auto-search',
      message: `Could not classify unruled results: ${errorMessage(e)}`,
      contactId,
    });
  }

  // Fill empty link slots (don't clobber links someone entered by hand).
  const { data: existing, error: existingError } = await supabase
    .from('contact_links')
    .select('position, url')
    .eq('contact_id', contactId);
  // THE most dangerous silent failure in this file: if this read fails and
  // defaults to [], every slot looks free and the position-keyed upsert below
  // OVERWRITES hand-entered links starting at slot 1. Abort instead.
  if (existingError) {
    throw new Error(`Could not read existing link slots: ${existingError.message}`);
  }
  const usedPositions = new Set((existing ?? []).filter((l) => l.url).map((l) => l.position));
  const existingUrls = new Set((existing ?? []).map((l) => l.url));

  // URLs a human already dismissed or pulled out of a slot. Checking only the
  // CURRENT slots meant a deleted link was re-placed on the very next search —
  // the same roster page came back every run no matter how often the operator
  // removed it. A deletion is a decision, and decisions are remembered as
  // rejected candidates (see the links route).
  const { data: rejectedRows, error: rejectedError } = await supabase
    .from('search_candidates')
    .select('canonical_url')
    .eq('contact_id', contactId)
    .eq('status', 'rejected')
    .limit(5_000);
  // Tombstones are human decisions; running without them re-places links the
  // operator deliberately deleted. Abort and let the job retry.
  if (rejectedError) {
    throw new Error(`Could not read rejected-link tombstones: ${rejectedError.message}`);
  }
  const humanRejected = new Set(
    ((rejectedRows ?? []) as any[]).map((r) => r.canonical_url).filter(Boolean)
  );

  let inserted = 0;
  let position = 1;
  for (const result of relevant) {
    if (existingUrls.has(result.link)) continue;
    // A relevant DOMAIN can still return a non-record page — Google happily
    // serves a site's search page or sitemap XML for a name query, and a
    // link slot holding one is not a removal target.
    if (isNonRecordUrl(result.link)) continue;
    const canonical = canonicalUrl(result.link);
    if (canonical && humanRejected.has(canonical)) continue;
    while (usedPositions.has(position) && position <= 14) position += 1;
    if (position > 14) break;

    const { error: linkError } = await supabase.from('contact_links').upsert(
      { contact_id: contactId, position, url: result.link, status: 'live' },
      { onConflict: 'contact_id,position' }
    );
    if (linkError) {
      // A relevant result that fails to store is exactly the "search said N
      // links but the tab is empty" mystery — make it loud, don't lose it.
      await logDebug({
        level: 'error',
        source: 'lead-intake:auto-search',
        message: `Failed to store link slot ${position}: ${linkError.message}`,
        context: { url: result.link, position },
        contactId,
      });
      continue;
    }
    usedPositions.add(position);
    inserted += 1;
  }

  const scores = await applyScores(contactId);

  // Flag a partial run (one engine failed but the other returned) so it can be
  // re-run once the failing engine recovers; a clean run clears any prior flag.
  const failedEngines = engines.filter((e) => !succeeded.includes(e));
  await setSearchFlag(
    supabase,
    contactId,
    failedEngines.length
      ? `${failedEngines.join(' + ')} search failed — results may be incomplete`
      : null
  );

  await logActivity({
    contactId,
    actorId,
    type: 'search',
    description:
      `Auto search ran on ${succeeded.join(' + ')} (“${query}”): ${results.length} results, ` +
      `${relevant.length} relevant, ${inserted} link(s) added` +
      `${unruledCandidates ? `, ${unruledCandidates} news/social candidate(s) to review` : ''}` +
      `. Reputation score: ${scores.reputation}`,
    meta: {
      query,
      engines: succeeded,
      total: results.length,
      relevant: relevant.length,
      inserted,
      unruled_candidates: unruledCandidates,
    },
  });

  return { query, engines: succeeded, total: results.length, relevant: relevant.length, inserted, ...scores };
}

/** "User IP" → "userip", "__ip" → "ip", "first_name" → "firstname". */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Splits a key into path segments, then returns every trailing sub-path.
 *
 *   "submission.ip"                 → ["submission.ip", "ip"]
 *   "names[first_name]"             → ["names.first_name", "first_name"]
 *   "submission.user_inputs.names"  → [full, "user_inputs.names", "names"]
 *
 * Only `.` and `[` `]` are treated as separators — splitting on `_` too would
 * reduce "first_name" to "name" and collide with the full-name field.
 */
function keyVariants(key: string): string[] {
  const segments = key.split(/[.[\]]+/).filter(Boolean);
  return segments.map((_, i) => segments.slice(i).join('.'));
}

/**
 * Indexes every scalar in the payload under a normalised key.
 *
 * Three things make raw key matching unreliable with Fluent Forms:
 *   1. It does not send nested objects — it sends FLAT keys holding a dotted
 *      path, e.g. `submission.ip`, `submission.source_url`, `names[first_name]`.
 *      Matching on the whole key finds nothing, so each key is also indexed
 *      under its trailing segments and the leaf name ("ip") becomes reachable.
 *   2. Composite fields still arrive nested in some setups (`names: {…}`), so
 *      objects are walked as well and indexed under both bare and prefixed
 *      names. Both shapes therefore resolve to the same normalised keys.
 *   3. Metadata keys vary in spelling and casing between setups — "User IP",
 *      "user_ip" and "__ip" all mean the same thing. Normalising strips the
 *      difference.
 *
 * A `{ data: {...} }` wrapper is handled for free by the same flattening.
 * First writer wins, and full keys are indexed before their shorter suffixes,
 * so a top-level `email` beats `submission.user_inputs.email`.
 */
function indexPayload(payload: Record<string, any>): Map<string, string> {
  const index = new Map<string, string>();

  const add = (key: string, value: any) => {
    if (value == null || value === '' || typeof value === 'object') return;
    // Longest first, so the most specific spelling claims each normalised slot.
    for (const variant of keyVariants(key)) {
      const normalized = normalizeKey(variant);
      if (normalized && !index.has(normalized)) index.set(normalized, String(value));
    }
  };

  const walk = (obj: Record<string, any>, prefix: string, depth: number) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return;
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value as Record<string, any>, `${prefix}${key}.`, depth + 1);
        continue;
      }
      add(key, value);
      if (prefix) add(`${prefix}${key}`, value);
    }
  };

  walk(payload, '', 0);
  return index;
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

/**
 * Maps a Fluent Forms webhook payload to a new contact. Does NOT run the auto
 * search — the webhook route persists that work so the response returns
 * within WordPress's HTTP timeout. A slow response makes Fluent Forms mark the
 * delivery failed and retry, which is how duplicate contacts happen.
 */
export async function processFluentFormsLead(payload: Record<string, any>, eventId: string) {
  const supabase = createAdminClient();

  const index = indexPayload(payload);
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const v = index.get(normalizeKey(key));
      if (v != null && v !== '') return v;
    }
    return null;
  };

  // Composite name fields are flattened by indexPayload, so first/last are
  // reachable even though Fluent Forms nests them under `names`.
  const firstName = pick('first_name', 'fname');
  const lastName = pick('last_name', 'lname');
  const name =
    pick('name', 'full_name', 'your_name') ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    null;

  const contactFields = {
    name: name || '(no name)',
    email: pick('email', 'email_address'),
    phone: pick('phone', 'phone_number', 'tel'),
    city: pick('city'),
    state: pick('state', 'region'),
      // Fluent Forms' default metadata block. It labels these "User IP",
      // "Source URL", "Browser", "Device", "User" and "Submitted On"; the
      // aliases below cover the key spellings its webhook feed actually sends.
    browser: pick('browser', 'user_agent'),
    ip: pick('ip', 'user_ip', 'ip_address', 'client_ip'),
    device: pick('device', 'device_type', 'platform', 'os'),
    source_url: pick('source_url', 'page_url', 'referer', 'referrer', 'permalink'),
    wp_user: pick('wp_user', 'user', 'username', 'user_login', 'user_email', 'user_id'),
    submitted_at: parseSubmittedAt(
      pick('submitted_on', 'submitted_at', 'created_at', 'submission_date')
    ),
    source: pick('source', 'utm_source') ?? 'fluent_forms',
    utm: pick(
      'utm',
      'utm_campaign',
      'utm_medium',
      'utm_traffic_source',
      'utm_organic_source_str'
    ),
    ppc_kw: pick('ppc_kw', 'keyword', 'utm_term', 'gclid_keyword'),
      // Join key with CallScaler: the same gclid on a form fill and a phone
      // call means the same ad click, so call intake can merge instead of
      // creating a duplicate contact.
    gclid: pick('gclid', 'google_click_id'),
  };
  const { data: contactId, error: intakeError } = await supabase.rpc('create_fluent_lead', {
    p_event_id: eventId,
    p_payload: payload,
    p_contact: contactFields,
  });
  if (intakeError || !contactId) {
    throw new Error(intakeError?.message ?? 'transactional lead intake failed');
  }
  const { data: contact, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single();
  if (error || !contact) throw new Error(error?.message ?? 'contact insert failed');

  await logActivity({
    contactId: contact.id,
    type: 'created',
    description: `Lead captured from Fluent Forms (${contact.email ?? 'no email'})`,
    meta: { source: 'fluent_forms' },
  });

  // Records exactly which keys arrived and which mapped, so a field that
  // silently lands empty can be diagnosed from Admin → Debug Log instead of
  // by querying webhook_leads for the raw payload.
  //
  // Two tiers, so the log only raises a warning for something actually broken:
  //   * critical — must come from the form. A miss here means the mapping is
  //     wrong. ('(no name)' is the nothing-mapped placeholder, so it counts as
  //     a miss even though the column is non-null.)
  //   * derived  — city/state come from the IP geolocation that runs AFTER this
  //     check (see runAutoSearchForContact), and phone is not on this form at
  //     all. Reporting them is useful, but they are expected to be blank here
  //     and must not trip a warning on every single lead.
  const isMissing = (field: string) => {
    const value = (contact as any)[field];
    return !value || (field === 'name' && value === '(no name)');
  };
  const criticalMissing = ['name', 'email', 'ip'].filter(isMissing);
  const derivedMissing = ['phone', 'city', 'state'].filter(isMissing);
  await logDebug({
    level: criticalMissing.length ? 'warn' : 'info',
    source: 'lead-intake:mapping',
    message: criticalMissing.length
      ? `Lead stored, but core fields did not map: ${criticalMissing.join(', ')}`
      : derivedMissing.length
        ? `Lead stored; core fields mapped. Not on this form / filled later: ${derivedMissing.join(', ')}`
        : 'Lead stored with all fields mapped',
    context: {
      payload_keys: [...index.keys()].sort(),
      critical_missing: criticalMissing,
      derived_missing: derivedMissing,
    },
    contactId: contact.id,
  });

  return { contact };
}

/**
 * Auto search is best-effort: a missing BrightData key, a rate-limited ip-api,
 * or a SERP failure must never lose the lead (and, from a webhook, must never
 * turn into a 500 that makes the sender retry). Failures land in the activity
 * feed and Debug Log; runAutoSearchForContact flags the contact itself.
 */
export async function runAutoSearchSafely(contactId: string) {
  try {
    return await runAutoSearchForContact(contactId);
  } catch (e: any) {
    await logActivity({
      contactId,
      type: 'search',
      description: `Auto search skipped: ${errorMessage(e)}`,
    });
    await logDebug({
      source: 'lead-intake:auto-search',
      message: errorMessage(e),
      contactId,
    });
    return null;
  }
}

/**
 * Best-available idempotency key for a Fluent Forms delivery. Fluent Forms
 * sends its entry id under flat dotted keys (`submission.id`, `entry.id` …) —
 * never as a top-level `entry_id` — so this reuses the same flattening index
 * the field mapping uses. When no id key exists at all, the caller should fall
 * back to hashing the payload: a retry re-sends the identical body, so the
 * hash still collapses duplicates.
 */
export function extractFluentFormsEventId(payload: Record<string, any>): string | null {
  const index = indexPayload(payload);
  for (const key of ['entry_id', 'submission_id', 'serial_number', 'id']) {
    const v = index.get(normalizeKey(key));
    if (v != null && v !== '') return v;
  }
  return null;
}
