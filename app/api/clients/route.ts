import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { apiFailure } from '@/lib/api-errors';

const PAGE_SIZE = 100;

// Columns the client grid may sort on. Anything else falls back to client_since.
// gross is admin-only, matching its visibility.
const SORT_COLUMNS: Record<string, { col: string; adminOnly?: boolean }> = {
  name: { col: 'name' },
  state: { col: 'state' },
  signed_date: { col: 'signed_date' },
  client_since: { col: 'client_since' },
  gross_revenue: { col: 'gross_revenue', adminOnly: true },
  source: { col: 'source' },
  email: { col: 'email' },
  phone: { col: 'phone' },
};

export async function GET(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const url = new URL(request.url);
  const rawPage = Number(url.searchParams.get('page') ?? 0);
  const page = Number.isInteger(rawPage) && rawPage >= 0 ? Math.min(rawPage, 10_000) : 0;
  const isAdmin = ['admin', 'super_admin'].includes(auth.profile.role);

  const chosen = SORT_COLUMNS[url.searchParams.get('sort') ?? ''];
  const sortCol = chosen && (isAdmin || !chosen.adminOnly) ? chosen.col : 'client_since';
  const ascending = url.searchParams.get('dir') !== 'desc';
  // Strip PostgREST filter syntax before the term goes into an .or() string.
  const q = (url.searchParams.get('q') ?? '').replace(/[,()%*:\\]/g, ' ').trim().slice(0, 100);
  // Optional filter: clients holding at least one removal link in this status.
  const linkStatusParam = url.searchParams.get('linkStatus') ?? '';
  const linkStatus =
    (['live', 'requested', 'removed'] as const).find((s) => s === linkStatusParam) ?? null;

  const admin = createAdminClient();

  try {
    const { data: clientStatuses, error: statusesError } = await admin
      .from('statuses')
      .select('id')
      .eq('is_client_status', true);
    if (statusesError) throw statusesError;
    const ids = (clientStatuses ?? []).map((status) => status.id);

    // #4: filter by link status with a database inner join, so narrowing,
    // counting and paging all happen in SQL. The previous approach pulled every
    // matching contact_id into Node and passed them back through .in(...), which
    // is capped by the API's row-return limit (clients could silently vanish
    // from a filtered page at scale) and could build an enormous request URL.
    const baseColumns =
      'id, name, email, phone, state, source, stage_id, client_since, signed_date, service_days, stages ( id, name, color )';
    // Unfiltered: embed all link statuses for the Link Stats counts. Filtered:
    // inner-join on the chosen status to narrow the rows; the full counts for the
    // (<=100-row) page are restored below so the Link Stats column stays whole.
    const linkEmbed = linkStatus ? 'contact_links!inner ( status )' : 'contact_links ( status )';
    const columns = `${baseColumns}, ${linkEmbed}`;
    let query = admin
      .from('contacts')
      .select(isAdmin ? `${columns}, gross_revenue` : columns, { count: 'exact' })
      .order(sortCol, { ascending, nullsFirst: false })
      .order('id', { ascending: true }) // stable tiebreaker so pages don't shuffle
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (ids.length) query = query.or(`status_id.in.(${ids.join(',')}),client_since.not.is.null`);
    else query = query.not('client_since', 'is', null);
    if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
    if (linkStatus) query = query.eq('contact_links.status', linkStatus);

    const [{ data, error, count }, { data: summary, error: summaryError }] = await Promise.all([
      query,
      auth.supabase.rpc('client_summary'),
    ]);
    if (error) throw error;
    if (summaryError) throw summaryError;

    // The inner join narrowed each matched row's contact_links to the filtered
    // status; re-fetch the full status set for just the visible clients so the
    // Link Stats counts stay complete. Bounded: <=100 clients, <=14 links each.
    let clients = data ?? [];
    if (linkStatus && clients.length) {
      const pageIds = clients.map((c: any) => c.id);
      const { data: allLinks, error: linksError } = await admin
        .from('contact_links')
        .select('contact_id, status')
        .in('contact_id', pageIds)
        // position is capped 1-14, so this is the hard ceiling for a page of
        // <=100 clients — an explicit bound so no default row cap can truncate it.
        .limit(pageIds.length * 14);
      if (linksError) throw linksError;
      const byContact = new Map<string, { status: string }[]>();
      for (const link of allLinks ?? []) {
        const list = byContact.get(link.contact_id as string) ?? [];
        list.push({ status: link.status as string });
        byContact.set(link.contact_id as string, list);
      }
      clients = clients.map((c: any) => ({
        ...c,
        contact_links: byContact.get(c.id) ?? c.contact_links,
      }));
    }

    // Count comes from the (search-/link-)filtered query so pagination is
    // correct; the projected total stays the global figure from client_summary.
    return NextResponse.json({
      clients,
      summary: {
        count: count ?? summary?.count ?? 0,
        projection_total: summary?.projection_total ?? 0,
      },
    });
  } catch (error) {
    return apiFailure('api:clients', error, { context: { page } });
  }
}
