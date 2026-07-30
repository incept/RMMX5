'use client';

import { useEffect, useRef } from 'react';

/**
 * Keeps a view's data current without a manual reload. Re-runs `refresh` when
 * the user returns to the tab — window focus or the tab becoming visible again —
 * so switching back to the CRM shows new leads, messages, and status changes
 * that arrived while it was in the background.
 *
 * Deliberately conservative for the sake of the server: it only fires while the
 * tab is actually visible, and a `minGapMs` guard collapses the focus +
 * visibilitychange pair that a single tab-switch emits into one fetch. Pass
 * `intervalMs` to also poll on a slow timer while visible (off by default — a
 * background tab never polls).
 *
 * `refresh` may change every render (it usually closes over state); it is read
 * from a ref, so the listeners are bound once and always call the latest one.
 */
export function useAutoRefresh(
  refresh: () => void,
  opts?: { intervalMs?: number; minGapMs?: number }
): void {
  const minGap = opts?.minGapMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 0;
  // Seed with "now" so the mount's own initial load isn't immediately doubled
  // by a focus event that fires on the same tick.
  const lastRun = useRef(Date.now());
  const cb = useRef(refresh);
  cb.current = refresh;

  useEffect(() => {
    const maybeRun = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastRun.current < minGap) return;
      lastRun.current = now;
      cb.current();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') maybeRun();
    };

    window.addEventListener('focus', maybeRun);
    document.addEventListener('visibilitychange', onVisible);
    const timer = intervalMs > 0 ? setInterval(maybeRun, intervalMs) : null;

    return () => {
      window.removeEventListener('focus', maybeRun);
      document.removeEventListener('visibilitychange', onVisible);
      if (timer) clearInterval(timer);
    };
  }, [minGap, intervalMs]);
}
