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

export async function loadLinkPlaceholders(
  admin: Admin,
  contactId: string
): Promise<Record<string, string>> {
  const { data } = await admin
    .from('contact_links')
    .select('position, url, status')
    .eq('contact_id', contactId)
    .order('position');

  const vars: Record<string, string> = {};
  const live: string[] = [];
  for (const l of data ?? []) {
    const url = String(l.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) continue; // only real web links
    vars[`link${l.position}`] = url;
    if (l.status === 'live') live.push(url);
  }
  vars.links = live.join('\n');
  return vars;
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
