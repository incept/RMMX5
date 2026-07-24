export interface CallScalerPage {
  calls: any[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Accepts both the documented nested envelope and legacy flat responses. */
export function parseCallScalerPage(data: any): CallScalerPage {
  const envelope = data?.data ?? data;
  if (Array.isArray(envelope)) {
    return { calls: envelope, hasMore: false, nextCursor: null };
  }
  if (!envelope || !Array.isArray(envelope.calls)) {
    throw new Error('CallScaler Calls API response did not contain a calls array');
  }
  const pagination = envelope.pagination ?? envelope;
  return {
    calls: envelope.calls,
    hasMore: pagination.has_more === true,
    nextCursor: typeof pagination.next_cursor === 'string' ? pagination.next_cursor : null,
  };
}
