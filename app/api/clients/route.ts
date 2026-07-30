import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { apiFailure } from '@/lib/api-errors';

const PAGE_SIZE = 100;

// Columns the client grid may sort on. Anything else falls back to client_since.
// gross/projection are admin-only, matching their visibility.
const SORT_COLUMNS: Record<string, { col: string; adminOnly?: boolean }> = {
  name: { col: 'name' },
  state: { col: 'state' },
  signed_date: { col: 'signed_date' },
  client_since: { col: 'client_since' },
  reputation_score: { col: 'reputation_score' },
  gross_revenue: { col: 'gross_revenue', adminOnly: true },
  revenue_projection: { col: 'revenue_projection', adminOnly: true },
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

  const admin = createAdminClient();

  try {
    const { data: clientStatuses, error: statusesError } = await admin
      .from('statuses')
      .select('id')
      .eq('is_client_status', true);
    if (statusesError) throw statusesError;
    const ids = (clientStatuses ?? []).map((status) => status.id);
    const columns =
      'id, name, email, phone, state, source, stage_id, client_since, signed_date, service_days, reputation_score, stages ( id, name, color )';
    let query = admin
      .from('contacts')
      .select(isAdmin ? `${columns}, revenue_projection, gross_revenue` : columns, { count: 'exact' })
      .order(sortCol, { ascending, nullsFirst: false })
      .order('id', { ascending: true }) // stable tiebreaker so pages don't shuffle
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (ids.length) query = query.or(`status_id.in.(${ids.join(',')}),client_since.not.is.null`);
    else query = query.not('client_since', 'is', null);
    if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);

    const [{ data, error, count }, { data: summary, error: summaryError }] = await Promise.all([
      query,
      auth.supabase.rpc('client_summary'),
    ]);
    if (error) throw error;
    if (summaryError) throw summaryError;
    // Count comes from the (search-)filtered query so pagination is correct;
    // the projected total stays the global figure from client_summary.
    return NextResponse.json({
      clients: data ?? [],
      summary: {
        count: count ?? summary?.count ?? 0,
        projection_total: summary?.projection_total ?? 0,
      },
    });
  } catch (error) {
    return apiFailure('api:clients', error, { context: { page } });
  }
}
