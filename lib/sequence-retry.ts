export const MAX_SEQUENCE_DELIVERY_ATTEMPTS = 5;

/**
 * Builds the persistence patch for a failed sequence delivery. The current
 * step is deliberately absent: callers must not advance until delivery works.
 */
export function sequenceFailureUpdate(
  previousAttempts: number,
  error: string,
  nowMs = Date.now()
): Record<string, string | number | null> {
  const attemptCount = Math.max(0, previousAttempts) + 1;
  const message = error.slice(0, 2000);

  if (attemptCount >= MAX_SEQUENCE_DELIVERY_ATTEMPTS) {
    return {
      attempt_count: attemptCount,
      last_error: message,
      status: 'stopped',
      stop_reason: 'delivery_failed',
      next_send_at: null,
    };
  }

  // 15, 30, 60, then 120 minutes before the final attempt.
  const retryMinutes = 15 * 2 ** (attemptCount - 1);
  return {
    attempt_count: attemptCount,
    last_error: message,
    next_send_at: new Date(nowMs + retryMinutes * 60_000).toISOString(),
  };
}
