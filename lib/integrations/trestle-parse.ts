/**
 * Pure parsing for Trestle responses. No imports on purpose: this is the part
 * worth testing directly against real payloads, and a module that reaches for
 * settings or a database cannot be loaded by the test runner.
 */

export interface PhoneIdentity {
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  city: string | null;
  /** Two-letter code, e.g. "NC". */
  state: string | null;
  postalCode: string | null;
  lineType: string | null;
  isValid: boolean;
}

/** Digits only, then E.164 for the US. Trestle wants a well-formed number. */
export function toE164(raw: string): string | null {
  const digits = (raw ?? '').replace(/\D+/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // Anything else is either already international or not dialable; pass it
  // through only if it looks plausible rather than guessing at a country.
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

function pickString(...values: any[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Reads the identity out of a Trestle response.
 *
 * Deliberately tolerant. The exact envelope varies by API version and plan, and
 * a field rename should degrade to "no result" rather than throw inside a queue
 * worker — so every access is optional and the shape is never assumed.
 */
export function parsePhoneIdentity(data: any): PhoneIdentity {
  const owner = Array.isArray(data?.owners) ? data.owners[0] : (data?.owner ?? null);
  const addresses = Array.isArray(owner?.addresses)
    ? owner.addresses
    : Array.isArray(data?.addresses)
      ? data.addresses
      : [];
  // First address carrying both parts. A partial address is worse than none: a
  // city without its state cannot narrow a search and can mislead one.
  const address =
    addresses.find((a: any) => pickString(a?.city) && pickString(a?.state_code, a?.state)) ?? null;

  const firstName = pickString(owner?.firstname, owner?.first_name);
  const lastName = pickString(owner?.lastname, owner?.last_name);
  const name =
    pickString(owner?.name) ?? pickString([firstName, lastName].filter(Boolean).join(' '));

  const state = pickString(address?.state_code, address?.state);
  return {
    name,
    firstName,
    lastName,
    city: pickString(address?.city),
    state: state ? state.toUpperCase().slice(0, 2) : null,
    postalCode: pickString(address?.postal_code, address?.zip),
    lineType: pickString(data?.line_type, data?.lineType),
    isValid: data?.is_valid !== false,
  };
}
