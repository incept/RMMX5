'use client';

import { useEffect, useId, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * Near-live refresh via a DEBOUNCED Supabase Realtime subscription. Subscribes
 * to row changes on `tables`; when any arrive, it schedules ONE refresh at most
 * every `debounceMs` (default 5s), coalescing a burst of inserts/updates into a
 * single refetch instead of a re-render per row.
 *
 * Event-driven, so an idle page holds only a websocket and issues NO requests
 * until something actually changes — the reason this is lighter than polling,
 * which pays on every tick whether or not there is news. RLS still governs which
 * changes reach the subscriber (a worker never receives a row it cannot select).
 *
 * Pairs with useAutoRefresh (focus/visibility): a change that arrives while the
 * tab is hidden is skipped here and picked up when the tab is next focused, so a
 * backgrounded tab does no refetching at all.
 */
export function useRealtimeRefresh(
  tables: string | string[],
  refresh: () => void,
  opts?: { debounceMs?: number }
): void {
  const debounceMs = opts?.debounceMs ?? 5_000;
  const list = Array.isArray(tables) ? tables : [tables];
  const key = list.join(',');
  const cb = useRef(refresh);
  cb.current = refresh;

  // A per-instance suffix keeps every call site's channel topic unique. Supabase
  // dedupes channels by topic — RealtimeClient.channel() returns an EXISTING
  // channel for a repeated topic — so two components watching the same table
  // (e.g. the Sidebar unread badge and the inbox list, both on `email_messages`)
  // would otherwise share one channel object. Whichever mounts second would then
  // call `.on('postgres_changes', …)` on the already-subscribed channel, which
  // supabase throws on ("cannot add … callbacks after `subscribe()`"), and the
  // uncaught error tears down that page's React tree. Unique topics let both
  // subscribe independently; both still receive the row events.
  const instanceId = useId();

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = () => {
      if (timer) return; // a refresh is already pending in this window
      timer = setTimeout(() => {
        timer = null;
        // Skip a hidden tab; useAutoRefresh refreshes it on return, so a
        // backgrounded tab never refetches on a change it isn't showing.
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        cb.current();
      }, debounceMs);
    };

    const channel = supabase.channel(`ui-refresh:${key}:${instanceId}`);
    for (const table of list) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, scheduleRefresh);
    }
    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [key, debounceMs, instanceId]);
}
