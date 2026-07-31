import { createAdminClient } from '@/lib/supabase/server';
import { enqueueJob } from '@/lib/job-queue';
import { getSetting } from '@/lib/settings';
import { probeLinkLiveness } from '@/lib/deep-search/fetch-page';
import { logActivity } from '@/lib/activity';
import { logDebug } from '@/lib/debug-log';

/**
 * Cron scan: claim a batch of due CLIENT removal links (status 'requested',
 * last checked more than the interval ago) and enqueue one link_recheck job
 * each. The claim stamps last_checked_at, so a link is enqueued at most once per
 * interval and overlapping ticks can't double-enqueue. The slow fetch happens in
 * the job on the heavy lane — never here in the tick.
 *
 * Off-switch + cadence live in the 'link_recheck' setting (default: on, 8h,
 * clamped to 6-12h in the RPC).
 */
export async function processLinkRechecks(limit = 10) {
  const cfg = await getSetting<{ enabled?: boolean | string; interval_hours?: number | string }>(
    'link_recheck'
  );
  if (cfg.enabled === false || cfg.enabled === 'false') return { claimed: 0, enqueued: 0 };
  const intervalHours = Number(cfg.interval_hours ?? 8);

  const supabase = createAdminClient();
  const { data: due, error } = await supabase.rpc('claim_due_link_rechecks', {
    p_limit: limit,
    p_interval_hours: Number.isFinite(intervalHours) ? intervalHours : 8,
  });
  if (error) throw new Error(error.message);

  let enqueued = 0;
  for (const link of due ?? []) {
    // Hour-bucketed dedupe key: a link is claimed at most once per interval
    // (>= 6h), so the bucket differs every cycle and a completed job never
    // blocks the next one.
    const bucket = new Date().toISOString().slice(0, 13);
    await enqueueJob(
      'link_recheck',
      { linkId: link.id, contactId: link.contact_id },
      `link-recheck:${link.id}:${bucket}`,
      3 // a check that keeps erroring shouldn't retry forever
    );
    enqueued += 1;
  }
  return { claimed: due?.length ?? 0, enqueued };
}

/**
 * Job body: fetch the link, fold the result into the streak via
 * record_link_recheck. No status is flipped here — reaching the consecutive-gone
 * threshold only raises removal_detected, which surfaces the link in the admin
 * confirmation queue. A blocked/unknown read never advances the streak.
 */
export async function runLinkRecheck(linkId: string, signal?: AbortSignal) {
  const supabase = createAdminClient();
  const { data: link, error } = await supabase
    .from('contact_links')
    .select('id, url, status, removal_detected, contact_id, contacts ( name )')
    .eq('id', linkId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  // Stale claim: the operator may have edited, confirmed, or dismissed it since
  // the job was queued.
  if (!link || link.status !== 'requested' || link.removal_detected) return;

  const name = ((link as { contacts?: { name?: string | null } }).contacts?.name ?? '') as string;
  const result = await probeLinkLiveness(link.url, name, { signal });

  const { data: recorded, error: recordError } = await supabase.rpc('record_link_recheck', {
    p_link_id: linkId,
    p_result: result.state,
  });
  if (recordError) throw new Error(recordError.message);

  const row = Array.isArray(recorded) ? recorded[0] : recorded;
  if (row?.detected) {
    // Crossed the threshold: leave a trail on the contact and let the queue
    // surface it. The flip to 'removed' stays a human decision (Option B).
    await logActivity({
      contactId: link.contact_id,
      type: 'link_change',
      description:
        `Possible removal detected for ${link.url} after ${row.streak} consecutive ` +
        `"gone" reads — awaiting confirmation`,
    });
  } else {
    await logDebug({
      source: 'link-recheck',
      message: `re-check ${result.state}: ${result.note}`,
      context: { link_id: linkId, url: link.url, result: result.state, streak: row?.streak },
      contactId: link.contact_id,
    }).catch(() => {});
  }
}
