// Pure SMS length/segment estimation for the one-off SMS composer, kept free of
// app imports so it is unit-testable without a DOM. The result is an ESTIMATE —
// the carrier is authoritative — but it matches how a segment count is normally
// shown to a sender, so a long or emoji-laden text visibly costs more.

// GSM 03.38 basic alphabet: text using only these characters sends as GSM-7
// (160 chars per single segment, 153 when concatenated). Anything outside it
// forces the whole message to UCS-2 (70 per segment, 67 concatenated).
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Extension-table characters are legal GSM-7 but occupy TWO septets each.
const GSM_EXTENSION = '^{}\\[~]|€';
const GSM_CHARS = new Set([...GSM_BASIC, ...GSM_EXTENSION]);

export type SmsEncoding = 'GSM' | 'UCS2';

export interface SmsSegmentInfo {
  chars: number;
  segments: number;
  encoding: SmsEncoding;
}

/**
 * Character count, segment count, and encoding for a message body. `chars` is
 * the human-visible count (code points, so one emoji counts once); `segments`
 * reflects the real per-segment limits of the chosen encoding.
 */
export function smsSegmentInfo(text: string | null | undefined): SmsSegmentInfo {
  const value = String(text ?? '');
  const codePoints = [...value];
  const isGsm = codePoints.every((c) => GSM_CHARS.has(c));
  // GSM counts septets (extension chars = 2); UCS-2 counts UTF-16 code units,
  // so a non-BMP emoji correctly costs two toward the limit.
  const units = isGsm
    ? codePoints.reduce((n, c) => n + (GSM_EXTENSION.includes(c) ? 2 : 1), 0)
    : value.length;
  const single = isGsm ? 160 : 70;
  const multi = isGsm ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  return { chars: codePoints.length, segments, encoding: isGsm ? 'GSM' : 'UCS2' };
}
