import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

/**
 * Supabase client for Server Components, Server Actions, and Route Handlers.
 * Reads/writes the auth session via cookies. Respects RLS as the logged-in user.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
