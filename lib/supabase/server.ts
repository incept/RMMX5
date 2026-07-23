import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

// Server-side env reads are live (never inlined into the public bundle), so
// fallback chains are safe here. Preferred names first — the hosting panel
// only applies newly CREATED variables to builds, so each poisoned name got
// retired rather than edited (see lib/supabase/client.ts).
const url = () => process.env.NEXT_PUBLIC_SB_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = () =>
  process.env.NEXT_PUBLIC_SB_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SB_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = () =>
  process.env.SB_SECRET_KEY ??
  process.env.SB_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY!;

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 * Reads/writes the auth session via cookies. Respects RLS as the logged-in user.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    url(),
    anonKey(),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component during render — safe to ignore
            // because the proxy refreshes the session on every request.
          }
        },
      },
    }
  );
}

/**
 * Admin client using the SERVICE ROLE key. Bypasses RLS entirely.
 * NEVER import this into a Client Component or expose it to the browser.
 * Only use inside Route Handlers after verifying the caller, or inside the
 * signed cron/webhook endpoints.
 */
export function createAdminClient() {
  return createSupabaseClient(url(), serviceKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
