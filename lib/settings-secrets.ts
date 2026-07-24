const SECRET_FIELDS: Record<string, readonly string[]> = {
  brightdata: ['api_key', 'proxy_password'],
  emailit: ['api_key', 'webhook_signing_secret'],
  textlink: ['api_key'],
  stripe: ['secret_key'],
  fluent_forms: ['webhook_secret'],
  callscaler: ['api_key', 'webhook_secret'],
  inbound_email: ['webhook_secret'],
  voicemail: ['api_key'],
  ipapi: ['api_key'],
};

export function maskSettingSecrets(
  key: string,
  value: Record<string, any>
): { value: Record<string, any>; configured: string[] } {
  const secretFields = SECRET_FIELDS[key] ?? [];
  const masked = { ...value };
  const configured: string[] = [];
  for (const field of secretFields) {
    if (typeof masked[field] === 'string' && masked[field].length > 0) configured.push(field);
    delete masked[field];
  }
  return { value: masked, configured };
}

/** Blank/omitted secret fields mean “keep the stored value”; non-empty replaces it. */
export function mergeSettingSecrets(
  key: string,
  current: Record<string, any>,
  incoming: Record<string, any>
): Record<string, any> {
  const merged = { ...current, ...incoming };
  for (const field of SECRET_FIELDS[key] ?? []) {
    if (typeof incoming[field] !== 'string' || incoming[field].length === 0) {
      if (field in current) merged[field] = current[field];
      else delete merged[field];
    }
  }
  return merged;
}
