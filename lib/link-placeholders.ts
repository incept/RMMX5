import type { createAdminClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createAdminClient>;

// Per-contact link merge fields, resolved at send time:
//   {{link1}}..{{link14}} -> that contact's removal-link URL at each position
//   {{links}}             -> all their LIVE link URLs, one per line
// Used inside a template/email like `<a href="{{link1}}">{{link1}}</a>`.
// renderTemplate HTML-escapes the substituted value, so a URL in an href is
// safe; we additionally keep only http(s) URLs so a scraped `javascript:` link
// can't become a live href.

/** Cheap guard so the DB read only happens when a template references links. */
export function templateUsesLinks(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && /\{\{\s*links?\d*\s*\}\}/i.test(t));
}

/**
 * Build the {{link N}} / {{links}} substitution vars from a contact's link rows.
 * Pure (no DB), so the same mapping serves the send-time resolver AND the
 * client-side compose preview. Only http(s) URLs are kept; {{links}} is every
 * LIVE link joined by newlines, in position order.
 */
export function linkVarsFromRows(
  rows:
    | { position: number; url: string | null | undefined; status?: string | null }[]
    | null
    | undefined
): Record<string, string> {
  const vars: Record<string, string> = {};
  const live: string[] = [];
  for (const l of rows ?? []) {
    const url = String(l.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) continue; // only real web links
    vars[`link${l.position}`] = url;
    if (l.status === 'live') live.push(url);
  }
  vars.links = live.join('\n');
  return vars;
}

export async function loadLinkPlaceholders(
  admin: Admin,
  contactId: string
): Promise<Record<string, string>> {
  const { data, error } = await admin
    .from('contact_links')
    .select('position, url, status')
    .eq('contact_id', contactId)
    .order('position');
  if (error) throw new Error(`Could not load contact links: ${error.message}`);
  return linkVarsFromRows(data);
}

/** Resolve link placeholders for many recipients with one database read. */
export async function loadLinkPlaceholdersForContacts(
  admin: Admin,
  contactIds: string[]
): Promise<Map<string, Record<string, string>>> {
  const uniqueIds = [...new Set(contactIds)];
  const out = new Map<string, Record<string, string>>();
  for (const id of uniqueIds) out.set(id, { links: '' });
  if (!uniqueIds.length) return out;

  const { data, error } = await admin
    .from('contact_links')
    .select('contact_id, position, url, status')
    .in('contact_id', uniqueIds)
    .order('contact_id')
    .order('position');
  if (error) throw new Error(`Could not load contact links: ${error.message}`);

  const live = new Map<string, string[]>();
  for (const link of data ?? []) {
    const id = String(link.contact_id);
    const url = String(link.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const vars = out.get(id) ?? { links: '' };
    vars[`link${link.position}`] = url;
    out.set(id, vars);
    if (link.status === 'live') {
      const values = live.get(id) ?? [];
      values.push(url);
      live.set(id, values);
    }
  }
  for (const [id, vars] of out) vars.links = (live.get(id) ?? []).join('\n');
  return out;
}

/**
 * Return `contact` merged with its link placeholders, but only when one of the
 * given template texts actually references a link (otherwise the original
 * contact is returned untouched, with no extra DB read).
 */
export async function withLinkPlaceholders<T extends { id: string }>(
  admin: Admin,
  contact: T,
  ...texts: (string | null | undefined)[]
): Promise<T & Record<string, string>> {
  if (!templateUsesLinks(...texts)) return contact;
  const vars = await loadLinkPlaceholders(admin, contact.id);
  return { ...contact, ...vars };
}
