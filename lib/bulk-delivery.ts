export const MAX_BULK_RECIPIENTS = 100;

export function validIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{16,200}$/.test(value);
}

export function deliveryKey(kind: 'email' | 'sms' | 'voicemail', requestKey: string, contactId: string) {
  return `${kind}:${requestKey}:${contactId}`;
}
