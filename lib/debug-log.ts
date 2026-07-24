import { createAdminClient } from '@/lib/supabase/server';

export type DebugLevel = 'error' | 'warn' | 'info';

/**
 * Records a failure (or notable event) to the debug_log table and the server
 * console. Admin → Debug Log renders these.
 *
 * Fire-and-forget by contract: logging must never throw and never change the
 * outcome of the operation being logged, so every failure here is swallowed.
 * Keep `context` free of secrets — admins can read it, but it is still stored.
 */
export async function logDebug(entry: {
  level?: DebugLevel;
  source: string;
  message: string;
  context?: Record<string, any>;
  contactId?: string | null;
}): Promise<void> {
  const level = entry.level ?? 'error';
  try {
    // Console first, so it still lands in the host's logs if the insert fails.
    const line = `[${level}] ${entry.source}: ${entry.message}`;
    if (level === 'error') console.error(line, entry.context ?? '');
    else if (level === 'warn') console.warn(line, entry.context ?? '');
    else console.info(line, entry.context ?? '');

    await createAdminClient()
      .from('debug_log')
      .insert({
        level,
        source: entry.source.slice(0, 120),
        message: String(entry.message).slice(0, 4000),
        context: entry.context ?? {},
        contact_id: entry.contactId ?? null,
      });
  } catch {
    // Never let logging break the caller.
  }
}

/** Normalises a thrown value into a message string. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
