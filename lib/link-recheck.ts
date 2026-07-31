import { createAdminClient } from '@/lib/supabase/server';
import { getSetting } from '@/lib/settings';
import { probeLinkLiveness } from '@/lib/deep-search/fetch-page';
import { logActivity } from '@/lib/activity';
import { logDebug } from '@/lib/debug-log';

/**
 * Cron scan: claim a batch of due CLIENT removal links (status 'requested',
 * last checked more than the interval ago). The claim RPC both stamps
 * last_checked_at AND inserts the link_recheck jobs in one transaction, so a
 * failed enqueue rolls back the stamp (a link is never marked checked without a
 * job behind it), and it caps how many recheck jobs may be in flight so a big
 * first scan can't enqueue faster than the one-per-tick heavy lane drains and
 * delay newly-submitted deep searches. The slow fetch happens in the job on the
 * heavy lane — never here in the tick.
 *
 * Off-switch + cadence + in-flight cap live in the 'link_recheck' setting
 * (default: on, 8h clamped to 6-12h, 20 jobs max in flight).
 */
export async function processLinkRechecks(limit = 10) {
  const cfg = await getSetting<{
    enabled?: boolean | string;
    interval_hours?: number | string;
    max_inflight?: number | string;
  }>('link_recheck');
  if (cfg.enabled === false || cfg.enabled === 'false') return { claimed: 0, enqueued: 0 };
  const intervalHours = Number(cfg.interval_hours ?? 8);
  const maxInflight = Number(cfg.max_inflight ?? 20);

  const supabase = createAdminClient();
  const { data: due, error } = await supabase.rpc('claim_due_link_rechecks', {
    p_limit: limit,
    p_interval_hours: Number.isFinite(intervalHours) ? intervalHours : 8,
    p_max_inflight: Number.isFinite(maxInflight) ? maxInflight : 20,
  });
  if (error) throw new Error(error.message);

  // The RPC enqueued a link_recheck job for each returned link atomically with
  // the claim, so there is no separate enqueue step (and no partial-failure gap).
  const claimed = due?.length ?? 0;
  return { claimed, enqueued: claimed };
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
    // Compare-and-set: only fold this result in if the row still holds the URL we
    // actually probed. An edit mid-fetch changes the URL, so the stale result is
    // dropped instead of advancing the new URL's streak.
    p_expected_url: link.url,
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
