export interface CallScalerPage {
  calls: any[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Accepts the documented { data: { calls, ...pagination } } envelope. */
export function parseCallScalerPage(data: any): CallScalerPage {
  const envelope = data?.data ?? data;
  if (Array.isArray(envelope)) {
    return { calls: envelope, hasMore: false, nextCursor: null };
  }
  if (!envelope || !Array.isArray(envelope.calls)) {
    throw new Error('CallScaler Calls API response did not contain a calls array');
  }
  return {
    calls: envelope.calls,
    hasMore: envelope.has_more === true,
    nextCursor: typeof envelope.next_cursor === 'string' ? envelope.next_cursor : null,
  };
}
