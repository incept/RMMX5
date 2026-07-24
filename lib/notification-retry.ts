const RETRY_DELAYS_MINUTES = [5, 15, 60, 240] as const;

export function notificationRetryUpdate(
  previousAttemptCount: number,
  error?: string,
  nowMs = Date.now()
) {
  const attemptCount = previousAttemptCount + 1;
  const delayMinutes =
    RETRY_DELAYS_MINUTES[Math.min(attemptCount - 1, RETRY_DELAYS_MINUTES.length - 1)];
  return {
    status: 'failed' as const,
    error: error ?? 'notification delivery failed',
    attempt_count: attemptCount,
    next_retry_at:
      attemptCount < 5 ? new Date(nowMs + delayMinutes * 60_000).toISOString() : null,
  };
}
