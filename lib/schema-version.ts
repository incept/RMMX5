import type { createAdminClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createAdminClient>;
export const REQUIRED_SCHEMA_VERSION = 54;

export async function checkSchemaVersion(
  admin: Admin
): Promise<{ ok: boolean; expected: number; actual: number | null; error?: string }> {
  const { data, error } = await admin
    .from('app_schema_state')
    .select('version')
    .eq('singleton', true)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      expected: REQUIRED_SCHEMA_VERSION,
      actual: null,
      error: error.message,
    };
  }
  const actual = data?.version == null ? null : Number(data.version);
  return {
    ok: actual != null && actual >= REQUIRED_SCHEMA_VERSION,
    expected: REQUIRED_SCHEMA_VERSION,
    actual,
    ...(actual == null || actual < REQUIRED_SCHEMA_VERSION
      ? { error: `Database schema ${actual ?? 'unknown'} is behind required ${REQUIRED_SCHEMA_VERSION}` }
      : {}),
  };
}
