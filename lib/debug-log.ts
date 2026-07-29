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

    // The client RETURNS errors rather than throwing them, so an insert that is
    // rejected — grants, RLS, a column that moved — would slip past the catch
    // below and log nothing, forever, without a single symptom. That is not
    // hypothetical: it is why the debug log sat empty through an outage while
    // every layer dutifully "logged" the cause.
    const { error } = await createAdminClient()
      .from('debug_log')
      .insert({
        level,
        source: entry.source.slice(0, 120),
        message: String(entry.message).slice(0, 4000),
        context: entry.context ?? {},
        contact_id: entry.contactId ?? null,
      });
    if (error) {
      // Nowhere to write this but the host's log — the database is the thing
      // that just failed. Loud on purpose: a broken debug log makes every other
      // diagnostic in the system silently useless.
      console.error(
        `[debug-log] INSERT FAILED (${error.code ?? 'no code'}): ${error.message}. ` +
          `Dropped entry -> [${level}] ${entry.source}: ${entry.message}`
      );
    }
  } catch (e) {
    // Never let logging break the caller — but never let it vanish either.
    console.error('[debug-log] threw while logging:', e);
  }
}

/** Normalises a thrown value into a message string. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    // JSON.stringify(undefined) returns undefined rather than a string. Keep
    // even falsy thrown values observable to queue and debug-log callers.
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}
