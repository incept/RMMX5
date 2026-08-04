import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { apiFailure } from '@/lib/api-errors';
import { markEmailAssetsReferenced } from '@/lib/email-assets';
import { sanitizeEmailHtml } from '@/lib/html-sanitize';
import { readJsonBody } from '@/lib/request-limits';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const START_TRIGGERS = new Set(['manual', 'list_added', 'status_change']);
const STOP_TRIGGERS = new Set(['open', 'click', 'reply', 'bounce', 'status_change']);

function uuidOrNull(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  const id = String(value);
  if (!UUID_PATTERN.test(id)) throw new Error(`${label} must be a valid UUID`);
  return id;
}

function uuidArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.map(String))];
  if (ids.some((id) => !UUID_PATTERN.test(id))) throw new Error(`${label} contains an invalid UUID`);
  return ids;
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  try {
    const body = await readJsonBody(request, 1024 * 1024);
    const name = String(body?.name ?? '').trim().slice(0, 200);
    if (!name) return NextResponse.json({ error: 'Sequence name is required' }, { status: 400 });
    const startTrigger = String(body?.start_trigger ?? 'manual');
    if (!START_TRIGGERS.has(startTrigger)) {
      return NextResponse.json({ error: 'Invalid sequence start trigger' }, { status: 400 });
    }
    const stopOn: string[] = Array.isArray(body?.stop_on)
      ? [...new Set<string>((body.stop_on as unknown[]).map(String))]
      : [];
    if (stopOn.some((trigger) => !STOP_TRIGGERS.has(trigger))) {
      return NextResponse.json({ error: 'Invalid sequence stop trigger' }, { status: 400 });
    }
    if (!Array.isArray(body?.steps) || body.steps.length > 100) {
      return NextResponse.json({ error: 'steps must be an array with at most 100 entries' }, { status: 400 });
    }
    const steps: Array<{ subject: string; html: string; delay_days: number }> = (
      body.steps as unknown[]
    ).map((step: any) => {
      const subject = String(step?.subject ?? '').trim().slice(0, 500);
      const html = sanitizeEmailHtml(String(step?.html ?? '').slice(0, 250_000));
      const delay = Number(step?.delay_days ?? 0);
      if (!subject || !Number.isInteger(delay) || delay < 0 || delay > 3650) {
        throw new Error('Every sequence step needs a subject and a delay from 0 to 3650 days');
      }
      return { subject, html, delay_days: delay };
    });

    const admin = createAdminClient();
    await markEmailAssetsReferenced(admin, steps.map((step) => step.html).join('\n'));
    const { data, error } = await admin.rpc('save_email_sequence', {
      p_sequence_id: uuidOrNull(body?.id, 'Sequence id'),
      p_name: name,
      p_list_id: uuidOrNull(body?.list_id, 'List id'),
      p_send_account_id: uuidOrNull(body?.send_account_id, 'Send account id'),
      p_active: body?.active === true,
      p_start_trigger: startTrigger,
      p_start_status_ids: uuidArray(body?.start_status_ids, 'Start statuses'),
      p_stop_on: stopOn,
      p_stop_status_ids: uuidArray(body?.stop_status_ids, 'Stop statuses'),
      p_steps: steps,
    });
    if (error) throw error;
    return NextResponse.json({ id: data });
  } catch (error) {
    return apiFailure('api:email/sequences', error);
  }
}
