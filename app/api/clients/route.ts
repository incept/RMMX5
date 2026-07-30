import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { apiFailure } from '@/lib/api-errors';

const PAGE_SIZE = 100;

export async function GET(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const rawPage = Number(new URL(request.url).searchParams.get('page') ?? 0);
  const page = Number.isInteger(rawPage) && rawPage >= 0 ? Math.min(rawPage, 10_000) : 0;
  const isAdmin = ['admin', 'super_admin'].includes(auth.profile.role);
  const admin = createAdminClient();

  try {
    const { data: clientStatuses, error: statusesError } = await admin
      .from('statuses')
      .select('id')
      .eq('is_client_status', true);
    if (statusesError) throw statusesError;
    const ids = (clientStatuses ?? []).map((status) => status.id);
    const columns =
      'id, name, email, phone, state, source, stage_id, client_since, signed_date, service_days, contact_links ( status ), stages ( id, name, color )';
    let query = admin
      .from('contacts')
      .select(isAdmin ? `${columns}, gross_revenue` : columns)
      .order('client_since', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (ids.length) query = query.or(`status_id.in.(${ids.join(',')}),client_since.not.is.null`);
    else query = query.not('client_since', 'is', null);

    const [{ data, error }, { data: summary, error: summaryError }] = await Promise.all([
      query,
      auth.supabase.rpc('client_summary'),
    ]);
    if (error) throw error;
    if (summaryError) throw summaryError;
    return NextResponse.json({ clients: data ?? [], summary: summary ?? { count: 0 } });
  } catch (error) {
    return apiFailure('api:clients', error, { context: { page } });
  }
}
